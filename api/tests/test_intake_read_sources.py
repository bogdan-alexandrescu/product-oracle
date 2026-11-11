"""A brief's read reads every uploaded source and the baseline features it is about before
it says something is not described (walk 2, problem 17).

A PRD brief said "the two must-include engines are not described anywhere" although an
old PRD describing both had been uploaded as a source and both engines were baseline
features. The read (oracle.intake.job.payload, what the built-in job and the SwarmCloud
read both get) now holds every uploaded document, whole or by its relevant sections, the
baseline features the brief names with their descriptions and evidence, and Oracle's
check drops a gap that calls one of them missing.

Invented example data only.
"""

import json
import re
import uuid

import pytest
from sqlalchemy import select

from oracle.docs import draft_checks
from oracle.intake import job as intake_job
from oracle.jobs import worker
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.llm.transports import LlmRequest, TransportResult
from oracle.runs import flows
from oracle.runs import service as runs_service
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake
from tests.baseline_helpers import cite, confirm, entity, make_item
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import company, create_intake, summary
from tests.test_intake_draft_gate import _create_run, runtime  # noqa: F401 (fixture)
from tests.test_llm_jobs import DRAFT_V1

BRIEF = (
    "Plan the next version of the quote builder for example.com shops. It must include "
    "the pricing engine and the routing engine."
)
FILLER = " ".join(
    f"Section {n} of the old plan covers onboarding screens, colours and copy for new shops."
    for n in range(40)
)
OLD_PRD = (
    "# Quote builder v1\n\n## Overview\n\n" + FILLER + "\n\n## Pricing engine\n\n"
    "The pricing engine computes each quote from the shop's rate card and applies volume "
    "discounts per line.\n\n## Routing engine\n\nThe routing engine assigns each quote to "
    "the nearest depot by postcode and hands it over to the courier."
)
GLOSSARY = "Depot: a warehouse that ships orders. Courier: the carrier that delivers them."
MISSING = "The two must-include engines are not described anywhere."
REAL_GAP = "Who signs off the launch date with the depots?"


class FakeClaude:
    def __init__(self, answer):
        self.answer = answer
        self.requests: list[LlmRequest] = []

    async def complete(self, token: str, request: LlmRequest) -> TransportResult:
        self.requests.append(request)
        payload = json.loads(request.messages[0]["content"])
        return TransportResult(
            text=json.dumps(self.answer(payload)),
            model=request.model,
            usage={"input_tokens": 900, "output_tokens": 200, "total_cost_usd": 0.02},
        )


@pytest.fixture
def fake():
    holder = {}

    def install(answer):
        claude = FakeClaude(answer)
        holder["previous"] = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
        return claude

    yield install
    if "previous" in holder:
        gateway.set_transports(holder["previous"])


@pytest.fixture(autouse=True)
def _intake_read_on_the_job(monkeypatch):
    from oracle.config import get_settings

    monkeypatch.setattr(get_settings(), "intake_read_runtime", "job")


async def _setup(client):
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    prd = await make_item(
        ctx, "commenter", kind="upload", item_kind="file", content=OLD_PRD,
        title="Quote builder v1 PRD.md", url=None,
    )  # fmt: skip
    glossary = await make_item(
        ctx, "commenter", kind="upload", item_kind="file", content=GLOSSARY,
        title="Glossary.md", url=None,
    )  # fmt: skip
    pricing = await entity(
        client, ctx, type="feature", key="pricing-engine", title="Pricing engine",
        body="Computes a quote from the rate card with volume discounts.",
    )  # fmt: skip
    routing = await entity(
        client, ctx, type="feature", key="routing-engine", title="Routing engine",
        body="Assigns a quote to the nearest depot.",
    )  # fmt: skip
    for ent in (pricing, routing):
        await confirm(client, ctx, ent)
    await cite(client, ctx, pricing, excerpt="Rate cards are kept per shop.")
    return ctx, prd, glossary


def _source(payload, item_title):
    return next(s for s in payload["untrusted_data"]["sources"] if s["title"] == item_title)


async def _read(client, fake, answer):
    ctx, prd, glossary = await _setup(client)
    claude = fake(answer)
    out = await create_intake(
        client, ctx, title="Quote builder v2", brief=BRIEF, ai_extraction=True
    )
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.succeeded == 1, tick.errors
    [request] = claude.requests
    return ctx, out["intake"]["id"], json.loads(request.messages[0]["content"]), prd


