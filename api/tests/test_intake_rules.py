"""Security review rules for the intake (v2-intake fixes): who may clear a critical gap
(B4), decided gaps stay decided, who links a PRD and asks the next batch, and audited
reads of source excerpts. Synthetic placeholders only."""

import uuid

from sqlalchemy import select

from oracle import readiness
from oracle.intake import checks as intake_checks
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_item
from tests.intake_helpers import (
    answer,
    batch,
    company,
    create_intake,
    gaps_by_category,
    intake_with_source,
    question_for,
    summary,
)
from tests.test_intake import _document

BLOCKER_BRIEF = "Pre-fill saved addresses from the partner shipping API; it has a rate limit."


async def _blocker_intake(client, ctx):
    doc = await _document(client, ctx)
    out = await create_intake(client, ctx, who="approver", document=doc, brief=BLOCKER_BRIEF)
    return out, question_for(await batch(client, ctx, out["intake"]["id"]), "blockers")


async def _blocking(ctx, document_id: str, gap_id: str) -> bool:
    """Whether ``gap_id`` holds the PRD's review gate (intake.critical_blockers)."""
    async with tenant_session(ctx.tenant_id) as s:
        report = await readiness.evaluate(
            readiness.ReadinessContext(s, uuid.UUID(document_id)),
            keys=[intake_checks.CRITICAL_BLOCKERS],
        )
    return any(gap_id in r.rationale for r in report.blocking)


async def _decide(client, ctx, gap_id: str, who: str, decision: str = "validate"):
    return await client.post(
        f"/v1/gaps/{gap_id}/decisions",
        json={"decision": decision, "rationale": "Checked with the partner team."},
        headers=ctx.as_(who),
    )


# --- B4: clearing a critical gap ----------------------------------------------------------


async def test_a_commenters_answer_never_clears_a_critical_blocker(client):
    ctx = await company()
    out, q = await _blocker_intake(client, ctx)
    assert gaps_by_category(out)["blockers"]["importance"] == "critical"
    document_id = out["intake"]["document_id"]
    assert await _blocking(ctx, document_id, q["gap_id"])

    result = await answer(client, ctx, q["id"], body="The limit is generous enough.")
    assert result["gap"]["status"] == "answered_pending_review"
    assert [a["kind"] for a in result["next_actions"]] == ["validate"]
    assert result["next_actions"][0]["role"] == "owner"
    # Still blocked: an answer below the owner role waits for review.
    assert await _blocking(ctx, document_id, q["gap_id"])
    # An approver may not clear a critical hard blocker; an owner may.
    assert (await _decide(client, ctx, q["gap_id"], "approver")).status_code == 403
    resp = await _decide(client, ctx, q["gap_id"], "owner")
    assert resp.status_code == 201, resp.text
    assert resp.json()["gap"]["status"] == "validated"
    assert not await _blocking(ctx, document_id, q["gap_id"])


async def test_an_owners_answer_settles_a_critical_gap(client):
    ctx = await company()
    out, q = await _blocker_intake(client, ctx)
    result = await answer(client, ctx, q["id"], who="owner", body="Partner raised our quota.")
    assert result["gap"]["status"] == "answered"
    assert not await _blocking(ctx, out["intake"]["document_id"], q["gap_id"])


async def test_validating_an_unanswered_critical_gap_takes_an_owner(client):
    ctx = await company()
    out = await create_intake(client, ctx)
    critical = [g for g in out["gaps"] if g["importance"] == "critical"
                and g["category"] not in ("blockers", "third_party_policy")]  # fmt: skip
    gap = critical[0]
    assert gap["status"] in ("unknown", "asked")
    assert (await _decide(client, ctx, gap["id"], "approver")).status_code == 403
    resp = await _decide(client, ctx, gap["id"], "owner")
    assert resp.status_code == 201, resp.text


async def test_an_approver_validates_an_answered_critical_gap_that_is_not_a_blocker(client):
    ctx = await company()
    out = await create_intake(client, ctx)
    q = question_for(await batch(client, ctx, out["intake"]["id"]), "success_metric")
    result = await answer(client, ctx, q["id"], body="Median repeat checkout time.")
    assert result["gap"]["status"] == "answered_pending_review"
    assert result["next_actions"][0]["role"] == "approver"
    resp = await _decide(client, ctx, q["gap_id"], "approver")
    assert resp.status_code == 201, resp.text
    assert resp.json()["gap"]["status"] == "validated"


