"""Built-in model jobs: review comments, reporting and refinement on a fake transport."""

import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity, Evidence
from oracle.claude_accounts.accounts import AccountState
from oracle.docs.models import DocumentVersion, Section
from oracle.jobs import prompting, worker
from oracle.jobs.models import LlmJob, LlmSuggestion
from oracle.llm import LlmUnavailable, gateway
from oracle.llm.transports import LlmRequest, TransportResult
from oracle.models import AuditEvent
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import add_account, window
from tests.test_members import token_with_role

SLUG = "onboarding-revamp"
DRAFT_V1 = """---
document: onboarding-revamp
title: Onboarding revamp PRD
citations:
  - id: c1
    source: web
    ref: https://example.com/funnel
    title: Funnel analysis
---

# Onboarding revamp PRD {#title}

Owner: product.

## Goal trace {#goal-trace}

Serves the activation goal: more new teams reach their first report [c:c1].

## Problem {#problem}

Half of new teams never invite a teammate.

## Proposed solution {#solution}

A guided checklist on the first screen.

## Sources and data points {#sources}

- Funnel analysis, as of October.
"""
ANCHOR = {"exact": "guided checklist", "prefix": "A ", "suffix": " on"}


class FakeClaude:
    """Answers each job kind from a script: a dict, a callable(payload) or an exception."""

    def __init__(self):
        self.script: dict[str, list] = {k: [] for k in prompting.CURRENT}
        self.calls: list[tuple[str, dict]] = []
        self.on_call = None

    @staticmethod
    def kind_of(request: LlmRequest) -> str:
        for kind in prompting.CURRENT:
            if request.system == prompting.current(kind)[1]:
                return kind
        raise AssertionError("unknown prompt")

    async def complete(self, token: str, request: LlmRequest) -> TransportResult:
        kind = self.kind_of(request)
        payload = json.loads(request.messages[0]["content"])
        self.calls.append((kind, payload))
        if self.on_call:
            await self.on_call(kind, payload)
        answer = self.script[kind].pop(0) if self.script[kind] else {}
        if isinstance(answer, Exception):
            raise answer
        if callable(answer):
            answer = answer(payload)
        text = answer if isinstance(answer, str) else "```json\n" + json.dumps(answer) + "\n```"
        return TransportResult(
            text=text,
            model=request.model,
            usage={"input_tokens": 1200, "output_tokens": 300, "total_cost_usd": 0.0421},
        )


@pytest.fixture
def fake():
    claude = FakeClaude()
    previous = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
    yield claude
    gateway.set_transports(previous)


@pytest.fixture
async def ctx():
    r = await seed(token_name="test")
    return {"tenant_id": r.tenant_id, "headers": {"Authorization": f"Bearer {r.token}"}}


@pytest.fixture
async def pool(ctx):
    return await add_account(ctx["tenant_id"], "personal", windows={"five_hour": window(0.2)})


def V(n: int, path: str = "") -> str:
    return f"/v1/documents/{SLUG}/versions/{n}{path}"


