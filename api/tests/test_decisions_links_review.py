"""#570 review: Edit sends a decision's linked items and evidence back as the editor read
them, so a link whose baseline item or evidence row is gone, or which the editor may not
see (a hidden decision's baseline entity), must neither block the save nor be dropped by
it, and must not be read back to someone who may not see it. Against Postgres.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

import uuid

import pytest

from oracle.quality.models import OutcomeRecord
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import make_entity, make_evidence
from tests.decision_helpers import clock, decide, in_days, propose  # noqa: F401 (clock: autouse)
from tests.pricing_helpers import approved_memo


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture(autouse=True)
def runtime():
    """The local runtime (the pricing memo's run)."""
    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


async def _edit(client, ctx, d: dict, who: str, **fields) -> dict:
    """Edit as the form does: the lists as read back, the title changed."""
    resp = await client.patch(
        f"/v1/decisions/{d['number']}",
        json={
            "lock_version": d["lock_version"],
            "title": "Ship usage caps first",
            "entity_ids": d["entity_ids"],
            "evidence_ids": d["evidence_ids"],
            "subjects": d["subjects"],
            **fields,
        },
        headers=ctx.as_(who),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _read(client, ctx, d: dict, who: str) -> dict:
    resp = await client.get(f"/v1/decisions/{d['number']}", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_an_edit_saves_after_a_linked_item_is_deleted(client, ctx):
    """protects=once a linked baseline item is deleted, the decision no longer reads back its
    id and a title-only edit saves, keeping the other link; fails_when=the edit is refused
    with "unknown entity_ids" or the gone id is read back; no_claim=the web form (the mock
    spec covers what it sends)."""
    goal = await make_entity(ctx, "goal", "fewer-spend-incidents")
    risk = await make_entity(ctx, "risk", "partner-api-quota")
    d = await propose(client, ctx, entity_ids=[str(goal), str(risk)])
    resp = await client.delete(f"/v1/baseline/entities/{risk}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text
    d = await _read(client, ctx, d, "commenter")
    assert d["entity_ids"] == [str(goal)]
    out = await _edit(client, ctx, d, "commenter")
    assert out["title"] == "Ship usage caps first"
    assert [e["id"] for e in out["entities"]] == [str(goal)]
    assert str(risk) not in str(out)


async def test_an_edit_saves_after_a_linked_evidence_row_is_removed(client, ctx):
    """protects=once evidence a decision rests on is removed, the decision no longer reads
    back its id and a title-only edit saves; fails_when=the edit is refused with "unknown
    evidence_ids" (an id the form cannot show, so cannot remove) or the gone id is read
    back; no_claim=evidence an option cites (its own list)."""
    risk = await make_entity(ctx, "risk", "partner-api-quota")
    kept = await make_evidence(ctx, risk, excerpt="Requests above 100 a minute receive 429.")
    gone = await make_evidence(ctx, risk, excerpt="Bursts are allowed for ten seconds.")
    d = await propose(client, ctx, entity_ids=[str(risk)], evidence_ids=[str(kept), str(gone)])
    resp = await client.delete(f"/v1/baseline/evidence/{gone}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text
    d = await _read(client, ctx, d, "commenter")
    assert d["evidence_ids"] == [str(kept)]
    out = await _edit(client, ctx, d, "commenter")
    assert out["title"] == "Ship usage caps first"
    assert [e["id"] for e in out["evidence"]] == [str(kept)]
    assert str(gone) not in str(out)


async def _hidden_entity(client, ctx) -> str:
    """A decided pricing decision's baseline entity: owners and approvers only."""
    slug = await approved_memo(client, ctx)
    owner = ctx.as_("owner")
    d = (await client.post(f"/v1/pricing-memos/{slug}/decide", headers=owner)).json()
    resp = await client.post(
        f"/v1/decisions/{d['number']}/decide",
        json={
            "option_key": "flat-team",
            "rationale": "Teams ask for one price.",
            "reversibility": "reversible",
            "expected_outcome": "More teams pick the Team plan.",
        },
        headers=owner,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["entity_id"]


async def test_a_commenters_edit_keeps_a_link_they_cannot_see(client, ctx):
    """protects=an approver links a hidden decision's baseline entity to a commenter's
    proposal; the commenter reads neither the entity nor its id, their title-only edit
    saves, and the approver still reads the link afterwards; a commenter removing a link
    they see still removes it; fails_when=the commenter's save is refused ("unknown
    entity_ids"), drops the hidden link, or the commenter reads the hidden id or title;
    no_claim=a viewer (who does not edit)."""
    goal = await make_entity(ctx, "goal", "fewer-spend-incidents")
    # Proposed first: a commenter's next number does not see the hidden decision's.
    d = await propose(client, ctx, entity_ids=[str(goal)])
    hidden = await _hidden_entity(client, ctx)
    d = await _edit(client, ctx, d, "approver", entity_ids=[str(goal), hidden])
    assert [e["id"] for e in d["entities"]] == [str(goal), hidden]

    mine = await _read(client, ctx, d, "commenter")
    assert mine["entity_ids"] == [str(goal)]
    assert [e["id"] for e in mine["entities"]] == [str(goal)]
    assert hidden not in str(mine)
    out = await _edit(client, ctx, mine, "commenter")
    assert out["title"] == "Ship usage caps first"
    assert hidden not in str(out)
    theirs = await _read(client, ctx, d, "approver")
    assert [e["id"] for e in theirs["entities"]] == [str(goal), hidden]

    out = await _edit(client, ctx, out, "commenter", entity_ids=[])
    assert out["entity_ids"] == []
    theirs = await _read(client, ctx, d, "approver")
    assert theirs["entity_ids"] == [hidden]


async def test_the_outcome_reads_check_due_once_an_assessment_is_proposed(client, ctx):
    """protects=a decided decision's outcome reads check due once its tracking record has a
    proposed assessment, as the Outcomes tab's "Check due", and not before; fails_when=the
    inspector can only say "Measuring" for it; no_claim=how an assessment is proposed (H3)."""
    goal = await make_entity(ctx, "goal", "fewer-spend-incidents")
    d = await propose(client, ctx)
    prediction = {
        "goal_id": str(goal),
        "metric": "spend incidents per month",
        "baseline": "6",
        "predicted": "2",
        "threshold": "3",
        "by": in_days(100),
    }
    out = await decide(client, ctx, d["number"], prediction=prediction)
    assert (out["outcome_status"], out["outcome_check_due"]) == ("tracking", False)
    async with tenant_session(ctx.tenant_id) as s:
        record = await s.get(OutcomeRecord, uuid.UUID(out["outcome_id"]))
        record.proposed_assessment = {"verdict": "held", "observed": "2", "note": None}
        await s.commit()
    out = await _read(client, ctx, d, "viewer")
    assert (out["outcome_status"], out["outcome_check_due"]) == ("tracking", True)