def _quiet(payload):
    return {"items": [], "gaps": [], "category": "feature"}


async def test_every_uploaded_document_is_read_with_its_relevant_sections(client, fake):
    _, _, payload, _ = await _read(client, fake, _quiet)
    prd = _source(payload, "Quote builder v1 PRD.md")
    # The engines are described past the first 1,500 characters: the read holds them.
    assert "computes each quote from the shop's rate card" in prd["excerpt"]
    assert "assigns each quote to the nearest depot" in prd["excerpt"]
    assert prd["kind"] == "upload" and prd["ref"].startswith("src:")
    assert {"Pricing engine", "Routing engine"} <= set(prd["sections"])
    # An uploaded document shares no words with the brief: it is read all the same.
    glossary = _source(payload, "Glossary.md")
    assert glossary["excerpt"] == GLOSSARY and glossary["whole"] is True


async def test_the_baseline_features_the_brief_names_are_read_with_their_evidence(client, fake):
    _, _, payload, _ = await _read(client, fake, _quiet)
    features = {f["key"]: f for f in payload["untrusted_data"]["features"]}
    # Confirmed, each joined the Ground Truth with a code (its slug stays an alias).
    assert set(features) == {"F-01", "F-02"}
    pricing = next(f for f in features.values() if f["title"] == "Pricing engine")
    assert pricing["ref"] == f"feat:{pricing['key']}"
    assert pricing["description"] == "Computes a quote from the rate card with volume discounts."
    assert pricing["status"] == "confirmed"
    assert [e["excerpt"] for e in pricing["evidence"]] == ["Rate cards are kept per shop."]
    # Feature text is people's data: never outside untrusted_data.
    outside = json.dumps({k: v for k, v in payload.items() if k != "untrusted_data"})
    assert "rate card" not in outside


def _feature_ref(payload, title):
    return next(f["ref"] for f in payload["untrusted_data"]["features"] if f["title"] == title)


def _calls_them_missing(payload):
    src = _source(payload, "Quote builder v1 PRD.md")["ref"]
    pricing = _feature_ref(payload, "Pricing engine")
    routing = _feature_ref(payload, "Routing engine")
    return {
        "items": [
            {"field": "scope", "text": "The next version keeps both engines.",
             "evidence_refs": [src, pricing, routing]},
        ],
        "gaps": [
            {"category": "constraints", "importance": "critical", "statement": MISSING,
             "evidence_refs": []},
            {"category": "effort_cost", "importance": "high",
             "statement": "The routing engine is missing from the sources.", "evidence_refs": []},
            {"category": "ownership", "importance": "high", "statement": REAL_GAP,
             "evidence_refs": []},
        ],
        "category": "feature",
    }  # fmt: skip


async def test_the_read_cites_them_and_never_calls_them_missing(client, fake):
    ctx, intake_id, _, prd = await _read(client, fake, _calls_them_missing)
    after = await summary(client, ctx, intake_id, who="commenter")
    statements = [g["statement"] for g in after["gaps"]]
    assert MISSING not in statements
    assert "The routing engine is missing from the sources." not in statements
    assert REAL_GAP in statements  # a real open question still stands
    [kept] = [i for i in after["extracted"] if i["text"] == "The next version keeps both engines."]
    assert [e["source_item_id"] for e in kept["evidence"]] == [str(prd)]
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob))
        assert job.output["dropped_described"] == 2
        assert job.output["dropped_refs"] == 0  # feature refs are citations, not unknown refs
        gaps = (await s.scalars(select(KnowledgeGap))).all()
        assert MISSING not in {g.statement for g in gaps}
        intake = await s.get(ProductIntake, job.intake_id)
        [stored] = [i for i in intake.analysis["items"] if i["text"].startswith("The next")]
        assert sorted(stored["feature_keys"]) == ["F-01", "F-02"]


def test_described_check_reads_features_and_sections():
    features = [{"key": "pricing-engine", "title": "Pricing engine", "description": "x"}]
    sections = ["Pricing engine", "Routing engine"]
    assert intake_job.described(MISSING, features, sections)
    assert intake_job.described("There is no description of the routing engine.", [], sections)
    assert not intake_job.described(REAL_GAP, features, sections)
    assert not intake_job.described("The refund flow is not described.", features, sections)
    assert not intake_job.described("How fast must the pricing engine answer?", features, [])


