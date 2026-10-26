"""G3's waiting kinds switched on, and H1's ``decision`` change: Ask (C2 questions, D8 at a
checkpoint item), scope changes staged at the feature-set stop (C6, C7), priority moves and
pins applied through C9 with its pushback, and a decision proposed into the log (H1).

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

import uuid

from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.discussions import kinds
from oracle.discussions.models import CHANGE_KINDS, SUBJECT_KINDS, DiscussionChange
from oracle.priorities.models import PriorityOverride
from oracle.runs.models import CheckpointAction
from oracle.tenancy import tenant_session
from oracle.v2.models import StakeholderQuestion
from tests.baseline_helpers import entity, make_ctx
from tests.test_checkpoint_review import Review, review  # noqa: F401 - fixtures
from tests.test_discussion_changes import _tenant, act, add_change, item_discussion, listed
from tests.test_discussions import company, section, start, uid
from tests.test_prd_scope import at_feature_set
from tests.test_priority_overrides import _baseline
from tests.test_runs import as_user, owner, pending, runtime  # noqa: F401 - fixtures


# protects=every kind is available now, each on G3's subjects with its verb and role, and
# decision is one of them; fails_when=a kind stays switched off or decision lands under the
# wrong role; no_claim=the acts themselves (below).
def test_every_kind_is_available_and_decision_is_proposed_by_commenters():
    assert "decision" in CHANGE_KINDS
    for name, k in kinds.REGISTRY.items():
        assert k.available(None), name
    d = kinds.REGISTRY["decision"]
    assert (d.verb, d.role) == ("Propose", "commenter")
    assert set(d.subjects) == set(SUBJECT_KINDS)
    assert (kinds.REGISTRY["ask_person"].verb, kinds.REGISTRY["ask_person"].role) == (
        "Ask", "commenter")  # fmt: skip
    assert kinds.REGISTRY["priority_move"].verb == "Apply"
    assert "priority_pin" in kinds.available_for("priorities")
    assert "scope_feature" in kinds.available_for("checkpoint_item")
    assert kinds.validate_payload("decision", {"title": "Ship caps first"}) == {
        "title": "Ship caps first", "options": [], "reversibility": "reversible"}  # fmt: skip
    assert kinds.label("decision", {"title": "Ship caps first"}) == "Decide: Ship caps first"


# protects=Ask creates the question asked of that person through C2 (commenters and up) and
# ends the change done; fails_when=no question is made, a viewer asks, or the change stays
# open; no_claim=the Inbox row (C2's).
async def test_ask_a_person_creates_their_question(client):
    ctx, _doc = await company(client)
    _tenant[0] = ctx.tenant_id
    goal = await entity(client, ctx, type="goal", key="activation", title="Raise activation")
    d = await start(client, ctx, subject_kind="entity", subject={"entity_id": goal["id"]},
                    title="Who owns activation")  # fmt: skip
    cid = await add_change(ctx.tenant_id, d["id"], "ask_person",
                           {"asked_to": uid(ctx, "approver"),
                            "prompt": "Who owns the activation goal?"})  # fmt: skip
    [row] = await listed(client, ctx.as_("commenter"), d["id"])
    assert row["action"] == {"verb": "Ask", "allowed": True, "why_not": None}
    assert row["label"] == "Ask Approver: Who owns the activation goal?"
    await act(client, ctx.as_("viewer"), cid, "ask", expect=403)
    out = await act(client, ctx.as_("commenter"), cid, "ask")
    assert out["change"]["status"] == "done"
    qid = out["result"]["question_id"]
    async with tenant_session(ctx.tenant_id) as s:
        q = await s.get(StakeholderQuestion, uuid.UUID(qid))
        assert q.asked_to == ctx.users["approver"].id and q.status == "asked"
        assert str(q.entity_id) == goal["id"] and q.prompt == "Who owns the activation goal?"
    await act(client, ctx.as_("commenter"), cid, "ask", expect=409)


# protects=on a checkpoint item Ask is the item's D8 question action (G4), which asks through
# C2; fails_when=the question is not on the item; no_claim=the review screen's display.
async def test_ask_on_a_checkpoint_item_is_a_question_action(review):  # noqa: F811
    rv = review
    _tenant[0] = rv.tenant_id
    d_id = await item_discussion(rv)
    cid = await add_change(rv.tenant_id, d_id, "ask_person",
                           {"asked_to": rv.id("approver"), "prompt": "Is push ready?"})  # fmt: skip
    out = await act(rv.client, rv.h("commenter"), cid, "ask")
    assert out["change"]["status"] == "done"
    async with tenant_session(rv.tenant_id) as s:
        [action] = list(await s.scalars(select(CheckpointAction)))
        assert (action.kind, action.item_key) == ("question", "mobile-push")
        assert str(action.question_id) == out["result"]["question_id"]


# protects=a scope change from a discussion is staged as the feature-set stop's D8 action on
# the scope's row (C6, C7), named by the feature's id; commenters suggest, approvers stage;
# fails_when=the row key is not found or a commenter stages; no_claim=what Approve does with
# the staged action (C7's tests).
async def test_scope_feature_is_staged_at_the_feature_set_stop(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    _tenant[0] = tenant_id
    run = await at_feature_set(client, owner, runtime)
    cp = pending(run)
    scope = (await client.get(f"/v1/runs/{run['id']}/scope", headers=auth)).json()
    bulk = next(f for f in scope["features"] if f["key"] == "bulk-edit")
    resp = await client.post(
        "/v1/discussions",
        json={"subject_kind": "checkpoint_item", "title": "Bulk edit",
              "subject": {"run_id": run["id"], "checkpoint_id": cp["id"],
                          "checkpoint_kind": "feature_set", "item_key": "bulk-edit"}},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    d_id = resp.json()["id"]
    cid = await add_change(tenant_id, d_id, "scope_feature",
                           {"feature_id": bulk["id"], "decision": "exclude",
                            "reason": "No goal needs it"})  # fmt: skip
    commenter = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")
    await act(client, commenter, cid, "stage", expect=403)
    out = await act(client, approver, cid, "stage")
    assert out["change"]["status"] == "staged"
    async with tenant_session(tenant_id) as s:
        [action] = list(await s.scalars(select(CheckpointAction)))
        assert (action.item_key, action.kind, action.field) == ("bulk-edit", "edit", "decision")
        assert action.state == "staged" and str(action.discussion_change_id) == cid


# protects=Apply creates C9's override (approvers only); C9's pushback comes first as 409
# with nothing stored and the change open, and keeping it needs confirm with a reason;
# fails_when=a contradicting move is stored unasked, a commenter applies, or the change
# does not end done with the override; no_claim=the reason check's model (no account here).
async def test_apply_a_priority_move_shows_c9_pushback_first(client):
    ctx = await make_ctx()
    _tenant[0] = ctx.tenant_id
    ids = await _baseline(ctx)
    d = await start(client, ctx, subject_kind="priorities", subject={}, title="Order")
    cid = await add_change(ctx.tenant_id, d["id"], "priority_move",
                           {"feature_id": str(ids["bulk-edit"]),
                            "above_feature_id": str(ids["usage-alerts"]),
                            "reason": "Sales asked for it this quarter"})  # fmt: skip
    [row] = await listed(client, ctx.as_("approver"), d["id"])
    assert row["label"] == "Move Bulk edit above Usage alerts: Sales asked for it this quarter"
    await act(client, ctx.as_("commenter"), cid, "apply", expect=403)
    pushed = await act(client, ctx.as_("approver"), cid, "apply", expect=409)
    assert "no_confirmed_goal" in [m["code"] for m in pushed["pushback"]]
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(PriorityOverride))).all() == []
        assert (await s.get(DiscussionChange, uuid.UUID(cid))).status == "proposed"
    out = await act(client, ctx.as_("approver"), cid, "apply", confirm=True,
                    reason="A launch partner needs it first")  # fmt: skip
    assert out["change"]["status"] == "done"
    async with tenant_session(ctx.tenant_id) as s:
        o = await s.get(PriorityOverride, uuid.UUID(out["result"]["override_id"]))
        assert o.kind == "move" and o.reason == "A launch partner needs it first"


# protects=a pin with no contradiction is applied at once; fails_when=it asks again or the
# override is not a pin; no_claim=the ranking's reading.
async def test_apply_a_priority_pin(client):
    ctx = await make_ctx()
    _tenant[0] = ctx.tenant_id
    ids = await _baseline(ctx)
    d = await start(client, ctx, subject_kind="priorities", subject={}, title="Order")
    cid = await add_change(ctx.tenant_id, d["id"], "priority_pin",
                           {"feature_id": str(ids["saved-addresses"]), "position": 1,
                            "reason": "Committed to the launch partner"})  # fmt: skip
    out = await act(client, ctx.as_("approver"), cid, "apply")
    assert out["change"]["status"] == "done"
    async with tenant_session(ctx.tenant_id) as s:
        o = await s.get(PriorityOverride, uuid.UUID(out["result"]["override_id"]))
        assert (o.kind, o.position) == ("pin", 1)


# protects=H1's entry point: a discussion's decision change lands as a proposed decision in
# the log, with the discussion as a subject and the named approver; a commenter must name
# who decides, an approver who names nobody decides it; fails_when=no decision, a decided
# one, or a decision without its discussion; no_claim=deciding it (H1's tests).
async def test_a_decision_change_lands_as_a_proposed_decision(client):
    ctx, doc = await company(client)
    _tenant[0] = ctx.tenant_id
    d = await start(client, ctx, subject=section(doc), title="Caps or detection")
    payload = {"title": "Ship usage caps before detection", "question": "Which goes first?",
               "options": [{"key": "caps", "label": "Caps first"},
                           {"key": "detection", "label": "Detection first"}],
               "approver_id": uid(ctx, "approver")}  # fmt: skip
    cid = await add_change(ctx.tenant_id, d["id"], "decision", payload)
    await act(client, ctx.as_("viewer"), cid, "propose", expect=403)
    out = await act(client, ctx.as_("commenter"), cid, "propose")
    assert out["change"]["status"] == "done"
    assert out["result"]["number"].startswith("D-")
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Decision, uuid.UUID(out["result"]["decision_id"]))
        assert row.status == "proposed" and row.approver_id == ctx.users["approver"].id
        assert [o["key"] for o in row.options] == ["caps", "detection"]
        assert {"kind": "discussion", "id": d["id"]}.items() <= row.subjects[0].items()
        assert "Caps or detection" in (row.context or "")

    nobody = await add_change(ctx.tenant_id, d["id"], "decision", {"title": "Drop the trial"})
    refused = await act(client, ctx.as_("commenter"), nobody, "propose", expect=422)
    assert refused["detail"] == "Choose who decides it"
    out = await act(client, ctx.as_("approver"), nobody, "propose")
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Decision, uuid.UUID(out["result"]["decision_id"]))
        assert row.approver_id == ctx.users["approver"].id


# protects=a decision written by hand: a commenter's is their suggestion, and the kind is
# offered on the subject; fails_when=Propose a change does not list decision;
# no_claim=the web form.
async def test_decision_is_offered_and_written_by_hand(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    resp = await client.get(f"/v1/discussions/{d['id']}/change-kinds",
                            headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    offered = {k["kind"]: k["verb"] for k in resp.json()}
    assert offered["decision"] == "Propose" and offered["ask_person"] == "Ask"
    resp = await client.post(
        f"/v1/discussions/{d['id']}/changes",
        json={
            "kind": "decision",
            "payload": {"title": "Ship caps first"},
            "rationale": "We agreed",
        },  # fmt: skip
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["change"]["status"] == "suggested"


# protects=#585 review: Ask's D8 question action on a waiting stop comes from the discussion
# (its change and discussion named), and the change stays done when the stop is decided;
# fails_when=the action shows as a plain row action, or deciding the stop turns the done
# change back to suggested; no_claim=the review screen's display.
async def test_ask_at_a_checkpoint_item_is_linked_to_the_change(review):  # noqa: F811
    rv = review
    _tenant[0] = rv.tenant_id
    d_id = await item_discussion(rv)
    cid = await add_change(rv.tenant_id, d_id, "ask_person",
                           {"asked_to": rv.id("approver"), "prompt": "Is push ready?"})  # fmt: skip
    await act(rv.client, rv.h("commenter"), cid, "ask")
    async with tenant_session(rv.tenant_id) as s:
        [action] = list(await s.scalars(select(CheckpointAction)))
        assert action.origin == "discussion"
        assert (str(action.discussion_id), str(action.discussion_change_id)) == (d_id, cid)
        from oracle.runs.models import Checkpoint
        from oracle.staging import hooks

        await hooks.decided(s, await s.get(Checkpoint, action.checkpoint_id), "approved")
        assert (await s.get(DiscussionChange, uuid.UUID(cid))).status == "done"


# protects=#585 review: keeping a move Oracle pushed back on needs a new reason, as on the
# Priorities screen and in the mock; fails_when=confirm with no reason keeps the move on the
# reason Oracle pushed back on; no_claim=the reason check's model.
async def test_keeping_a_pushed_back_move_needs_a_reason(client):
    ctx = await make_ctx()
    _tenant[0] = ctx.tenant_id
    ids = await _baseline(ctx)
    d = await start(client, ctx, subject_kind="priorities", subject={}, title="Order")
    cid = await add_change(ctx.tenant_id, d["id"], "priority_move",
                           {"feature_id": str(ids["bulk-edit"]),
                            "above_feature_id": str(ids["usage-alerts"]),
                            "reason": "Sales asked for it this quarter"})  # fmt: skip
    await act(client, ctx.as_("approver"), cid, "apply", expect=409)
    refused = await act(client, ctx.as_("approver"), cid, "apply", confirm=True, expect=422)
    assert refused["detail"] == "Say why you apply it anyway"
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(PriorityOverride))).all() == []
        assert (await s.get(DiscussionChange, uuid.UUID(cid))).status == "proposed"


# protects=#585 review: a scope requirement naming a requirement or feature that does not
# exist is refused when it is written, not at Stage; fails_when=it is stored;
# no_claim=Stage's own check (it stays).
async def test_a_scope_requirement_must_name_what_exists(client):
    ctx = await make_ctx()
    goal = await entity(client, ctx, type="goal", key="activation", title="Raise activation")
    d = await start(client, ctx, subject_kind="entity", subject={"entity_id": goal["id"]},
                    title="Scope")  # fmt: skip
    missing = str(uuid.uuid4())
    for payload in ({"op": "cut", "requirement_id": missing},
                    {"op": "add", "feature_id": missing, "text": "Export a CSV"}):  # fmt: skip
        resp = await client.post(f"/v1/discussions/{d['id']}/changes",
                                 json={"kind": "scope_requirement", "payload": payload},
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "The change's target is not there"
