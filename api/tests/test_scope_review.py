"""C7 Scope review, end to end against Postgres with the FakeRuntime: approvers decide,
edit, add and enhance the feature-set stop's rows; commenters suggest; approving applies
the edits without an agent round; Send back writes the structured review.

Test cards (protects / fails_when / no_claim):

- test_exclude_a_dependency_blocks_and_undo_restores: protects=every write re-checks the
  scope (criterion 1) and Undo restores the agent's values (criterion 9);
  fails_when=the tally or the dependent row's reason does not follow the write, or Undo
  leaves the row counted as an edit; no_claim=the reason texts.
- test_approve_refused_until_fixed_or_waived: protects=call c3 Blocking problems disable
  Approve at the feature set (criteria 2, 3); fails_when=approval passes with an open
  unwaived blocking reason, or an unknown key is waived; no_claim=the reason texts.
- test_goals_must_be_confirmed: protects=criterion 4; fails_when=a proposed goal is
  stored; no_claim=goal contributions' maths.
- test_commenter_suggests_only: protects=call c6 Commenters suggest, approvers stage
  (criterion 5); fails_when=a commenter's action changes a row, Accept leaves the action,
  or a stale decide passes; no_claim=notifications.
- test_writes_refused_when_stale_or_decided: protects=criterion 6; fails_when=a stale
  lock_version or a decided scope is written; no_claim=concurrency beyond the row lock.
- test_enhance_queues_the_job_and_accept_sets_the_row: protects=criterion 7 (the model
  gets only the listed fields); fails_when=other fields reach the model, or accepting does
  not set text and acceptance as the person's; no_claim=the model's enhancement quality.
- test_approve_with_edits_writes_baseline: protects=call c2 "Approve with edits" and
  decision B1 Baseline shape (criterion 8); fails_when=an edit is lost, a requirement is
  left unlocked or proposed, or a second approval is asked for; no_claim=the agents' own
  proposals (unchanged).
- test_send_back_lists_the_changed_rows: protects=criterion 10; fails_when=a changed row
  is missing from the review file or the checkpoint is not changes_requested;
  no_claim=how the agents use the file.
- test_only_added_requirements_are_removed: protects=DELETE is for person-added rows;
  fails_when=an agent row is deleted; no_claim=Cut (a PATCH).
- test_an_approvers_own_edit_and_add_apply_at_once: protects=call c6 (approvers stage
  all apply) and call c2 for a D8 edit or add an approver writes on the row key;
  fails_when=the action is kept as staged instead of changing the row, or Approve leaves
  the scope as the agents wrote it; no_claim=a commenter's suggestion (Accept applies it).
- test_send_back_carries_an_approvers_own_edit: protects=criterion 10 for a change made
  through a D8 edit; fails_when=Send back is accepted but its review file drops the change;
  no_claim=the note.
- test_a_staged_edit_left_over_is_not_something_to_send: protects=Send back needs a real
  change, a question or a note; fails_when=a staged edit or add (which Send back does not
  carry) counts as something to send; no_claim=staged waivers and questions.
- test_a_requirement_added_to_a_new_feature_is_part_of_it: protects=criteria 8 and 14 for
  a feature not in the baseline yet; fails_when=the added requirement has no part_of edge
  to its feature after Approve with edits; no_claim=confirming the new feature itself (it
  stays proposed for a person to confirm).
- test_capabilities_agree_with_the_scope_routes: protects=#370 for /v1/prd-scopes (#156
  fixes 1); fails_when=a commenter's or viewer's capabilities (can(): the operation and its
  per-item role) say yes to a write the API answers 403, or an approver's say no;
  no_claim=the D8 suggestions a commenter makes instead.
- test_each_reason_keeps_its_own_call: protects=a feature-set Keep per reason (two
  reasons, two calls); fails_when=keeping a second reason un-keeps the first, the feature
  stays under Needs you once every reason is answered, or Undo of one call drops the
  other; no_claim=waivers (they merge into one waiver).
- test_mcp_refuses_approval_while_a_reason_is_open: protects=criterion 2 on MCP;
  fails_when=decide_checkpoint approves with a person's exclusion leaving an open
  depends_on_excluded, or still refuses after the waiver; no_claim=the reason texts.
"""

