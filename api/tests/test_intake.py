"""Evidence-aware intake and the adaptive question engine (CR-03, build prompt §5).

Covers §16 items 3 (short brief + one source -> intake, gaps, recommended template and
modules), 6 (a feature serving no confirmed goal is flagged with its rationale) and 7
(answers update gaps, known answers are not asked again, unknown critical blockers get
research and decision actions).
"""

import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select

from oracle import readiness
from oracle.baseline.models import Proposal
from oracle.intake import checks as intake_checks
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.baseline_helpers import NOW, confirm, edge, entity, make_item
from tests.intake_helpers import (
    BRIEF,
    CATEGORIES,
    all_questions,
    answer,
    ask_of,
    batch,
    company,
    create_intake,
    gaps_by_category,
    intake_with_source,
    question_for,
    summary,
)


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


KNOWLEDGE_STATES = {"verified_fact", "user_decision", "ai_inference", "hypothesis", "unknown"}


# --- §16.3: a short brief plus one source -------------------------------------------


async def test_a_short_brief_and_one_source_make_an_intake_with_gaps_and_a_template(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)

    intake = out["intake"]
    assert intake["status"] == "awaiting_answers"
    assert intake["brief"] == BRIEF
    assert intake["author_id"] == str(ctx.users["commenter"].id)
    # The intake pins the snapshot it read (S4).
    assert out["pinned"]["version"] == 1
    assert intake["source_snapshot_ids"] == [out["pinned"]["snapshot_id"]]

    # Every §5 category is either a gap or covered, and every item carries a state.
    gaps = gaps_by_category(out)
    covered = {c["category"] for c in out["coverage"] if c["state"] == "covered"}
    assert set(gaps) | covered == CATEGORIES
    assert {c["category"] for c in out["coverage"]} == CATEGORIES
    for gap in out["gaps"]:
        assert gap["knowledge_state"] in KNOWLEDGE_STATES
        assert gap["rank_reason"]
        assert set(gap["impact"]) <= {
            "goals", "feasibility", "scope", "economics", "risks", "module_selection"
        }  # fmt: skip
    # What the brief says is the user's claim, not a verified fact.
    problem = next(i for i in out["extracted"] if i["field"] == "problem")
    assert problem["knowledge_state"] == "hypothesis"
    assert "retype" in problem["text"]

    # The source item is evidence for the pain gap, as an inference with its confidence.
    pain = gaps["pain_evidence"]
    assert pain["knowledge_state"] == "ai_inference"
    [ref] = pain["evidence"]
    assert ref["visible"] is True and ref["title"] == "#support thread"
    assert ref["untrusted"] is True and 0 < ref["confidence"] <= 1
    assert "abandon" in ref["data_excerpt"]

    # Ranked: a critical gap with no evidence asks before an inferred one.
    ranks = [g["rank"] for g in out["gaps"]]
    assert ranks == sorted(ranks)
    assert out["gaps"][0]["importance"] == "critical"
    assert gaps["pain_evidence"]["rank"] > gaps["goal_alignment"]["rank"]
    assert len(out["top_uncertainties"]) <= 5
    assert out["top_uncertainties"][0]["id"] == out["gaps"][0]["id"]

    # An existing PRD template is recommended, with required and conditional modules.
    templates = (
        await client.get("/v1/templates", params={"kind": "prd"}, headers=ctx.as_("viewer"))
    ).json()
    assert out["template"]["key"] in {t["key"] for t in templates}
    assert out["template"]["reason"]
    policies = {m["policy"] for m in out["template"]["modules"]}
    assert {"required", "conditional"} <= policies
    for module in out["template"]["modules"]:
        assert module["reason"]

    # The first short batch is asked: at most five, highest rank first.
    first = out["batch"]
    assert first["current"] == 1 and 0 < first["asked"] <= 5
    current = await batch(client, ctx, intake["id"])
    priorities = [c["question"]["priority"] for c in current["questions"]]
    assert priorities == sorted(priorities)
    assert {c["question"]["status"] for c in current["questions"]} == {"asked"}
    for card in current["questions"]:
        assert set(card["answer_paths"]) == {"answer", "dont_know", "defer", "delegate", "research"}
        assert card["gap"]["id"] == card["question"]["gap_id"]
        assert card["question"]["rationale"]