async def import_draft(client, ctx, markdown: str = DRAFT_V1) -> dict:
    resp = await client.post(
        f"/v1/documents/{SLUG}/versions",
        content=markdown.encode(),
        headers={**ctx["headers"], "Content-Type": "text/markdown"},
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


async def comment(client, ctx, key: str, body: str, n: int = 1) -> str:
    resp = await client.post(
        V(n, "/comments"),
        json={"section_key": key, "anchor": ANCHOR, "body": body},
        headers=ctx["headers"],
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["feedback_item_id"]


async def verdict(client, ctx, key: str, v: str, note: str | None = None, n: int = 1):
    resp = await client.put(
        V(n, f"/sections/{key}/review"), json={"verdict": v, "note": note}, headers=ctx["headers"]
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def tick(client, ctx) -> dict:
    resp = await client.post("/v1/internal/tick", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    return resp.json()["llm_jobs"]


async def jobs(client, ctx) -> list[dict]:
    resp = await client.get(f"/v1/documents/{SLUG}/llm-jobs", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    return resp.json()


async def feedback(client, ctx) -> dict[str, dict]:
    resp = await client.get(f"/v1/documents/{SLUG}/feedback", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    return {f["id"]: f for f in resp.json()}


async def actions(tenant_id) -> list[tuple[str, dict]]:
    async with tenant_session(tenant_id) as s:
        rows = await s.execute(
            select(AuditEvent.action, AuditEvent.data).order_by(AuditEvent.created_at)
        )
        return [(a, d) for a, d in rows]


def review_answer(items: list[dict]):
    return {"items": items}


# --- review comments ---------------------------------------------------------------------


async def test_feedback_queues_one_job_that_classifies_groups_and_suggests(client, ctx, pool, fake):
    await import_draft(client, ctx)
    a = await comment(client, ctx, "solution", "Make the checklist skippable.")
    b = await comment(client, ctx, "solution", "Users must be able to skip the checklist.")
    q = await comment(client, ctx, "problem", "Where does the half figure come from?")
    await verdict(client, ctx, "goal-trace", "changes_requested", "Name the goal's metric.")
    ok = await comment(client, ctx, "title", "Looks good to me.")
    queued = await jobs(client, ctx)
    # Every new item lands on the one queued job.
    assert [(j["kind"], j["status"], j["version_number"]) for j in queued] == [
        ("review_comments", "queued", 1)
    ]

    fb = await feedback(client, ctx)
    g = next(i for i, f in fb.items() if f["kind"] == "section_review")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": a,
                    "classification": "change_request",
                    "group": "skip checklist",
                    "duplicate_of": None,
                    "suggestion": {
                        "kind": "section_text",
                        "section_key": "solution",
                        "text": "A guided checklist [c:c1] that new teams can [skip](https://x.example).",
                        "rationale": "Two reviewers ask for it.",
                    },
                },
                {
                    "feedback_id": b,
                    "classification": "change_request",
                    "group": "skip checklist",
                    "duplicate_of": a,
                    "suggestion": {"kind": "section_text", "text": "dup"},
                },
                {
                    "feedback_id": q,
                    "classification": "question",
                    "group": "source of figure",
                    "suggestion": {"kind": "answer", "text": "From the funnel analysis."},
                },
                {
                    "feedback_id": g,
                    "classification": "change_request",
                    "suggestion": {
                        "kind": "section_text",
                        "section_key": "goal-trace",
                        "text": "Serves activation: teams reaching a first report in week one.",
                    },
                },
                {"feedback_id": ok, "classification": "approval", "suggestion": {"kind": "none"}},
                {"feedback_id": str(uuid.uuid4()), "classification": "question"},
            ]
        )
    )
    summary = await tick(client, ctx)
    assert summary == {"ran": 1, "succeeded": 1, "failed": 0, "retried": 0, "errors": []}

    [job] = await jobs(client, ctx)
    assert job["status"] == "succeeded"
    assert job["account_label"] == "personal" and job["via"] == "account"
    assert (job["input_tokens"], job["output_tokens"], job["cost_usd"]) == (1200, 300, 0.0421)
    assert job["input"]["prompt"] == "review_comments.v1"
    assert job["output"]["handled"] == 5
    assert job["output"]["classifications"] == {
        "change_request": 3,
        "question": 1,
        "approval": 1,
    }
    assert job["output"]["duplicates"] == 1

    # The model saw the sections (with locks) and every item.
    kind, payload = fake.calls[0]
    assert {f["feedback_id"] for f in payload["feedback"]} == {a, b, q, g, ok}

    fb = await feedback(client, ctx)
    sa, sb, sq = fb[a]["suggestion"], fb[b]["suggestion"], fb[q]["suggestion"]
    assert sa["kind"] == "section_text" and sa["group_key"] == "skip checklist"
    # O1c: no citation markers or links in proposed section text.
    assert sa["text"] == "A guided checklist that new teams can skip."
    assert sb["kind"] == "duplicate" and sb["duplicate_of"] == a and sb["text"] is None
    assert sq["kind"] == "answer" and sq["classification"] == "question"
    assert fb[ok]["suggestion"]["kind"] == "none"
    # Nothing changed the document.
    versions = (await client.get(f"/v1/documents/{SLUG}/versions", headers=ctx["headers"])).json()
    assert len(versions) == 1

    # A second tick with nothing new makes no call.
    assert (await tick(client, ctx))["ran"] == 0
    assert len(fake.calls) == 1


async def test_accepting_an_answer_replies_and_closes_the_item(client, ctx, pool, fake):
    await import_draft(client, ctx)
    q = await comment(client, ctx, "problem", "Where does the half figure come from?")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": q,
                    "classification": "question",
                    "suggestion": {"kind": "answer", "text": "From the funnel analysis."},
                }
            ]
        )
    )
    await tick(client, ctx)
    sid = (await feedback(client, ctx))[q]["suggestion"]["id"]
    resp = await client.patch(
        f"/v1/suggestions/{sid}", json={"text": "From the October funnel."}, headers=ctx["headers"]
    )
    assert resp.status_code == 200 and resp.json()["edited_text"] == "From the October funnel."
    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
    assert resp.status_code == 200 and resp.json()["status"] == "accepted"
    item = (await feedback(client, ctx))[q]
    assert item["status"] == "addressed"
    assert item["resolution_note"] == "Answered: From the October funnel."
    comments = (await client.get(V(1, "/comments"), headers=ctx["headers"])).json()
    assert comments[0]["replies"][0]["body"] == "From the October funnel."
    # Decided once.
    again = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
    assert again.status_code == 409


async def _baseline(tenant_id):
    async with tenant_session(tenant_id) as s:
        goal = Entity(
            type="goal",
            key="activation",
            title="Activation",
            body="More new teams reach their first report in week one.",
            attrs={"metric": "first report in 7 days", "target": "45%"},
            status="confirmed",
            origin="user",
        )
        feature = Entity(
            type="feature", key="checklist", title="Checklist", status="confirmed", origin="user"
        )
        s.add_all([goal, feature])
        await s.flush()
        s.add_all(
            [
                Evidence(
                    entity_id=feature.id,
                    excerpt="Teams that finish the checklist activate twice as often.",
                    ref="Activation study",
                    url="https://example.com/study",
                    confidence=Decimal("0.85"),
                ),
                Evidence(
                    entity_id=feature.id,
                    excerpt="Someone said in chat that nobody likes checklists.",
                    confidence=Decimal("0.3"),
                ),
            ]
        )
        await s.commit()