import uuid

from sqlalchemy import select

from oracle.baseline.models import Edge, Entity, Proposal
from oracle.jobs import worker
from oracle.models import AuditEvent
from oracle.runs.models import Checkpoint, CheckpointAction
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import add_account, window
from tests.test_llm_jobs import FakeClaude
from tests.test_mcp import api_token, mcp_client, text_of
from tests.test_prd_scope import at_feature_set
from tests.test_runs import (  # noqa: F401 - fixtures
    as_user,
    get,
    owner,
    pending,
    runtime,
)


async def _open(client, owner, runtime):  # noqa: F811
    run = await at_feature_set(client, owner, runtime)
    cp = pending(run)
    resp = await client.get(f"/v1/runs/{run['id']}/scope", headers=owner[1])
    assert resp.status_code == 200, resp.text
    return run, cp, resp.json()["id"]


async def _read(client, headers, scope_id) -> dict:
    resp = await client.get(f"/v1/prd-scopes/{scope_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _row(scope: dict, key: str) -> dict:
    for f in scope["features"]:
        if f["key"] == key:
            return f
        for r in f["requirements"]:
            if r["key"] == key:
                return r
    raise AssertionError(key)


async def _patch(client, headers, scope_id, row, **body):
    return await client.patch(
        f"/v1/prd-scopes/{scope_id}/items/{row['id']}",
        json={"lock_version": row["lock_version"], **body},
        headers=headers,
    )


async def _decide(client, headers, run, cp, decision="approved", **extra):
    return await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": decision, **extra},
        headers=headers,
    )


async def _action(client, headers, run, cp, **body):
    return await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/actions", json=body, headers=headers
    )