async def test_the_intake_is_audited_and_listed(client):
    ctx = await company()
    out = await create_intake(client, ctx)
    listed = (await client.get("/v1/intakes", headers=ctx.as_("viewer"))).json()
    assert [i["id"] for i in listed] == [out["intake"]["id"]]
    from oracle.models import AuditEvent

    async with tenant_session(ctx.tenant_id) as s:
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert {"intake.created", "intake.questions_asked"} <= actions


async def test_signals_in_the_brief_raise_the_matching_gaps(client):
    ctx = await company()
    out = await create_intake(
        client,
        ctx,
        brief=(
            "Use the partner shipping API to pre-fill addresses for returning buyers. "
            "The partner API has a rate limit, and addresses are personal data."
        ),
    )
    gaps = gaps_by_category(out)
    assert gaps["third_party_policy"]["importance"] == "critical"
    assert gaps["blockers"]["importance"] == "critical"
    assert gaps["security_privacy"]["importance"] == "critical"
    keys = {m["key"] for m in out["template"]["modules"] if m["policy"] == "conditional"}
    assert "constraints.solutions" in keys
    inputs = (
        await client.get(
            f"/v1/intakes/{out['intake']['id']}/composition-inputs", headers=ctx.as_("viewer")
        )
    ).json()
    assert inputs["intake_id"] == out["intake"]["id"]
    assert inputs["signals"]["third_party"] is True
    assert inputs["signals"]["personal_data"] is True
    assert inputs["source_snapshot_ids"] == out["intake"]["source_snapshot_ids"]
    assert inputs["outputs"] == ["prd"]


async def test_the_brief_must_be_short_but_present(client):
    ctx = await company()
    for brief in ("", "too short", "x" * 4001):
        await create_intake(client, ctx, brief=brief, expect=422)


# --- §16.6: a feature serving no confirmed goal is flagged ------------------------------


async def test_a_feature_serving_no_confirmed_goal_is_flagged_with_its_rationale(client):
    ctx = await company()
    goal = await entity(client, ctx, type="goal", key="repeat-purchases",
                        title="Grow repeat purchases")  # fmt: skip
    feature = await entity(client, ctx, type="feature", key="gift-wrapping",
                           title="Gift wrapping at checkout")  # fmt: skip
    # The goal link exists, but the goal is only proposed: it does not count.
    await edge(client, ctx, feature, goal, "supports", attrs={"contribution": 2})

    out = await create_intake(
        client, ctx, title="Gift wrapping",
        brief="Add gift wrapping at checkout so buyers can send presents directly.",
    )  # fmt: skip
    features = {f["key"]: f for f in out["features"] if f["key"]}
    flagged = features["gift-wrapping"]
    assert "serves_no_goal" in flagged["flags"]
    assert "goal" in flagged["rationale"].lower()
    assert "priorit" in flagged["rationale"].lower()
    assert out["missing_goals"] is True
    gaps = gaps_by_category(out)
    assert gaps["goal_alignment"]["importance"] == "critical"
    assert gaps["goal_alignment"]["status"] in ("unknown", "asked")
    # The baseline traceability report still flags it too.
    trace = (await client.get("/v1/baseline/trace", headers=ctx.as_("viewer"))).json()
    assert (
        "serves_no_goal"
        in next(f for f in trace["features"] if f["key"] == "gift-wrapping")["flags"]
    )

    # Once the goal is confirmed, the feature is no longer flagged and the goal is linked.
    await confirm(client, ctx, goal)
    again = await summary(client, ctx, out["intake"]["id"])
    features = {f["key"]: f for f in again["features"] if f["key"]}
    assert "serves_no_goal" not in features["gift-wrapping"]["flags"]
    assert [g["key"] for g in features["gift-wrapping"]["goals"]] == ["repeat-purchases"]


# --- §16.7: answers update gaps; nothing answered is asked again --------------------------


