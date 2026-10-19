"""Light judging on the built-in model jobs: labelled model output, never ground truth."""

import json

import pytest
from sqlalchemy import select

from oracle.jobs import prompting, worker
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.llm.transports import LlmRequest, TransportResult
from oracle.quality import criteria
from oracle.quality.judge import DISCLAIMER
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.claude_account_helpers import add_account, window
from tests.quality_corpus import load_case, seed_case


class FakeJudge:
    """Answers the quality_review prompt with a scripted answer (dict or str)."""

    def __init__(self):
        self.answers: list = []
        self.payloads: list[dict] = []

    async def complete(self, token: str, request: LlmRequest) -> TransportResult:
        assert request.system == prompting.current("quality_review")[1]
        payload = json.loads(request.messages[0]["content"])
        self.payloads.append(payload)
        answer = self.answers.pop(0) if self.answers else {}
        text = answer if isinstance(answer, str) else "```json\n" + json.dumps(answer) + "\n```"
        return TransportResult(
            text=text, model=request.model, usage={"input_tokens": 900, "output_tokens": 200}
        )


@pytest.fixture
def judge():
    fake = FakeJudge()
    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    yield fake
    gateway.set_transports(previous)


@pytest.fixture
async def ctx():
    ctx = await make_ctx()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    return ctx


def V(slug: str, n: int, path: str = "") -> str:
    return f"/v1/documents/{slug}/versions/{n}{path}"


async def test_an_approver_queues_a_model_review_that_is_labelled_model_output(client, ctx, judge):
    case = load_case("good-prd")
    seeded = await seed_case(client, ctx, case)
    url = V(seeded.slug, 1, "/quality-review")
    assert (await client.post(url, headers=ctx.as_("commenter"))).status_code == 403
    resp = await client.post(url, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    job = resp.json()
    assert job["kind"] == "quality_review" and job["status"] == "queued"

    judge.answers.append(case["model_output"])
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.succeeded == 1, tick.errors

    # The model saw the sections and the criteria, not the rules' verdicts.
    (payload,) = judge.payloads
    assert [c["key"] for c in payload["criteria"]] == list(criteria.KEYS)
    assert {s["section_key"] for s in payload["sections"]} >= {"problem", "metrics"}
    assert "rules" not in payload and "status" not in json.dumps(payload["criteria"])

    async with tenant_session(ctx.tenant_id) as s:
        stored = (await s.scalars(select(LlmJob))).one()
        assert stored.status == "succeeded" and stored.input["prompt"] == "quality_review.v1"
        report = (await s.scalars(select(m.EvaluationReport))).one()
        assert report.evaluator == "llm_job" and report.policy == "advisory"
        assert report.summary["label"] == "model_output"
        assert report.summary["disclaimer"] == DISCLAIMER
        findings = list(
            await s.scalars(
                select(m.EvaluationFinding).where(m.EvaluationFinding.report_id == report.id)
            )
        )
    # The unknown key is dropped; nothing from a model is ever hard.
    assert sorted(f.criterion for f in findings) == ["problem_clarity", "validation_plan"]
    assert all(f.hard is False for f in findings)

    dash = (await client.get(V(seeded.slug, 1, "/readiness"), headers=ctx.as_("viewer"))).json()
    assert dash["model_review"]["label"] == "model_output"
    assert "not independent ground truth" in dash["model_review"]["disclaimer"]
    items = {i["key"]: i for i in dash["items"]}
    # The rules keep the status; the model's view is shown beside it.
    assert items["validation_plan"]["status"] == "pass"
    assert items["validation_plan"]["model"]["status"] == "warning"
    assert items["validation_plan"]["agreement"]["model"] is False
    assert items["problem_clarity"]["agreement"]["model"] is True
    assert dash["blocked"] is False


async def test_a_model_saying_critical_never_blocks(client, ctx, judge):
    seeded = await seed_case(client, ctx, load_case("good-prd"))
    await client.post(V(seeded.slug, 1, "/quality-review"), headers=ctx.as_("approver"))
    judge.answers.append(
        {"criteria": [{"key": k, "status": "critical", "rationale": "x"} for k in criteria.KEYS]}
    )
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    dash = (await client.get(V(seeded.slug, 1, "/readiness"), headers=ctx.as_("viewer"))).json()
    assert dash["blocked"] is False
    assert all(i["model"]["status"] == "critical" for i in dash["items"] if i["model"])


async def test_an_answer_with_no_usable_criterion_is_retried_then_fails(client, ctx, judge):
    seeded = await seed_case(client, ctx, load_case("good-prd"))
    await client.post(V(seeded.slug, 1, "/quality-review"), headers=ctx.as_("approver"))
    judge.answers += [{"criteria": [{"key": "x", "status": "green"}]}, "not json at all"]
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.failed == 1 and tick.retried == 1
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(m.EvaluationReport))).all() == []


async def test_quality_review_can_be_turned_off_per_document(client, ctx, judge):
    seeded = await seed_case(client, ctx, load_case("good-prd"))
    settings = f"/v1/documents/{seeded.slug}/llm-jobs/settings"
    current = (await client.get(settings, headers=ctx.as_("viewer"))).json()
    assert current["quality_review"] is True
    resp = await client.put(
        settings, json={**current, "quality_review": False}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200
    resp = await client.post(V(seeded.slug, 1, "/quality-review"), headers=ctx.as_("approver"))
    assert resp.status_code == 409 and "turned off" in resp.json()["detail"]