async def test_exclude_a_dependency_blocks_and_undo_restores(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    scope = await _read(client, auth, scope_id)
    assert scope["summary"]["blocking"] == 0 and scope["summary"]["edits"] == 0
    # bulk-edit serves no confirmed goal and is new: it needs a person.
    assert scope["summary"]["needs_you"] == 1
    bulk = _row(scope, "bulk-edit")
    assert {r["code"] for r in bulk["reasons"]} == {"serves_no_goal", "new_feature"}

    lookup = _row(scope, "address-lookup")
    resp = await _patch(
        client, auth, scope_id, lookup, decision="exclude", decision_reason="not_now"
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["decision"] == "exclude" and out["edited"] is True
    assert out["summary"]["blocking"] == 1 and out["summary"]["edits"] == 1
    scope = await _read(client, auth, scope_id)
    saved = _row(scope, "saved-addresses")
    assert [r["code"] for r in saved["reasons"]] == ["depends_on_excluded"]
    assert saved["needs_you"] is True

    # Undo: the agent's values back, no longer an edit, the blocking reason gone.
    lookup = _row(scope, "address-lookup")
    assert lookup["history"]["original"]["decision"] == "include"
    resp = await _patch(client, auth, scope_id, lookup, revert=True)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["decision"] == "include" and out["edited"] is False
    assert out["summary"]["blocking"] == 0 and out["summary"]["edits"] == 0


async def test_approve_refused_until_fixed_or_waived(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    approver = await as_user(tenant_id, "approver")
    scope = await _read(client, approver, scope_id)
    resp = await _patch(
        client,
        approver,
        scope_id,
        _row(scope, "address-lookup"),
        decision="exclude",
        decision_reason="out_of_scope",
    )
    assert resp.status_code == 200, resp.text
    revision = resp.json()["revision"]

    resp = await _decide(client, approver, run, cp, expected_revision=revision)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["message"].startswith("1 blocking problem left")

    # An unknown key is never waived (criterion 3).
    resp = await _action(
        client,
        approver,
        run,
        cp,
        item_key="saved-addresses",
        kind="waive",
        answers=["unknown_feature"],
        value={"reason": "Fine"},
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "This cannot be waived; leave it out or send it back"

    resp = await _action(
        client,
        approver,
        run,
        cp,
        item_key="saved-addresses",
        kind="waive",
        answers=["depends_on_excluded"],
        value={"reason": "Ships behind a flag"},
    )
    assert resp.status_code == 200, resp.text
    draft = resp.json()
    assert draft["gate"]["open"] is True
    scope = await _read(client, approver, scope_id)
    assert scope["summary"]["blocking"] == 0
    resp = await _decide(client, approver, run, cp, expected_revision=draft["revision"])
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        event = await s.scalar(select(AuditEvent).where(AuditEvent.action == "prd_scope.approved"))
    assert event.data["waived"] == ["depends_on_excluded"]
    assert event.data["edits"] == 1


async def test_goals_must_be_confirmed(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    async with tenant_session(tenant_id) as s:
        goals = {e.key: e.id for e in await s.scalars(select(Entity).where(Entity.type == "goal"))}
    scope = await _read(client, auth, scope_id)
    assert [g["key"] for g in scope["goals_available"]] == ["activation"]
    bulk = _row(scope, "bulk-edit")
    resp = await _patch(
        client,
        auth,
        scope_id,
        bulk,
        goals=[{"goal_id": str(goals["retention"]), "contribution": 2}],
    )
    assert resp.status_code == 422, resp.text
    resp = await _patch(
        client,
        auth,
        scope_id,
        bulk,
        goals=[{"goal_id": str(goals["activation"]), "contribution": 2}],
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["goals"][0]["key"] == "activation"
    scope = await _read(client, auth, scope_id)
    assert "serves_no_goal" not in {r["code"] for r in _row(scope, "bulk-edit")["reasons"]}


async def test_commenter_suggests_only(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    commenter = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")
    scope = await _read(client, commenter, scope_id)
    assert scope["can_edit"] is False
    bulk = _row(scope, "bulk-edit")
    resp = await _patch(
        client, commenter, scope_id, bulk, decision="exclude", decision_reason="no_goal"
    )
    assert resp.status_code == 403, resp.text

    resp = await _action(
        client,
        commenter,
        run,
        cp,
        item_key="bulk-edit",
        kind="edit",
        field="decision",
        value={"decision": "exclude", "reason": "no_goal"},
    )
    assert resp.status_code == 200, resp.text
    draft = resp.json()
    (action,) = [a for i in draft["items"] for a in i["actions"]]
    assert action["state"] == "suggested"
    scope = await _read(client, approver, scope_id)
    assert _row(scope, "bulk-edit")["decision"] == "include"
    assert scope["summary"]["suggestions_open"] == 1
    stale = draft["revision"]

    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/actions/{action['id']}/stage",
        headers=approver,
    )
    assert resp.status_code == 200, resp.text
    draft = resp.json()
    assert [a for i in draft["items"] for a in i["actions"]] == []
    assert draft["revision"] > stale
    scope = await _read(client, approver, scope_id)
    row = _row(scope, "bulk-edit")
    assert (row["decision"], row["decision_reason"]) == ("exclude", "no_goal")
    assert row["history"]["decided_by_name"] is not None
    assert scope["summary"]["suggestions_open"] == 0

    # Every scope write bumps the revision: a decide with the old one is refused.
    resp = await _decide(client, approver, run, cp, expected_revision=stale)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "review_changed"


async def test_writes_refused_when_stale_or_decided(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    scope = await _read(client, auth, scope_id)
    pick = _row(scope, "saved-addresses-pick")
    resp = await _patch(client, auth, scope_id, pick, decision="cut")
    assert resp.status_code == 200, resp.text
    resp = await _patch(client, auth, scope_id, pick, decision="keep")  # the old lock_version
    assert resp.status_code == 409, resp.text
    scope = await _read(client, auth, scope_id)
    assert _row(scope, "saved-addresses-pick")["decision"] == "cut"

    resp = await _decide(client, auth, run, cp)
    assert resp.status_code == 200, resp.text
    row = _row(scope, "saved-addresses-pick")
    resp = await _patch(client, auth, scope_id, row, decision="keep")
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == "This feature set is already decided"
    resp = await client.post(
        f"/v1/prd-scopes/{scope_id}/items",
        json={"parent_id": _row(scope, "bulk-edit")["id"], "text": "Too late"},
        headers=auth,
    )
    assert resp.status_code == 409, resp.text
    scope = await _read(client, auth, scope_id)
    assert _row(scope, "saved-addresses-pick")["decision"] == "cut"
    assert _row(scope, "bulk-edit")["requirements"] == []


async def test_enhance_queues_the_job_and_accept_sets_the_row(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    scope = await _read(client, auth, scope_id)
    pick = _row(scope, "saved-addresses-pick")
    resp = await client.post(
        f"/v1/prd-scopes/{scope_id}/items/{pick['id']}/enhance", json={}, headers=auth
    )
    assert resp.status_code == 202, resp.text
    job = resp.json()
    assert job["kind"] == "scope_enhance" and job["scope_id"] == scope_id

    fake = FakeClaude()
    from oracle.llm import gateway

    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    try:
        await add_account(tenant_id, "personal", windows={"five_hour": window(0.2)})
        fake.script["scope_enhance"].append(
            {
                "text": "The buyer picks one of up to five saved addresses in one tap",
                "acceptance": ["Five at most", "One tap"],
                "edge_cases": ["No saved address"],
                "data_needs": ["Saved addresses"],
            }
        )
        await worker.run_pending(tenant_id)
    finally:
        gateway.set_transports(previous)
    kind, payload = fake.calls[0]
    assert kind == "scope_enhance"
    assert payload == {
        "feature": {
            "title": "Saved addresses",
            "summary": "Returning buyers pick a saved address at checkout",
        },
        "requirement": {
            "text": "The buyer picks one of up to five saved addresses",
            "acceptance": ["Five addresses at most", "The last used one is preselected"],
        },
        "goals": ["Activation"],
    }
    got = (await client.get(f"/v1/llm-jobs/{job['id']}", headers=auth)).json()
    assert got["status"] == "succeeded", got
    assert got["output"]["edge_cases"] == ["No saved address"]

    resp = await client.post(
        f"/v1/prd-scopes/{scope_id}/items/{pick['id']}/enhance/{job['id']}/accept",
        json={"text": "The buyer picks a saved address in one tap"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["text"] == "The buyer picks a saved address in one tap"
    assert out["acceptance"] == ["Five at most", "One tap"]
    assert out["origin"] == "person" and out["edited"] is True


async def test_approve_with_edits_writes_baseline(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    approver = await as_user(tenant_id, "approver")
    scope = await _read(client, approver, scope_id)
    saved = _row(scope, "saved-addresses")
    resp = await client.post(
        f"/v1/prd-scopes/{scope_id}/items",
        json={
            "parent_id": saved["id"],
            "text": "The buyer renames a saved address",
            "acceptance": ["Names up to 40 characters"],
        },
        headers=approver,
    )
    assert resp.status_code == 201, resp.text
    added = resp.json()
    assert added["origin"] == "person" and added["added"] is True
    assert added["key"] == "saved-addresses-the-buyer-renames-a-saved-address"
    # An existing baseline requirement, reworded.
    resp = await _patch(
        client,
        approver,
        scope_id,
        _row(scope, "address-lookup-postcode"),
        text="The buyer finds an address by postcode or street",
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        proposals_before = len(list(await s.scalars(select(Proposal))))

    resp = await _decide(client, approver, run, cp, expected_revision=resp.json()["revision"])
    assert resp.status_code == 200, resp.text
    run = await get(client, auth, run["id"])
    assert next(c for c in run["checkpoints"] if c["id"] == cp["id"])["status"] == "approved"

    async with tenant_session(tenant_id) as s:
        new = await s.scalar(select(Entity).where(Entity.key == added["key"]))
        feature = await s.scalar(select(Entity).where(Entity.key == "saved-addresses"))
        edge = await s.scalar(select(Edge).where(Edge.src_id == new.id))
        edited = await s.scalar(select(Entity).where(Entity.key == "address-lookup-postcode"))
        proposals_after = len(list(await s.scalars(select(Proposal))))
        event = await s.scalar(select(AuditEvent).where(AuditEvent.action == "prd_scope.approved"))
        decided = await s.get(Checkpoint, uuid.UUID(cp["id"]))
    assert (new.type, new.status, new.locked, new.origin) == (
        "requirement",
        "confirmed",
        True,
        "user",
    )
    assert new.title == "The buyer renames a saved address"
    assert new.attrs["feature"] == "saved-addresses"
    assert new.attrs["goals"] == ["activation"]
    assert new.attrs["acceptance"] == ["Names up to 40 characters"]
    assert new.attrs["from_scope"] == scope_id
    assert (edge.type, edge.dst_id) == ("part_of", feature.id)
    assert edited.body == "The buyer finds an address by postcode or street" and edited.locked
    assert proposals_after == proposals_before  # no baseline proposal from the edits
    assert event.data["edits"] == 2
    assert sorted(event.data["entities"]) == sorted([str(new.id), str(edited.id)])
    assert decided.status == "approved"
    # The next segment reads the approved scope with the added requirement.
    resp = await client.get(f"/v1/runs/{run['id']}/scope", headers=auth)
    reqs = [r["key"] for r in _row(resp.json(), "saved-addresses")["requirements"]]
    assert added["key"] in reqs


async def test_send_back_lists_the_changed_rows(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    scope = await _read(client, auth, scope_id)
    resp = await _patch(client, auth, scope_id, _row(scope, "bulk-edit"), decision="defer")
    assert resp.status_code == 200, resp.text
    resp = await _patch(
        client, auth, scope_id, _row(scope, "saved-addresses-default"), decision="cut"
    )
    assert resp.status_code == 200, resp.text
    resp = await _decide(client, auth, run, cp, "changes_requested", note="Tighten the set")
    assert resp.status_code == 200, resp.text
    run = await get(client, auth, run["id"])
    decided = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
    assert decided["status"] == "changes_requested"
    resp = await client.get(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/review.yaml", headers=auth
    )
    assert resp.status_code == 200, resp.text
    import yaml

    review = yaml.safe_load(resp.text)
    assert review["checkpoint"] == "feature_set"
    assert review["general_note"] == "Tighten the set"
    assert [(e["id"], e["action"]) for e in review["items"]] == [
        ("bulk-edit", "defer"),
        ("saved-addresses-default", "cut"),
    ]


async def test_only_added_requirements_are_removed(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    scope = await _read(client, auth, scope_id)
    pick = _row(scope, "saved-addresses-pick")
    resp = await client.delete(f"/v1/prd-scopes/{scope_id}/items/{pick['id']}", headers=auth)
    assert resp.status_code == 409, resp.text
    resp = await client.post(
        f"/v1/prd-scopes/{scope_id}/items",
        json={"parent_id": _row(scope, "bulk-edit")["id"], "text": "Edit ten rows at once"},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    added = resp.json()
    assert added["summary"]["edits"] == 1
    resp = await client.delete(f"/v1/prd-scopes/{scope_id}/items/{added['id']}", headers=auth)
    assert resp.status_code == 204, resp.text
    scope = await _read(client, auth, scope_id)
    assert _row(scope, "bulk-edit")["requirements"] == []
    assert scope["summary"]["edits"] == 0


async def test_an_approvers_own_edit_and_add_apply_at_once(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    approver = await as_user(tenant_id, "approver")
    resp = await _action(
        client,
        approver,
        run,
        cp,
        item_key="bulk-edit",
        kind="edit",
        field="decision",
        value={"decision": "exclude", "reason": "no_goal"},
    )
    assert resp.status_code == 200, resp.text
    assert [a for i in resp.json()["items"] for a in i["actions"]] == []
    resp = await _action(
        client,
        approver,
        run,
        cp,
        item_key="saved-addresses",
        kind="add",
        value={"parent": "saved-addresses", "text": "The buyer renames a saved address",
               "acceptance": ["Names up to 40 characters"]},
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    draft = resp.json()
    assert [a for i in draft["items"] for a in i["actions"]] == []
    scope = await _read(client, approver, scope_id)
    bulk = _row(scope, "bulk-edit")
    assert (bulk["decision"], bulk["decision_reason"]) == ("exclude", "no_goal")
    assert bulk["history"]["decided_by_name"] is not None
    (added,) = [r for r in _row(scope, "saved-addresses")["requirements"] if r["added"]]
    assert (added["text"], added["origin"]) == ("The buyer renames a saved address", "person")
    assert added["acceptance"] == ["Names up to 40 characters"]
    assert scope["summary"]["edits"] == 2

    resp = await _decide(client, approver, run, cp, expected_revision=draft["revision"])
    assert resp.status_code == 200, resp.text
    resp = await client.get(f"/v1/runs/{run['id']}/scope", headers=auth)
    out = resp.json()
    assert out["status"] == "approved"
    assert _row(out, "bulk-edit")["decision"] == "exclude"
    assert added["key"] in [r["key"] for r in _row(out, "saved-addresses")["requirements"]]
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(Entity).where(Entity.key == added["key"])) is not None


async def test_send_back_carries_an_approvers_own_edit(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run, cp, _ = await _open(client, owner, runtime)
    approver = await as_user(tenant_id, "approver")
    resp = await _action(
        client,
        approver,
        run,
        cp,
        item_key="bulk-edit",
        kind="edit",
        field="decision",
        value={"decision": "defer"},
    )
    assert resp.status_code == 200, resp.text
    resp = await _decide(client, approver, run, cp, "changes_requested")
    assert resp.status_code == 200, resp.text
    resp = await client.get(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/review.yaml", headers=auth
    )
    assert resp.status_code == 200, resp.text
    import yaml

    review = yaml.safe_load(resp.text)
    assert [(e["id"], e["action"]) for e in review["items"]] == [("bulk-edit", "defer")]


async def test_a_staged_edit_left_over_is_not_something_to_send(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    # Staged edit and add actions as an earlier build stored them: Send back does not
    # carry them, so they are not something to send.
    async with tenant_session(tenant_id) as s:
        s.add(CheckpointAction(checkpoint_id=uuid.UUID(cp["id"]), item_key="bulk-edit",
                               kind="edit", field="decision", value={"decision": "defer"},
                               state="staged"))  # fmt: skip
        s.add(CheckpointAction(checkpoint_id=uuid.UUID(cp["id"]), item_key="saved-addresses",
                               kind="add", value={"text": "Rename"}, state="staged"))  # fmt: skip
        await s.commit()
    resp = await _decide(client, auth, run, cp, "changes_requested")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "Stage a change, ask a question, or write a note to send back."
    run = await get(client, auth, run["id"])
    assert pending(run)["id"] == cp["id"]


async def test_a_requirement_added_to_a_new_feature_is_part_of_it(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    approver = await as_user(tenant_id, "approver")
    scope = await _read(client, approver, scope_id)
    bulk = _row(scope, "bulk-edit")
    assert bulk["entity_id"] is None  # new: not in the baseline yet
    resp = await client.post(
        f"/v1/prd-scopes/{scope_id}/items",
        json={"parent_id": bulk["id"], "text": "Edit ten rows at once"},
        headers=approver,
    )
    assert resp.status_code == 201, resp.text
    added = resp.json()
    resp = await _decide(client, approver, run, cp, expected_revision=added["revision"])
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        new = await s.scalar(select(Entity).where(Entity.key == added["key"]))
        feature = await s.scalar(
            select(Entity).where(Entity.type == "feature", Entity.key == "bulk-edit")
        )
        edge = await s.scalar(select(Edge).where(Edge.src_id == new.id))
    assert (new.status, new.locked) == ("confirmed", True)
    assert feature is not None
    # The feature itself is still the agents' proposal for a person to confirm.
    assert (feature.status, feature.locked, feature.origin) == ("proposed", False, "agent")
    assert edge is not None and (edge.type, edge.dst_id) == ("part_of", feature.id)


async def test_mcp_refuses_approval_while_a_reason_is_open(client, owner, runtime):  # noqa: F811
    tenant_id, _ = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    approver = await as_user(tenant_id, "approver")
    scope = await _read(client, approver, scope_id)
    resp = await _patch(client, approver, scope_id, _row(scope, "address-lookup"),
                        decision="exclude", decision_reason="out_of_scope")  # fmt: skip
    assert resp.status_code == 200, resp.text
    args = {"run_id": run["id"], "checkpoint_id": cp["id"], "body": {"decision": "approved"}}
    async with mcp_client(await api_token(tenant_id)) as c:
        out = await c.call_tool("decide_checkpoint", args)
        assert out.is_error, text_of(out)
        assert "1 blocking problem left" in text_of(out)
        assert "blocking_open" in text_of(out)
    scope = await _read(client, approver, scope_id)
    assert scope["status"] == "proposed"
    resp = await _action(client, approver, run, cp, item_key="saved-addresses", kind="waive",
                         answers=["depends_on_excluded"],
                         value={"reason": "Ships behind a flag"})  # fmt: skip
    assert resp.status_code == 200, resp.text
    async with mcp_client(await api_token(tenant_id)) as c:
        out = await c.call_tool("decide_checkpoint", args)
        assert not out.is_error, text_of(out)
    async with tenant_session(tenant_id) as s:
        event = await s.scalar(select(AuditEvent).where(AuditEvent.action == "prd_scope.approved"))
    assert event.data["waived"] == ["depends_on_excluded"]


SCOPE_WRITES = (
    "patch_scope_item",
    "add_scope_requirement",
    "delete_scope_item",
    "enhance_scope_requirement",
    "accept_scope_enhancement",
)


async def test_capabilities_agree_with_the_scope_routes(client, owner, runtime):  # noqa: F811
    """What GET /v1/me/capabilities tells the web app's can() matches what the scope routes
    answer: every member reads, the checkpoint's approver role (approver) writes."""
    from oracle.auth.models import ROLES

    tenant_id, _ = owner
    _, _, scope_id = await _open(client, owner, runtime)
    for role in ("viewer", "commenter", "approver"):
        headers = await as_user(tenant_id, role)
        resp = await client.get("/v1/me/capabilities", headers=headers)
        assert resp.status_code == 200, resp.text
        caps = resp.json()
        assert caps["operations"]["get_prd_scope_review"] is True
        assert "get_prd_scope_review" not in caps["per_item"]
        scope = await _read(client, headers, scope_id)
        writes = role == "approver"
        for op in SCOPE_WRITES:
            need = caps["per_item"].get(op, "missing")
            assert need == "approver", (op, need)
            can = caps["operations"][op] and ROLES.index(role) >= ROLES.index(need)
            assert can is writes, (role, op)
        bulk = _row(scope, "bulk-edit")
        if not writes:
            resp = await _patch(client, headers, scope_id, bulk, decision="exclude")
            assert resp.status_code == 403, resp.text
        resp = await client.post(
            f"/v1/prd-scopes/{scope_id}/items",
            json={"parent_id": bulk["id"], "text": "Exports the edited rows as a file"},
            headers=headers,
        )
        assert (resp.status_code == 201) is writes, resp.text
        assert (resp.status_code == 403) is not writes, resp.text


async def test_each_reason_keeps_its_own_call(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run, cp, scope_id = await _open(client, owner, runtime)
    scope = await _read(client, auth, scope_id)
    handled = scope["summary"]["handled"]
    for code in ("serves_no_goal", "new_feature"):
        resp = await _action(
            client, auth, run, cp, item_key="bulk-edit", kind="accept", answers=[code]
        )
        assert resp.status_code == 200, resp.text
    scope = await _read(client, auth, scope_id)
    bulk = _row(scope, "bulk-edit")
    assert {r["code"]: r["answered"] for r in bulk["reasons"]} == {
        "serves_no_goal": True,
        "new_feature": True,
    }
    assert bulk["needs_you"] is False
    assert scope["summary"]["handled"] == handled + 1 and scope["summary"]["needs_you"] == 0

    # Each call is its own action: undoing one keeps the other.
    draft = (
        await client.get(f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/review", headers=auth)
    ).json()
    keeps = [
        a
        for i in draft["items"]
        if i["key"] == "bulk-edit"
        for a in i["actions"]
        if a["kind"] == "accept"
    ]
    assert sorted(a["answers"][0] for a in keeps) == ["new_feature", "serves_no_goal"]
    first = next(a for a in keeps if a["answers"] == ["serves_no_goal"])
    resp = await client.delete(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/actions/{first['id']}", headers=auth
    )
    assert resp.status_code in (200, 204), resp.text
    bulk = _row(await _read(client, auth, scope_id), "bulk-edit")
    assert {r["code"]: r["answered"] for r in bulk["reasons"]} == {
        "serves_no_goal": False,
        "new_feature": True,
    }