async def test_an_answer_updates_its_gap_and_is_never_asked_again(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    q = question_for(await batch(client, ctx, intake_id), "success_metric")

    result = await answer(
        client, ctx, q["id"], body="Median repeat checkout time; 95 s today, 45 s by Q3."
    )
    assert result["question"]["status"] == "answered"
    # A critical gap answered below the owner role waits for review (B4).
    assert result["gap"]["importance"] == "critical"
    assert result["gap"]["status"] == "answered_pending_review"
    assert result["gap"]["knowledge_state"] == "user_decision"
    assert result["answer"]["kind"] == "answer"
    assert result["answer"]["answered_by"] == str(ctx.users["commenter"].id)
    # The answer proposes a baseline outcome; nothing is applied without a person.
    [proposal_id] = result["baseline_proposal_ids"]
    async with tenant_session(ctx.tenant_id) as s:
        proposal = await s.get(Proposal, uuid.UUID(proposal_id))
        assert proposal.status == "open"
        assert proposal.payload["fields"]["type"] == "outcome"
        change = await s.get(ChangeEvent, uuid.UUID(result["change_event_id"]))
        assert change.subject_kind == "decision"
        assert change.data["intake_id"] == intake_id
        assert change.data["category"] == "success_metric"

    # Re-analysing and asking the next batches never asks it again.
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("commenter"))
    assert resp.status_code == 200, resp.text
    for _ in range(5):
        resp = await client.post(
            f"/v1/intakes/{intake_id}/question-batches", headers=ctx.as_("commenter")
        )
        assert resp.status_code in (200, 409), resp.text
    questions = await all_questions(client, ctx, intake_id)
    assert sum(q["category"] == "success_metric" for q in questions) == 1
    assert len({q["gap_id"] for q in questions}) == len(questions)
    after = gaps_by_category(await summary(client, ctx, intake_id))
    assert after["success_metric"]["status"] == "answered_pending_review"

    # Answering it again is refused (an approver may revise, a commenter may not).
    await answer(client, ctx, q["id"], body="Something else", expect=409)


async def test_confirmed_and_locked_baseline_facts_are_not_asked(client):
    ctx = await company()
    goal = await entity(
        client, ctx, type="goal", key="repeat-purchases", title="Grow repeat purchases",
        attrs={"metric": "repeat purchase rate", "unit": "%", "comparison": "at_least",
               "target": 30, "horizon": "short", "owner": str(ctx.users["approver"].id)},
    )  # fmt: skip
    await confirm(client, ctx, goal)
    out = await create_intake(
        client, ctx,
        brief="Add saved addresses so returning buyers make more repeat purchases.",
    )  # fmt: skip
    coverage = {c["category"]: c for c in out["coverage"]}
    for category in ("goal_alignment", "success_metric"):
        assert coverage[category]["state"] == "covered", category
        assert coverage[category]["knowledge_state"] == "user_decision"
        assert coverage[category]["entity_ids"] == [goal["id"]]
    assert [g["key"] for g in out["goals"]] == ["repeat-purchases"]
    assert out["goals"][0]["knowledge_state"] == "user_decision"
    assert out["missing_goals"] is False
    questions = await all_questions(client, ctx, out["intake"]["id"])
    assert not {"goal_alignment", "success_metric"} & {q["category"] for q in questions}