def test_described_drops_only_a_gap_about_the_feature_or_section_itself():
    # An old PRD carries headings for goals, metrics, risks and timeline: a gap that asks
    # for more than the feature or the heading names is still open.
    features = [{"key": "pricing-engine", "title": "Pricing engine", "description": "x"}]
    headings = ["Overview", "Goals", "Success metrics", "Risks", "Timeline", "Pricing engine"]
    for open_gap in [
        "Engineering ownership of the launch is not defined.",
        "Engineering is not defined.",
        "Success metrics for the new version are not defined.",
        "The launch timeline is missing.",
        "Refund rules for the pricing engine are not described.",
    ]:
        assert not intake_job.described(open_gap, features, headings), open_gap
    assert intake_job.described("The pricing engine is not described.", features, [])
    assert intake_job.described("Success metrics are not defined.", [], headings)
    assert intake_job.described("The timeline is missing.", [], headings)


def test_the_tasks_say_read_everything_before_calling_it_missing():
    task = flows.INTAKE_ANALYSIS_TASK
    assert "features" in task and "not described" in task
    ctx = flows.PromptContext(
        run_id="r-1", document="Quote builder v2", snapshot_as_of=None, low_confidence=0.4,
        intake_id="i-1",
    )  # fmt: skip
    flow = flows.FLOWS["baseline_to_prd"]
    draft = next(s for s in flow.segments if s.name == "prd_draft")
    writer = flows.step_prompt(flow, draft, "writer", last=False, ctx=ctx)
    critic = flows.step_prompt(flow, draft, "critic", last=True, ctx=ctx)
    for prompt in (writer, critic):
        assert "every source the brief was pinned to" in prompt
        assert "Ground Truth features" in prompt
    assert "not described" in critic and "Critic" in critic


def test_a_long_upload_is_read_by_the_sections_that_speak_to_the_brief():
    wanted = {"prici", "engin", "routi"}
    got = intake_job.read_of(OLD_PRD, wanted, 600)
    assert got["whole"] is False
    assert got["sections"] == ["Pricing engine", "Routing engine"]
    assert "computes each quote" in got["excerpt"] and "nearest depot" in got["excerpt"]
    assert "onboarding screens" not in got["excerpt"]
    assert len(got["excerpt"]) <= 600


def test_the_intake_spec_names_the_current_prompt():
    from pathlib import Path

    from oracle.jobs import prompting

    spec = Path(__file__).parents[2] / "docs/product-oracle-v2/specs/spec-INT2.md"
    current = prompting.current("intake_analysis")[0]
    named = set(re.findall(r"intake_analysis\.v\d+", spec.read_text()))
    assert named == {current}


DESCRIBED = "described_called_missing"


def _prd(problem: str) -> str:
    draft = DRAFT_V1.replace("document: onboarding-revamp", "document: saved-addresses")
    return draft.replace("Half of new teams never invite a teammate.", problem)


async def _imported(client, ctx, intake_id: str, markdown: str) -> dict:
    """The intake's PRD run imports a draft (the step's import, as a segment's file)."""
    run_id = (await _create_run(client, ctx, intake_id)).json()["id"]
    approver = ctx.as_("approver")
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    assert (await client.post(f"/v1/runs/{run_id}/start", headers=approver)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(run_id))
        out = await runs_service._import_draft(s, run, "prd", markdown)
    assert "error" not in out, out
    return out


async def test_a_prd_draft_that_calls_a_described_feature_missing_goes_back(
    client,
    fake,
    runtime,  # noqa: F811
):
    ctx, intake_id, _, _ = await _read(client, fake, _quiet)
    out = await _imported(
        client, ctx, intake_id,
        _prd("Shops wait for quotes. The routing engine is not described anywhere."),
    )  # fmt: skip
    assert DESCRIBED in out["warnings"]
    [said] = [m for m in out["code_names"] if "routing engine" in m]
    assert "Problem" in said and "cite" in said
    assert DESCRIBED in draft_checks.SENT_BACK


async def test_a_prd_draft_that_asks_for_more_than_a_feature_is_kept(
    client,
    fake,
    runtime,  # noqa: F811
):
    ctx, intake_id, _, _ = await _read(client, fake, _quiet)
    out = await _imported(
        client, ctx, intake_id, _prd("Refund rules for the pricing engine are not described.")
    )
    assert DESCRIBED not in out["warnings"]