async def test_pushback_needs_reasoning_and_sources_and_is_raised_once(client, ctx, pool, fake):
    await _baseline(ctx["tenant_id"])
    await import_draft(client, ctx)
    drop = await comment(client, ctx, "solution", "Remove the checklist entirely.")
    taste = await comment(client, ctx, "solution", "Call it a tour, not a checklist.")
    push = {
        "reason": "The checklist is the strongest activation lever we have evidence for.",
        "sources": ["goal:activation", "ev:1", "ev:99"],
    }
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": drop,
                    "classification": "change_request",
                    "suggestion": {"kind": "section_text", "text": "No checklist."},
                    "pushback": push,
                },
                {
                    "feedback_id": taste,
                    "classification": "change_request",
                    "suggestion": {"kind": "section_text", "text": "A guided tour."},
                    # No source the model was given: no pushback.
                    "pushback": {"reason": "I prefer checklist.", "sources": ["ev:42"]},
                },
            ]
        )
    )
    await tick(client, ctx)
    _, payload = fake.calls[0]
    # Only confirmed goals and high-confidence evidence are offered.
    assert [g["ref"] for g in payload["goals"]] == ["goal:activation"]
    assert [(e["ref"], e["confidence"]) for e in payload["evidence"]] == [("ev:1", 0.85)]

    fb = await feedback(client, ctx)
    pb = fb[drop]["suggestion"]["pushback"]
    assert pb["reason"].startswith("The checklist is the strongest")
    assert [(x["ref"], x["kind"]) for x in pb["sources"]] == [
        ("goal:activation", "goal"),
        ("ev:1", "evidence"),
    ]
    assert pb["sources"][1]["url"] == "https://example.com/study"
    assert fb[taste]["suggestion"]["pushback"] is None

    # The human decides: keeping their call needs a reason, which is logged.
    sid = fb[drop]["suggestion"]["id"]
    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
    assert resp.status_code == 422
    resp = await client.post(
        f"/v1/suggestions/{sid}/accept",
        json={"reason": "Support load from the checklist is too high."},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200
    assert resp.json()["override_reason"] == "Support load from the checklist is too high."
    logged = [d for a, d in await actions(ctx["tenant_id"]) if a == "suggestion.override"]
    assert logged == [
        {
            "reason": "Support load from the checklist is too high.",
            "pushback": push["reason"],
        }
    ]

    # Once: when the item is handled again (its suggestion superseded), no second pushback.
    async with tenant_session(ctx["tenant_id"]) as s:
        row = await s.get(LlmSuggestion, uuid.UUID(sid))
        row.status = "superseded"
        await s.commit()
    resp = await client.post(
        f"/v1/documents/{SLUG}/llm-jobs", json={"kind": "review_comments"}, headers=ctx["headers"]
    )
    assert resp.status_code == 201
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": drop,
                    "classification": "change_request",
                    "suggestion": {"kind": "section_text", "text": "No checklist."},
                    "pushback": push,
                }
            ]
        )
    )
    await tick(client, ctx)
    _, payload = fake.calls[1]
    assert payload["no_pushback"] == [drop]
    assert (await feedback(client, ctx))[drop]["suggestion"]["pushback"] is None


async def test_dismissing_with_decline_takes_the_advice(client, ctx, pool, fake):
    await import_draft(client, ctx)
    drop = await comment(client, ctx, "solution", "Remove the checklist entirely.")
    fake.script["review_comments"].append(
        review_answer([{"feedback_id": drop, "classification": "change_request"}])
    )
    await tick(client, ctx)
    sid = (await feedback(client, ctx))[drop]["suggestion"]["id"]
    resp = await client.post(
        f"/v1/suggestions/{sid}/dismiss",
        json={"reason": "Keeping the checklist.", "decline": True},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200 and resp.json()["status"] == "dismissed"
    item = (await feedback(client, ctx))[drop]
    assert (item["status"], item["resolution_note"]) == ("declined", "Keeping the checklist.")


# --- locked sections and refinement ------------------------------------------------------


async def test_locked_sections_get_no_text_and_cannot_be_refined(client, ctx, pool, fake):
    await import_draft(client, ctx)
    await verdict(client, ctx, "problem", "approved")
    f = await comment(client, ctx, "problem", "Say 'most', not 'half'.")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": f,
                    "classification": "change_request",
                    "suggestion": {
                        "kind": "section_text",
                        "section_key": "problem",
                        "text": "Most new teams never invite a teammate.",
                    },
                }
            ]
        )
    )
    await tick(client, ctx)
    _, payload = fake.calls[0]
    assert {s["section_key"]: s["locked"] for s in payload["sections"]}["problem"] is True
    s = (await feedback(client, ctx))[f]["suggestion"]
    assert (s["kind"], s["text"]) == ("none", None)
    assert "locked" in s["rationale"]

    resp = await client.post(
        V(1, "/sections/problem/refine"), json={"instruction": "Shorter."}, headers=ctx["headers"]
    )
    assert resp.status_code == 409 and "locked" in resp.json()["detail"]


def _refined(payload):
    return {
        "heading": "Proposed solution {#renamed}",
        "body_md": (
            "## Checklist\n\nA guided checklist [c:c1] that teams can skip; "
            "see [the study](https://example.com/study). 45% of teams finish it.\n"
        ),
        "data_points": [
            {"value": "45% finish the checklist", "as_of": "October", "source": "Study"}
        ],
        "notes": "Made the checklist skippable.",
        "resolutions": [
            {
                "feedback_id": payload["suggestions"][0]["feedback_id"],
                "status": "addressed",
                "note": "Checklist is skippable.",
            }
        ],
    }