async def test_dont_know_on_a_critical_blocker_offers_research_and_a_decision(client, runtime):
    ctx = await company()
    doc = await _document(client, ctx)
    # Linking an intake to a PRD takes an approver.
    await create_intake(client, ctx, document=doc, expect=403)
    out = await create_intake(
        client, ctx, who="approver", document=doc,
        brief="Pre-fill saved addresses from the partner shipping API; it has a rate limit.",
    )  # fmt: skip
    intake_id = out["intake"]["id"]
    q = question_for(await batch(client, ctx, intake_id), "blockers")

    await ask_of(client, ctx, q["id"], "commenter")
    result = await answer(client, ctx, q["id"], kind="dont_know")
    # Still open until a real answer (owner 2026-10-29, qa-work-2).
    assert result["question"]["status"] == "asked"
    assert result["gap"]["status"] == "unknown"
    assert result["gap"]["knowledge_state"] == "unknown"
    kinds = {a["kind"] for a in result["next_actions"]}
    assert {"research", "accept_risk", "delegate"} <= kinds
    [proposal] = [p for p in result["proposals"] if p["kind"] == "research_run"]
    assert proposal["status"] == "proposed"
    assert proposal["gap_id"] == q["gap_id"]
    # A proposal only: no run exists, nothing was dispatched.
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Run)) == 0
    assert runtime.submitted == []

    # The unresolved critical blocker reaches the review gate (a hard check).
    async with tenant_session(ctx.tenant_id) as s:
        report = await readiness.evaluate(
            readiness.ReadinessContext(s, uuid.UUID(out["intake"]["document_id"])),
            keys=[intake_checks.CRITICAL_BLOCKERS, intake_checks.OPEN_DECISIONS],
        )
    assert report.blocked
    [blocking] = report.blocking
    assert blocking.key == intake_checks.CRITICAL_BLOCKERS
    assert q["gap_id"] in blocking.rationale or blocking.evidence_ids == []

    # Accepting the risk on a critical gap is an owner's call, with a reason.
    body = {"decision": "accept_risk", "rationale": "Ship behind a flag; measure the limit."}
    resp = await client.post(
        f"/v1/gaps/{q['gap_id']}/decisions", json=body, headers=ctx.as_("approver")
    )
    assert resp.status_code == 403, resp.text
    resp = await client.post(
        f"/v1/gaps/{q['gap_id']}/decisions",
        json={"decision": "accept_risk", "rationale": ""},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422
    resp = await client.post(
        f"/v1/gaps/{q['gap_id']}/decisions", json=body, headers=ctx.as_("owner")
    )
    assert resp.status_code == 201, resp.text
    decided = resp.json()
    assert decided["gap"]["status"] == "accepted_risk"
    assert decided["decision"]["decision"] == "accept_risk"
    assert decided["decision"]["decided_by"] == str(ctx.users["owner"].id)

    async def gate():
        async with tenant_session(ctx.tenant_id) as s:
            return await readiness.evaluate(
                readiness.ReadinessContext(s, uuid.UUID(out["intake"]["document_id"])),
                keys=[intake_checks.CRITICAL_BLOCKERS],
            )

    # The partner API's policy gap is still open: the gate names it, not the blocker.
    report = await gate()
    assert report.blocked and q["gap_id"] not in report.blocking[0].rationale
    policy = gaps_by_category(await summary(client, ctx, intake_id))["third_party_policy"]
    assert policy["id"] in report.blocking[0].rationale
    resp = await client.post(
        f"/v1/gaps/{policy['id']}/decisions",
        json={"decision": "accept_risk", "rationale": "Within the published quota."},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    assert not (await gate()).blocked


async def test_research_this_proposes_a_run_and_only_a_person_creates_it(client, runtime):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    q = question_for(await batch(client, ctx, intake_id), "goal_alignment")

    result = await answer(client, ctx, q["id"], kind="research")
    assert result["question"]["status"] == "researching"
    assert result["gap"]["status"] == "under_investigation"
    [proposal] = result["proposals"]
    assert proposal["kind"] == "research_run" and proposal["status"] == "proposed"

    listed = (
        await client.get(f"/v1/intakes/{intake_id}/proposals", headers=ctx.as_("viewer"))
    ).json()
    assert [p["id"] for p in listed] == [proposal["id"]]

    # A commenter cannot accept it; an approver accepts and gets a draft run only.
    url = f"/v1/intake-proposals/{proposal['id']}/accept"
    assert (await client.post(url, headers=ctx.as_("commenter"))).status_code == 403
    resp = await client.post(url, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    accepted = resp.json()
    assert accepted["status"] == "accepted"
    run_id = accepted["result"]["run_id"]
    run = (await client.get(f"/v1/runs/{run_id}", headers=ctx.as_("viewer"))).json()
    assert run["status"] == "draft"
    assert runtime.submitted == []
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run_id))
        assert row.knobs["intake_id"] == intake_id
        assert row.knobs["intake_snapshot_id"] == out["pinned"]["snapshot_id"]
        assert row.knobs["intake_gap_ids"] == [q["gap_id"]]
    # Deciding twice is refused.
    assert (await client.post(url, headers=ctx.as_("approver"))).status_code == 409


async def test_research_can_start_from_a_gap_and_be_dismissed(client):
    ctx = await company()
    out = await create_intake(client, ctx)
    gap = gaps_by_category(out)["economic_benefit"]
    resp = await client.post(f"/v1/gaps/{gap['id']}/research", headers=ctx.as_("commenter"))
    assert resp.status_code == 201, resp.text
    proposal = resp.json()
    # The same research is not proposed twice while it is open.
    again = await client.post(f"/v1/gaps/{gap['id']}/research", headers=ctx.as_("commenter"))
    assert again.json()["id"] == proposal["id"]
    resp = await client.post(
        f"/v1/intake-proposals/{proposal['id']}/dismiss",
        json={"reason": "We know this already"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200 and resp.json()["status"] == "dismissed"


async def test_defer_and_delegate(client):
    ctx = await company()
    out = await create_intake(client, ctx)
    intake_id = out["intake"]["id"]
    current = await batch(client, ctx, intake_id)
    first, second = current["questions"][0]["question"], current["questions"][1]["question"]

    deferred = await answer(client, ctx, first["id"], kind="defer")
    assert deferred["question"]["status"] == "deferred"
    assert deferred["gap"]["status"] == "deferred"

    approver = str(ctx.users["approver"].id)
    # Delegating needs a person of this company who can answer.
    await answer(client, ctx, second["id"], kind="delegate", delegated_to=str(uuid.uuid4()),
                 expect=422)  # fmt: skip
    await answer(client, ctx, second["id"], kind="delegate",
                 delegated_to=str(ctx.users["viewer"].id), expect=422)  # fmt: skip
    delegated = await answer(client, ctx, second["id"], kind="delegate", delegated_to=approver)
    assert delegated["question"]["status"] == "delegated"
    assert delegated["question"]["asked_to"] == approver
    assert delegated["gap"]["owner_id"] == approver
    # Now only the person asked (or an approver) answers it.
    await answer(client, ctx, second["id"], body="Me", who="commenter", expect=403)
    done = await answer(client, ctx, second["id"], body="The growth team owns it", who="approver")
    assert done["question"]["status"] == "answered"
    # A deferred question can still be answered later; a critical one then waits for
    # an owner's review (B4).
    later = await answer(client, ctx, first["id"], body="Decided now")
    assert later["gap"]["status"] == (
        "answered_pending_review" if later["gap"]["importance"] == "critical" else "answered"
    )


async def test_answers_validate_their_body_and_evidence(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    q = (await batch(client, ctx, out["intake"]["id"]))["questions"][0]["question"]
    await answer(client, ctx, q["id"], expect=422)  # an answer needs a body
    await answer(client, ctx, q["id"], body="x", knowledge_state="verified_fact", expect=422)
    other = await make_item(ctx, "approver", content="Not yours")
    await answer(client, ctx, q["id"], body="x", evidence_ids=[str(other)], expect=422)
    mine = gaps_by_category(out)["pain_evidence"]["evidence"][0]["source_item_id"]
    done = await answer(
        client, ctx, q["id"], body="Per the thread", evidence_ids=[mine],
        knowledge_state="verified_fact",
    )  # fmt: skip
    assert done["gap"]["knowledge_state"] == "verified_fact"
    assert mine in done["gap"]["evidence_ids"]


async def test_an_answer_on_a_linked_prd_becomes_a_patch_proposal_not_an_edit(client):
    ctx = await company()
    doc = await _document(client, ctx)
    out = await create_intake(client, ctx, who="approver", document=doc)
    q = question_for(await batch(client, ctx, out["intake"]["id"]), "success_metric")
    await ask_of(client, ctx, q["id"], "commenter")
    result = await answer(client, ctx, q["id"], body="Repeat checkout time, 95 s to 45 s.")
    [patch] = [p for p in result["proposals"] if p["kind"] == "prd_patch"]
    assert patch["status"] == "proposed"
    assert patch["detail"]["base_version"] == 1
    versions = (await client.get(f"/v1/documents/{doc}", headers=ctx.as_("viewer"))).json()
    assert len(versions["versions"]) == 1  # the PRD itself is untouched

    resp = await client.post(
        f"/v1/intake-proposals/{patch['id']}/accept", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    feedback_id = resp.json()["result"]["feedback_item_id"]
    listed = (await client.get(f"/v1/documents/{doc}/feedback", headers=ctx.as_("viewer"))).json()
    [feedback] = [f for f in listed if f["id"] == feedback_id]
    assert feedback["status"] == "open" and feedback["kind"] == "general"
    assert "95 s to 45 s" in feedback["summary"]


async def test_gaps_can_be_added_and_triaged_with_optimistic_locking(client):
    ctx = await company()
    out = await create_intake(client, ctx)
    intake_id = out["intake"]["id"]
    resp = await client.post(
        "/v1/gaps",
        json={"intake_id": intake_id, "category": "alternatives",
              "statement": "Could the courier's address book do this?", "importance": "medium"},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    gap = resp.json()
    assert gap["knowledge_state"] == "unknown" and gap["status"] == "unknown"

    patch = {"importance": "high", "lock_version": gap["lock_version"]}
    assert (
        await client.patch(f"/v1/gaps/{gap['id']}", json=patch, headers=ctx.as_("commenter"))
    ).status_code == 403
    resp = await client.patch(f"/v1/gaps/{gap['id']}", json=patch, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["importance"] == "high"
    stale = await client.patch(f"/v1/gaps/{gap['id']}", json=patch, headers=ctx.as_("approver"))
    assert stale.status_code == 409


async def test_conflicts_and_staleness_are_surfaced_with_a_recommendation(client):
    ctx = await company()
    await make_item(ctx, "commenter", kind="slack",
                    content="Repeat checkout conversion is 12% this month.",
                    title="#growth chat")  # fmt: skip
    await make_item(ctx, "commenter", kind="notion", item_kind="page",
                    content="Dashboard: repeat checkout conversion is 18% this month.",
                    title="Checkout dashboard notes")  # fmt: skip
    await make_item(ctx, "commenter", kind="slack", title="#old thread",
                    content="Buyers complain checkout addresses are slow to type.",
                    updated=NOW - timedelta(days=400))  # fmt: skip
    out = await create_intake(
        client, ctx, brief="Raise repeat checkout conversion with saved addresses for buyers."
    )
    [conflict] = [c for c in out["conflicts"] if c["kind"] == "source"]
    assert {c["value"] for c in conflict["claims"]} == {"12%", "18%"}
    winner = conflict["claims"][conflict["recommendation"]["winner"]]
    assert winner["value"] == "18%"  # docs beat chat (B3)
    assert conflict["recommendation"]["reason"]
    assert all(c["evidence"][0]["visible"] for c in conflict["claims"])
    stale = [s["evidence"]["title"] for s in out["stale"]]
    assert stale == ["#old thread"]


async def test_baseline_conflicts_on_linked_entities_are_listed(client):
    ctx = await company()
    goal = await entity(client, ctx, type="goal", key="repeat-purchases",
                        title="Grow repeat purchases")  # fmt: skip
    await confirm(client, ctx, goal)
    resp = await client.post(
        "/v1/baseline/conflicts",
        json={"entity_id": goal["id"], "field": "attrs.weight",
              "claims": [{"value": 3, "evidence_ids": []}, {"value": 1, "evidence_ids": []}]},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    out = await create_intake(
        client, ctx, brief="Saved addresses so returning buyers make more repeat purchases."
    )
    [conflict] = [c for c in out["conflicts"] if c["kind"] == "baseline"]
    assert conflict["conflict_id"] == resp.json()["id"]
    assert conflict["topic"].endswith("attrs.weight")


async def _document(client, ctx) -> str:
    """A PRD with one version, so an intake can link to it."""
    markdown = (Path(__file__).parent / "fixtures" / "prd_v1.md").read_text(encoding="utf-8")
    slug = "checkout-redesign"
    resp = await client.post(
        f"/v1/documents/{slug}/versions",
        content=markdown.encode(),
        headers={**ctx.as_("owner"), "Content-Type": "text/markdown"},
    )
    assert resp.status_code == 201, resp.text
    return slug