async def test_lowering_a_critical_gaps_importance_takes_an_owner(client):
    ctx = await company()
    out, q = await _blocker_intake(client, ctx)
    gap = gaps_by_category(out)["blockers"]
    body = {"importance": "medium", "lock_version": gap["lock_version"]}
    resp = await client.patch(f"/v1/gaps/{gap['id']}", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 403, resp.text
    # Raising another gap stays an approver's triage.
    other = gaps_by_category(out)["alternatives"]
    resp = await client.patch(
        f"/v1/gaps/{other['id']}", json={"importance": "high",
                                          "lock_version": other["lock_version"]},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    resp = await client.patch(f"/v1/gaps/{gap['id']}", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["importance"] == "medium"


async def test_moving_an_intake_with_an_open_critical_blocker_off_its_prd_takes_an_owner(
    client,
):
    ctx = await company()
    out, _ = await _blocker_intake(client, ctx)
    intake_id = out["intake"]["id"]
    body = {"document": None, "lock_version": out["intake"]["lock_version"]}
    resp = await client.patch(f"/v1/intakes/{intake_id}", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 403, resp.text
    resp = await client.patch(f"/v1/intakes/{intake_id}", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["document_id"] is None


# --- decided gaps stay decided --------------------------------------------------------------


async def test_later_non_answers_never_rewrite_a_decided_gap(client):
    ctx = await company()
    out = await create_intake(client, ctx)
    intake_id = out["intake"]["id"]
    cards = (await batch(client, ctx, intake_id))["questions"]
    for kind, card in zip(("dont_know", "defer", "research", "delegate"), cards, strict=False):
        q = card["question"]
        decision = "accept_risk" if kind in ("defer", "delegate") else "validate"
        resp = await _decide(client, ctx, q["gap_id"], "owner", decision)
        assert resp.status_code == 201, resp.text
        decided = resp.json()["gap"]
        body = {"kind": kind}
        if kind == "delegate":
            body["delegated_to"] = str(ctx.users["approver"].id)
        result = await answer(client, ctx, q["id"], **body)
        assert result["gap"]["status"] == decided["status"], kind
        assert result["gap"]["knowledge_state"] == decided["knowledge_state"], kind
        assert result["gap"]["owner_id"] == decided["owner_id"], kind
        assert result["proposals"] == [], kind
    after = gaps_by_category(await summary(client, ctx, intake_id, who="commenter"))
    assert {after[c["question"]["category"]]["status"] for c in cards[:4]} <= {
        "validated", "accepted_risk",
    }  # fmt: skip


# --- linking a PRD, asking the next batch ---------------------------------------------------


async def test_linking_an_intake_to_a_prd_takes_an_approver(client):
    ctx = await company()
    doc = await _document(client, ctx)
    await create_intake(client, ctx, document=doc, expect=403)
    out = await create_intake(client, ctx)
    intake_id = out["intake"]["id"]
    body = {"document": doc, "lock_version": out["intake"]["lock_version"]}
    resp = await client.patch(f"/v1/intakes/{intake_id}", json=body, headers=ctx.as_("commenter"))
    assert resp.status_code == 403, resp.text
    resp = await client.patch(f"/v1/intakes/{intake_id}", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["document_id"] is not None


async def test_the_author_or_an_approver_asks_the_next_batch(client):
    ctx = await company()
    out = await create_intake(client, ctx, who="approver", batch_size=1)
    url = f"/v1/intakes/{out['intake']['id']}/question-batches?size=1"
    # The commenter is not the author.
    assert (await client.post(url, headers=ctx.as_("commenter"))).status_code == 403
    assert (await client.post(url, headers=ctx.as_("viewer"))).status_code == 403
    assert (await client.post(url, headers=ctx.as_("approver"))).status_code == 200
    mine = await create_intake(client, ctx, batch_size=1)
    url = f"/v1/intakes/{mine['intake']['id']}/question-batches?size=1"
    assert (await client.post(url, headers=ctx.as_("commenter"))).status_code == 200


# --- audited reads ------------------------------------------------------------------------


async def _events(ctx, action: str) -> list[AuditEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            (
                await s.scalars(
                    select(AuditEvent)
                    .where(AuditEvent.action == action)
                    .order_by(AuditEvent.created_at)
                )
            ).all()
        )


async def test_reads_that_return_excerpts_are_audited(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    item = gaps_by_category(out)["pain_evidence"]["evidence_ids"][0]
    before = len(await _events(ctx, "intake.evidence_read"))
    await summary(client, ctx, intake_id, who="commenter")
    newer = await make_item(ctx, "commenter", content="Buyers ask for saved addresses again.")
    resp = await client.get(f"/v1/intakes/{intake_id}/new-evidence", headers=ctx.as_("commenter"))
    assert resp.status_code == 200 and resp.json()["count"] == 1
    events = (await _events(ctx, "intake.evidence_read"))[before:]
    routes = {e.data["route"]: e for e in events}
    assert item in routes["get_intake_summary"].data["item_ids"]
    assert routes["get_intake_new_evidence"].data["item_ids"] == [str(newer)]
    assert {e.actor for e in events} == {f"user:{ctx.users['commenter'].id}"}
    # A read that shows no excerpt is not an evidence read.
    count = len(await _events(ctx, "intake.evidence_read"))
    await summary(client, ctx, intake_id, who="viewer")
    assert len(await _events(ctx, "intake.evidence_read")) == count