async def _accepted_solution_suggestion(client, ctx, fake) -> tuple[str, str, str]:
    a = await comment(client, ctx, "solution", "Make the checklist skippable.")
    b = await comment(client, ctx, "solution", "Let teams skip the checklist.")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": a,
                    "classification": "change_request",
                    "group": "skip",
                    "suggestion": {
                        "kind": "section_text",
                        "section_key": "solution",
                        "text": "A guided checklist that teams can skip.",
                    },
                },
                {"feedback_id": b, "classification": "change_request", "duplicate_of": a},
            ]
        )
    )
    await tick(client, ctx)
    sid = (await feedback(client, ctx))[a]["suggestion"]["id"]
    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
    assert resp.status_code == 200
    return a, b, sid


async def test_refinement_keeps_ids_and_o1c_and_imports_the_next_version(client, ctx, pool, fake):
    v1 = await import_draft(client, ctx)
    await verdict(client, ctx, "problem", "approved")
    a, b, sid = await _accepted_solution_suggestion(client, ctx, fake)
    # Accepted is not applied: the document has not changed.
    versions = (await client.get(f"/v1/documents/{SLUG}/versions", headers=ctx["headers"])).json()
    assert len(versions) == 1

    resp = await client.post(V(1, "/sections/solution/refine"), json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    job = resp.json()
    assert (job["kind"], job["section_key"], job["input"]["suggestion_ids"]) == (
        "refinement",
        "solution",
        [sid],
    )
    fake.script["refinement"].append(_refined)
    await tick(client, ctx)
    job = (await client.get(f"/v1/llm-jobs/{job['id']}", headers=ctx["headers"])).json()
    assert job["status"] == "succeeded", job
    out = job["output"]
    assert out["heading"] == "Proposed solution"
    assert out["body_md"] == (
        "#### Checklist\n\nA guided checklist that teams can skip; see the study. "
        "45% of teams finish it."
    )
    assert set(out["o1c_fixes"]) == {"citation_markers", "links", "headings"}
    assert prompting.body_problems(out["body_md"]) == []

    preview = (await client.get(f"/v1/llm-jobs/{job['id']}/preview", headers=ctx["headers"])).json()
    assert preview["section_key"] == "solution"
    assert any(w["op"] == "insert" and "skip" in w["text"] for w in preview["words"])

    resp = await client.post(f"/v1/llm-jobs/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    v2 = resp.json()
    assert v2["number"] == 2
    # Section ids and order kept; the approved section is byte-for-byte the same.
    assert [s["section_key"] for s in v2["sections"]] == [s["section_key"] for s in v1["sections"]]
    before = {s["section_key"]: s for s in v1["sections"]}
    after = {s["section_key"]: s for s in v2["sections"]}
    assert after["problem"]["content_hash"] == before["problem"]["content_hash"]
    assert after["goal-trace"]["content_hash"] == before["goal-trace"]["content_hash"]
    assert v2["warnings"] == []
    assert "[c:" not in after["solution"]["body_md"]
    assert "can skip" in after["solution"]["body_md"]
    # O1c: the data point went to Sources and data points, not the body.
    assert "45% finish the checklist (as of October; Study)" in after["sources"]["body_md"]

    # Resolutions recorded: the item and its duplicate are addressed in v2.
    fb = await feedback(client, ctx)
    assert (fb[a]["status"], fb[a]["addressed_in_version"]) == ("addressed", 2)
    assert fb[a]["resolution_note"] == "Checklist is skippable."
    assert (fb[b]["status"], fb[b]["addressed_in_version"]) == ("addressed", 2)
    assert fb[a]["suggestion"]["status"] == "applied"
    assert fb[a]["suggestion"]["applied_in_version"] == 2
    md = (await client.get(V(2, "/markdown"), headers=ctx["headers"])).text
    assert f"feedback_id: {a}" in md

    # Accepted once; and v2 queued its reports.
    again = await client.post(f"/v1/llm-jobs/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert again.status_code == 409
    kinds = [(j["kind"], j["status"], j["version_number"]) for j in await jobs(client, ctx)]
    assert ("reporting", "queued", 2) in kinds


async def test_an_approver_instruction_refines_and_their_edit_wins(client, ctx, pool, fake):
    await import_draft(client, ctx)
    resp = await client.post(
        V(1, "/sections/problem/refine"),
        json={"instruction": "Say what it costs us."},
        headers=ctx["headers"],
    )
    assert resp.status_code == 201
    job_id = resp.json()["id"]
    fake.script["refinement"].append(
        {"heading": "Problem", "body_md": "Half of new teams never invite anyone.", "notes": "x"}
    )
    await tick(client, ctx)
    assert fake.calls[0][1]["instruction"] == "Say what it costs us."
    resp = await client.post(
        f"/v1/llm-jobs/{job_id}/apply",
        json={"body_md": "Half of new teams never invite a teammate [c:c1], so they churn."},
        headers=ctx["headers"],
    )
    assert resp.status_code == 201
    problem = next(s for s in resp.json()["sections"] if s["section_key"] == "problem")
    assert problem["body_md"] == "Half of new teams never invite a teammate, so they churn."


async def test_a_refinement_of_an_outdated_version_is_refused(client, ctx, pool, fake):
    await import_draft(client, ctx)
    resp = await client.post(
        V(1, "/sections/problem/refine"), json={"instruction": "Shorter."}, headers=ctx["headers"]
    )
    job_id = resp.json()["id"]
    fake.script["refinement"].append({"heading": "Problem", "body_md": "Few teams invite."})
    await tick(client, ctx)
    await import_draft(client, ctx, DRAFT_V1.replace("Owner: product.", "Owner: growth."))
    resp = await client.post(f"/v1/llm-jobs/{job_id}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 409 and "newer version" in resp.json()["detail"]
    resp = await client.post(
        V(1, "/sections/problem/refine"), json={"instruction": "x"}, headers=ctx["headers"]
    )
    assert resp.status_code == 409


async def test_refine_needs_an_accepted_suggestion_or_an_instruction(client, ctx, pool, fake):
    await import_draft(client, ctx)
    resp = await client.post(V(1, "/sections/problem/refine"), json={}, headers=ctx["headers"])
    assert resp.status_code == 422
    resp = await client.post(
        V(1, "/sections/nope/refine"), json={"instruction": "x"}, headers=ctx["headers"]
    )
    assert resp.status_code == 404


async def _refined_problem_job(client, ctx, fake, body_md: str) -> str:
    await import_draft(client, ctx)
    resp = await client.post(
        V(1, "/sections/problem/refine"), json={"instruction": "Show it."}, headers=ctx["headers"]
    )
    assert resp.status_code == 201, resp.text
    fake.script["refinement"].append({"heading": "Problem", "body_md": body_md})
    await tick(client, ctx)
    return resp.json()["id"]


@pytest.mark.parametrize(
    "body_md",
    ["Teams stall.\n\n```text\nstalled\n   ", "Teams stall.\n\n```text\nstalled\n\n\n"],
)
async def test_a_refinement_with_an_open_fence_keeps_every_section(
    client, ctx, pool, fake, body_md
):
    """An open fence whose body ends in whitespace-only or blank lines is closed before
    the next section, so the refinement cannot swallow it (round 3, MAJOR 2)."""
    job_id = await _refined_problem_job(client, ctx, fake, body_md)
    resp = await client.post(f"/v1/llm-jobs/{job_id}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    keys = [s["section_key"] for s in resp.json()["sections"]]
    assert keys == ["title", "goal-trace", "problem", "solution", "sources"]


async def test_a_refinement_that_would_lose_a_section_is_refused(
    client, ctx, pool, fake, monkeypatch
):
    from oracle.jobs import service as jobs_service

    job_id = await _refined_problem_job(client, ctx, fake, "Teams stall.")
    real = jobs_service.compose_markdown

    def leaky(front_matter, sections, replace, resolutions):
        out = real(front_matter, sections, replace, resolutions)
        return out.replace("## Proposed solution {#solution}\n", "")

    monkeypatch.setattr(jobs_service, "compose_markdown", leaky)
    resp = await client.post(f"/v1/llm-jobs/{job_id}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 422, resp.text
    assert "solution" in resp.json()["detail"]
    async with tenant_session(ctx["tenant_id"]) as s:
        assert len((await s.scalars(select(DocumentVersion))).all()) == 1


async def test_a_refinement_that_would_add_a_section_is_refused(
    client, ctx, pool, fake, monkeypatch
):
    """The last check before import compared only the expected keys, so a draft with an
    extra section after the last one passed (round 4). A heading in a refined body is
    already demoted; this is the check behind it. Refused, nothing imported."""
    from oracle.jobs import service as jobs_service

    job_id = await _refined_problem_job(client, ctx, fake, "Teams stall.")
    real = jobs_service.compose_markdown

    def extra(front_matter, sections, replace, resolutions):
        out = real(front_matter, sections, replace, resolutions)
        return out + "\n## Appendix {#appendix}\n\nAdded.\n"

    monkeypatch.setattr(jobs_service, "compose_markdown", extra)
    resp = await client.post(f"/v1/llm-jobs/{job_id}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 422, resp.text
    assert "appendix" in resp.json()["detail"]
    async with tenant_session(ctx["tenant_id"]) as s:
        assert len((await s.scalars(select(DocumentVersion))).all()) == 1


async def test_a_heading_in_a_refined_last_section_stays_in_it(client, ctx, pool, fake):
    await import_draft(client, ctx)
    resp = await client.post(
        V(1, "/sections/sources/refine"), json={"instruction": "More."}, headers=ctx["headers"]
    )
    assert resp.status_code == 201, resp.text
    body = "Notes.\n\n## Appendix {#appendix}\n\nExtra."
    fake.script["refinement"].append({"heading": "Sources", "body_md": body})
    await tick(client, ctx)
    resp = await client.post(
        f"/v1/llm-jobs/{resp.json()['id']}/apply", json={}, headers=ctx["headers"]
    )
    assert resp.status_code == 201, resp.text
    keys = [s["section_key"] for s in resp.json()["sections"]]
    assert keys == ["title", "goal-trace", "problem", "solution", "sources"]


def test_lost_sections_reports_an_added_section():
    from oracle.jobs.service import lost_sections

    md = "# T {#title}\n\n## A {#a}\n\nx\n\n## B {#b}\n\ny\n"
    assert lost_sections(["title", "a", "b"], md) == []
    assert lost_sections(["title", "a"], md) == ["b"]


# --- reporting ---------------------------------------------------------------------------


async def test_reports_explain_resolutions_and_what_changed_with_new_sources(
    client, ctx, pool, fake
):
    await import_draft(client, ctx)
    f = await comment(client, ctx, "problem", "Give the number for invites.")
    async with tenant_session(ctx["tenant_id"]) as s:
        goal = Entity(
            type="goal", key="activation", title="Activation", status="confirmed", origin="user"
        )
        s.add(goal)
        await s.flush()
        s.add(
            Evidence(entity_id=goal.id, ref="Invite funnel, October", excerpt="48% invite nobody")
        )
        await s.commit()
    v2_draft = DRAFT_V1.replace(
        "---\n\n# Onboarding",
        f"resolutions:\n  - feedback_id: {f}\n    status: addressed\n"
        "    note: Number given.\n---\n\n# Onboarding",
    ).replace("Half of new teams", "48% of new teams")
    await import_draft(client, ctx, v2_draft)
    queued = [(j["kind"], j["version_number"]) for j in await jobs(client, ctx)]
    assert ("reporting", 2) in queued

    def answer(payload):
        assert payload["document"]["since"] == 1
        assert [s["section_key"] for s in payload["sections"]] == ["problem"]
        assert payload["new_sources"][0]["title"] == "Invite funnel, October"
        return {
            "resolution_summary": "The one open question was answered with a number.",
            "items": [{"feedback_id": f, "explanation": "The problem now says 48%."}],
            "changes_summary": "The problem is sharper and backed by the invite funnel.",
            "sections": [{"section_key": "problem", "summary": "Now states 48%."}],
        }

    fake.script["review_comments"].append(review_answer([]))
    fake.script["reporting"].append(answer)
    await tick(client, ctx)
    reports = (await client.get(V(2, "/reports"), headers=ctx["headers"])).json()
    assert reports["latest_job"]["status"] == "succeeded"
    r = reports["resolution"]
    assert r["summary"] == "The one open question was answered with a number."
    assert r["counts"] == {"addressed": 1}
    assert r["items"][0]["explanation"] == "The problem now says 48%."
    assert r["items"][0]["resolution_note"] == "Number given."
    c = reports["changes"]
    assert c["since"] == 1
    assert c["sections"] == [
        {
            "section_key": "problem",
            "status": "changed",
            "heading": "Problem",
            "summary": "Now states 48%.",
        }
    ]
    assert [x["title"] for x in c["new_sources"]] == ["Invite funnel, October"]

    md = await client.get(V(2, "/reports/export"), headers=ctx["headers"])
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/markdown")
    assert "How feedback was handled" in md.text and "What changed since version 1" in md.text
    assert "Invite funnel, October (on Activation)" in md.text
    html = await client.get(
        V(2, "/reports/export"), params={"format": "html"}, headers=ctx["headers"]
    )
    assert html.status_code == 200 and "<h2>What changed since version 1</h2>" in html.text

    # Since an explicit earlier version.
    resp = await client.post(
        f"/v1/documents/{SLUG}/llm-jobs",
        json={"kind": "reporting", "version": 2, "since": 2},
        headers=ctx["headers"],
    )
    assert resp.status_code == 422


async def test_reports_of_a_version_without_a_job_are_empty(client, ctx):
    await import_draft(client, ctx)
    reports = (await client.get(V(1, "/reports"), headers=ctx["headers"])).json()
    assert reports["resolution"] is None and reports["latest_job"] is None
    md = await client.get(V(1, "/reports/export"), headers=ctx["headers"])
    assert "No reports have been generated" in md.text


# --- the queue ---------------------------------------------------------------------------


async def test_a_transient_failure_is_retried_once(client, ctx, pool, fake):
    await import_draft(client, ctx)
    f = await comment(client, ctx, "problem", "Why half?")
    fake.script["review_comments"] += [
        LlmUnavailable("Claude Code did not answer in 300s"),
        review_answer([{"feedback_id": f, "classification": "question"}]),
    ]
    summary = await tick(client, ctx)
    assert (summary["retried"], summary["succeeded"]) == (1, 1)
    [job] = await jobs(client, ctx)
    assert (job["status"], job["attempts"], job["error"]) == ("succeeded", 2, None)


async def test_a_second_transient_failure_fails_and_a_person_can_retry(client, ctx, pool, fake):
    await import_draft(client, ctx)
    f = await comment(client, ctx, "problem", "Why half?")
    fake.script["review_comments"] += ["not json at all", LlmUnavailable("Overloaded")]
    summary = await tick(client, ctx)
    assert (summary["retried"], summary["failed"]) == (1, 1)
    [job] = await jobs(client, ctx)
    assert (job["status"], job["attempts"], job["error"]) == ("failed", 2, "Overloaded")

    resp = await client.post(f"/v1/llm-jobs/{job['id']}/retry", headers=ctx["headers"])
    assert resp.status_code == 200
    assert (resp.json()["status"], resp.json()["attempts"], resp.json()["error"]) == (
        "queued",
        0,
        None,
    )
    fake.script["review_comments"].append(
        review_answer([{"feedback_id": f, "classification": "question"}])
    )
    assert (await tick(client, ctx))["succeeded"] == 1


async def test_no_claude_account_fails_clearly_with_the_pools_reason(client, ctx, fake):
    await import_draft(client, ctx)
    await comment(client, ctx, "problem", "Why half?")
    summary = await tick(client, ctx)
    assert summary["failed"] == 1
    [job] = await jobs(client, ctx)
    assert job["status"] == "failed" and job["attempts"] == 1
    assert job["error_reason"] == "no_accounts_registered"
    assert "Settings > Claude accounts" in job["error"]
    assert fake.calls == []


async def test_a_spent_pool_reports_its_next_reset(client, ctx, fake):
    await add_account(
        ctx["tenant_id"],
        "spent",
        windows={"five_hour": window(1.0, resets_in=timedelta(hours=2))},
    )
    await import_draft(client, ctx)
    await comment(client, ctx, "problem", "Why half?")
    await tick(client, ctx)
    [job] = await jobs(client, ctx)
    assert job["status"] == "failed"
    assert job["error_reason"] == "no_account_available"
    assert job["next_reset_at"] is not None


async def test_a_paused_pool_says_so(client, ctx, fake):
    await add_account(ctx["tenant_id"], "personal", state=AccountState.PAUSED)
    await import_draft(client, ctx)
    await comment(client, ctx, "problem", "Why half?")
    await tick(client, ctx)
    [job] = await jobs(client, ctx)
    assert (job["status"], job["error_reason"]) == ("failed", "pool_paused")


async def test_cancel_a_queued_job_and_one_that_is_running(client, ctx, pool, fake):
    await import_draft(client, ctx)
    f = await comment(client, ctx, "problem", "Why half?")
    [job] = await jobs(client, ctx)
    resp = await client.post(f"/v1/llm-jobs/{job['id']}/cancel", headers=ctx["headers"])
    assert resp.status_code == 200 and resp.json()["status"] == "cancelled"
    assert (await tick(client, ctx))["ran"] == 0
    again = await client.post(f"/v1/llm-jobs/{job['id']}/cancel", headers=ctx["headers"])
    assert again.status_code == 409

    # Cancelled while its call runs: the answer is dropped.
    await client.post(f"/v1/llm-jobs/{job['id']}/retry", headers=ctx["headers"])

    async def cancel_now(kind, payload):
        resp = await client.post(f"/v1/llm-jobs/{job['id']}/cancel", headers=ctx["headers"])
        assert resp.json()["status"] == "cancelled"

    fake.on_call = cancel_now
    fake.script["review_comments"].append(
        review_answer([{"feedback_id": f, "classification": "question"}])
    )
    await tick(client, ctx)
    got = (await client.get(f"/v1/llm-jobs/{job['id']}", headers=ctx["headers"])).json()
    assert got["status"] == "cancelled" and got["output"] is None
    assert (await feedback(client, ctx))[f]["suggestion"] is None


async def test_jobs_run_one_at_a_time_per_document(client, ctx, pool, fake):
    await import_draft(client, ctx)
    other = DRAFT_V1.replace("onboarding-revamp", "billing-revamp")
    resp = await client.post(
        "/v1/documents/billing-revamp/versions",
        content=other.encode(),
        headers={**ctx["headers"], "Content-Type": "text/markdown"},
    )
    assert resp.status_code == 201
    for slug in (SLUG, SLUG, "billing-revamp"):
        resp = await client.post(
            f"/v1/documents/{slug}/llm-jobs",
            json={"kind": "review_comments"},
            headers=ctx["headers"],
        )
        assert resp.status_code == 201
    tenant_id = ctx["tenant_id"]
    first = await worker.claim_next(tenant_id)
    second = await worker.claim_next(tenant_id)
    assert await worker.claim_next(tenant_id) is None
    async with tenant_session(tenant_id) as s:
        a, b = await s.get(LlmJob, first), await s.get(LlmJob, second)
        assert a.document_id != b.document_id
        assert (a.status, b.status) == ("running", "running")


async def test_a_job_left_running_by_a_stopped_worker_is_reclaimed(client, ctx, pool, fake):
    await import_draft(client, ctx)
    f = await comment(client, ctx, "problem", "Why half?")
    job_id = await worker.claim_next(ctx["tenant_id"])
    async with tenant_session(ctx["tenant_id"]) as s:
        job = await s.get(LlmJob, job_id)
        job.started_at = job.started_at - timedelta(hours=1)
        await s.commit()
    fake.script["review_comments"].append(
        review_answer([{"feedback_id": f, "classification": "question"}])
    )
    summary = await tick(client, ctx)
    assert summary["succeeded"] == 1
    [job] = await jobs(client, ctx)
    assert job["attempts"] == 2


# --- settings and roles ------------------------------------------------------------------


async def test_an_owner_turns_job_kinds_off_per_document(client, ctx, pool, fake):
    await import_draft(client, ctx)
    url = f"/v1/documents/{SLUG}/llm-jobs/settings"
    assert (await client.get(url, headers=ctx["headers"])).json() == {
        "review_comments": True,
        "reporting": True,
        "refinement": True,
        "quality_review": True,
    }
    resp = await client.put(
        url,
        json={"review_comments": False, "reporting": True, "refinement": False},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200 and resp.json()["review_comments"] is False
    await comment(client, ctx, "problem", "Why half?")
    assert await jobs(client, ctx) == []
    resp = await client.post(
        f"/v1/documents/{SLUG}/llm-jobs", json={"kind": "review_comments"}, headers=ctx["headers"]
    )
    assert resp.status_code == 409 and "turned off" in resp.json()["detail"]
    resp = await client.post(
        V(1, "/sections/problem/refine"), json={"instruction": "x"}, headers=ctx["headers"]
    )
    assert resp.status_code == 409
    # Reporting stays on: a second version queues its reports.
    await import_draft(client, ctx, DRAFT_V1.replace("Owner: product.", "Owner: growth."))
    assert [j["kind"] for j in await jobs(client, ctx)] == ["reporting"]


async def test_roles(client, ctx, pool, fake):
    await import_draft(client, ctx)
    f = await comment(client, ctx, "solution", "Make it skippable.")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": f,
                    "classification": "change_request",
                    "suggestion": {"kind": "section_text", "text": "Skippable checklist."},
                }
            ]
        )
    )
    await tick(client, ctx)
    sid = (await feedback(client, ctx))[f]["suggestion"]["id"]
    [job] = await jobs(client, ctx)
    viewer = await token_with_role(ctx["tenant_id"], "viewer")
    commenter = await token_with_role(ctx["tenant_id"], "commenter")
    approver = await token_with_role(ctx["tenant_id"], "approver")

    for headers in (viewer, commenter, approver):
        assert (
            await client.get(f"/v1/documents/{SLUG}/llm-jobs", headers=headers)
        ).status_code == 200
        assert (await client.get(V(1, "/reports"), headers=headers)).status_code == 200
        suggestions = await client.get(f"/v1/documents/{SLUG}/suggestions", headers=headers)
        assert suggestions.status_code == 200 and len(suggestions.json()) == 1

    writes = [
        ("post", f"/v1/documents/{SLUG}/llm-jobs", {"kind": "reporting"}),
        ("post", f"/v1/llm-jobs/{job['id']}/retry", None),
        ("post", f"/v1/llm-jobs/{job['id']}/cancel", None),
        ("patch", f"/v1/suggestions/{sid}", {"text": "x"}),
        ("post", f"/v1/suggestions/{sid}/accept", {}),
        ("post", f"/v1/suggestions/{sid}/dismiss", {}),
        ("post", V(1, "/sections/solution/refine"), {"instruction": "x"}),
        ("post", f"/v1/llm-jobs/{job['id']}/apply", {}),
    ]
    for headers in (viewer, commenter):
        for method, url, body in writes:
            resp = await getattr(client, method)(url, json=body, headers=headers)
            assert resp.status_code == 403, (method, url)
    settings = f"/v1/documents/{SLUG}/llm-jobs/settings"
    resp = await client.put(settings, json={"reporting": False}, headers=approver)
    assert resp.status_code == 403
    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=approver)
    assert resp.status_code == 200
    resp = await client.post(V(1, "/sections/solution/refine"), json={}, headers=approver)
    assert resp.status_code == 201


async def test_a_commenters_comment_still_queues_the_job(client, ctx, pool, fake):
    await import_draft(client, ctx)
    commenter = await token_with_role(ctx["tenant_id"], "commenter")
    resp = await client.post(
        V(1, "/comments"),
        json={"section_key": "problem", "anchor": ANCHOR, "body": "Why?"},
        headers=commenter,
    )
    assert resp.status_code == 201
    assert [j["kind"] for j in await jobs(client, ctx)] == ["review_comments"]


async def test_tick_needs_an_owner_or_token_and_reports_jobs(client, ctx, pool, fake):
    await import_draft(client, ctx)
    approver = await token_with_role(ctx["tenant_id"], "approver")
    # Tokens may tick (the CLI's way); the tick summary carries the jobs line.
    resp = await client.post("/v1/internal/tick", headers=approver)
    assert resp.status_code == 200 and resp.json()["llm_jobs"]["ran"] == 0


# --- the house rules ---------------------------------------------------------------------


def test_clean_body_follows_o1c_and_keeps_section_ids():
    out = prompting.clean_body(
        "## Solution {#solution}\nA checklist [c:c1] (see https://example.com/x).\n"
        "### Detail {#detail}\n![chart](https://example.com/c.png) [study](https://e.x/s)\n"
        "60% of teams finish it."
    )
    assert out.text == "A checklist (see).\n#### Detail\nchart study\n60% of teams finish it."
    assert set(out.fixes) == {"headings", "citation_markers", "links", "urls"}
    assert prompting.body_problems(out.text) == []
    # O1e: headline numbers stay.
    assert "60%" in out.text


def test_parse_answer_finds_the_json_object():
    assert prompting.parse_answer('Sure.\n```json\n{"a": 1}\n```') == {"a": 1}
    assert prompting.parse_answer('Here: {"a": {"b": 2}} done') == {"a": {"b": 2}}
    with pytest.raises(prompting.AnswerError):
        prompting.parse_answer("[1, 2]")


def test_every_kind_has_a_versioned_prompt():
    for kind in ("review_comments", "reporting", "refinement"):
        name, text = prompting.current(kind)
        assert name.startswith(f"{kind}.v") and len(text) > 500
        assert (prompting.PROMPTS / f"{name}.md").exists()
    # O1c and O1e are in the instructions of every kind that writes section text.
    for kind in ("review_comments", "refinement"):
        text = prompting.current(kind)[1]
        assert "Sources and data points" in text and "Headline numbers" in text


async def test_section_rows_unchanged_by_suggestions(client, ctx, pool, fake):
    v1 = await import_draft(client, ctx)
    f = await comment(client, ctx, "solution", "Make it skippable.")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": f,
                    "classification": "change_request",
                    "suggestion": {"kind": "section_text", "text": "Skippable."},
                }
            ]
        )
    )
    await tick(client, ctx)
    sid = (await feedback(client, ctx))[f]["suggestion"]["id"]
    await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
    async with tenant_session(ctx["tenant_id"]) as s:
        hashes = dict(
            (
                await s.execute(
                    select(Section.section_key, Section.content_hash)
                    .join(DocumentVersion, DocumentVersion.id == Section.version_id)
                    .where(DocumentVersion.number == 1)
                )
            ).all()
        )
    assert hashes == {x["section_key"]: x["content_hash"] for x in v1["sections"]}
