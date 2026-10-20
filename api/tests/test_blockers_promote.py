"""B4, promoting an intake's suggested blocker (owner, 2026-10-20): an intake answer that
reveals a blocker proposes a constraint marked 'suggested blocker'
(``attrs.proposed_blocker``); once an approver accepts it, Promote opens the blocker form
pre-filled from the constraint and the mark (title, strategy, evidence), all editable,
and saving creates the blocker (POST /v1/blockers with its ``entity_id``) and clears the
mark in the same write. Synthetic placeholders only."""

import uuid

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity, Proposal
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, StakeholderQuestion
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import make_evidence
from tests.test_intake_sharing_round5 import ANSWER as INTAKE_ANSWER
from tests.test_intake_sharing_round5 import MODEL_GAP, _blocker_gap, share, world
from tests.test_intake_sharing_round6 import fake  # noqa: F401 (fixture)

SUGGESTED = {"type": "unknown", "limit_kind": "policy", "severity": "high", "status": "open"}
ANSWER = "The carrier's terms forbid storing a buyer's address for longer than 30 days."


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _suggested(ctx) -> uuid.UUID:
    """A constraint an accepted intake proposal made: the answer and the mark."""
    async with tenant_session(ctx.tenant_id) as s:
        entity = Entity(
            type="constraint",
            key="saved-addresses-third-party-policy-ab12cd",
            title=ANSWER,
            body=f"Which third-party rules limit this?\n\n{ANSWER}",
            origin="agent",
            status="confirmed",
            attrs={"gap_id": str(uuid.uuid4()), "proposed_blocker": SUGGESTED},
        )
        s.add(entity)
        await s.commit()
        return entity.id


async def _attrs(ctx, entity_id: uuid.UUID) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        return dict((await s.get(Entity, entity_id)).attrs or {})


def _form(detail: dict, **edits) -> dict:
    """What the pre-filled form sends, with the person's edits."""
    mark = detail["attrs"]["proposed_blocker"]
    return {
        "entity_id": detail["id"],
        "statement": detail["title"],
        "detail": detail["body"],
        **{k: mark[k] for k in ("type", "limit_kind", "severity", "status")},
        **edits,
    }


async def test_promoting_a_suggested_blocker_creates_it_and_clears_the_mark(client, ctx):
    entity_id = await _suggested(ctx)
    await make_evidence(ctx, entity_id, excerpt="Addresses are kept for 30 days at most.")
    detail = (
        await client.get(f"/v1/baseline/entities/{entity_id}", headers=ctx.as_("approver"))
    ).json()
    assert detail["attrs"]["proposed_blocker"] == SUGGESTED

    body = _form(
        detail,
        statement="Carrier terms cap address storage at 30 days",
        type="hard",
        third_party="Example carrier",
        reason="Promoted from the intake's suggested blocker",
    )
    resp = await client.post("/v1/blockers", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    out = resp.json()
    blocker = out["blocker"]
    assert blocker["id"] == str(entity_id)
    assert blocker["statement"] == "Carrier terms cap address storage at 30 days"
    assert blocker["detail"] == detail["body"]
    assert (blocker["type"], blocker["limit_kind"], blocker["severity"], blocker["status"]) == (
        "hard",
        "policy",
        "high",
        "open",
    )
    assert blocker["third_party"] == "Example carrier"
    # The constraint's evidence is the blocker's evidence.
    assert [e["excerpt"] for e in out["evidence"]] == ["Addresses are kept for 30 days at most."]

    attrs = await _attrs(ctx, entity_id)
    assert "proposed_blocker" not in attrs and "blocker" in attrs
    assert attrs["gap_id"]  # the rest of the constraint's attrs stay
    async with tenant_session(ctx.tenant_id) as s:
        [event] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "blocker.created"))
        ).all()
    assert event.data["promoted"] is True

    # Promoting twice is refused: it is a blocker now.
    again = await client.post("/v1/blockers", json=body, headers=ctx.as_("approver"))
    assert again.status_code == 409


async def test_a_refused_promotion_keeps_the_mark(client, ctx):
    """Approver and owner rules are unchanged, and nothing is written when the blocker
    is refused: the constraint stays a suggested blocker."""
    entity_id = await _suggested(ctx)
    detail = (
        await client.get(f"/v1/baseline/entities/{entity_id}", headers=ctx.as_("approver"))
    ).json()
    resp = await client.post("/v1/blockers", json=_form(detail), headers=ctx.as_("commenter"))
    assert resp.status_code == 403
    # A third party needs a limit kind other than "other" (the blocker's own rule).
    bad = _form(detail, limit_kind="other", third_party="Example carrier")
    resp = await client.post("/v1/blockers", json=bad, headers=ctx.as_("approver"))
    assert resp.status_code == 422, resp.text
    attrs = await _attrs(ctx, entity_id)
    assert attrs["proposed_blocker"] == SUGGESTED and "blocker" not in attrs


async def test_an_intake_answer_is_accepted_then_promoted_with_one_action(client, fake):  # noqa: F811
    """End to end: the answer proposes the constraint with the mark, an approver accepts
    it, then promotes it with the pre-filled form unchanged."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    resp = await client.post(
        f"/v1/questions/{q.id}/answers",
        json={"kind": "answer", "body": INTAKE_ANSWER},
        headers=ctx.as_("author"),
    )
    assert resp.status_code == 201, resp.text
    await share(client, ctx, intake_id, str(gap.id), "full")
    async with tenant_session(ctx.tenant_id) as s:
        [proposal] = (await s.scalars(select(Proposal))).all()
    resp = await client.post(
        f"/v1/baseline/proposals/{proposal.id}/accept", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        [constraint] = (await s.scalars(select(Entity).where(Entity.type == "constraint"))).all()
    detail = (
        await client.get(f"/v1/baseline/entities/{constraint.id}", headers=ctx.as_("approver"))
    ).json()
    assert detail["attrs"]["proposed_blocker"]["status"] == "open"
    assert INTAKE_ANSWER in detail["body"]

    resp = await client.post("/v1/blockers", json=_form(detail), headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    assert resp.json()["blocker"]["statement"] == detail["title"]
    assert "proposed_blocker" not in await _attrs(ctx, constraint.id)
