"""Simple Definition of Done, item 5 (docs/simple-dod-ops.md): no Simple edit can leave the
data wrong, per operation of the change engine's own ops (oracle.simple.changes). Against
Postgres; the world of tests.test_simple_changes_api, plus the item's own milestone, owner
and decider ops.

Test cards (protects / fails_when / no_claim):

- test_every_op_records_who_and_when: protects=every op, applied or proposed, is a change
  row naming its author and the company's now, and listed in the history;
  fails_when=an op writes without a change row, or with the wrong author or time;
  no_claim=the history screen.
- test_every_op_undo_restores_exactly: protects=undoing an op puts back every stored
  column of every item it touched, exactly (dates and their source, risks, milestone,
  owner, decider, cut, draft), and reopens an accepted date suggestion; fails_when=an undo
  leaves any column changed; no_claim=undo of an accepted proposal.
- test_every_op_waits_in_the_working_draft: protects=an applied op is in the roadmap's
  working draft only: the published rows and a viewer's roadmap keep the old values until
  the decider submits and approves the draft, then show the new ones; fails_when=an op
  writes the published version; no_claim=required reviewers (test_simple_drafts_api).
- test_new_ops_role_matrix: protects=set_milestone, set_owner and set_decider follow the
  review policy: owner and decider apply, approver and commenter propose, viewer refused;
  fails_when=a role applies that may only propose or a viewer is let in;
  no_claim=the other ops (test_simple_changes_api.test_permission_matrix).
- test_every_op_refuses_viewers_and_runs: protects=every op the engine accepts (each
  ChangeOp) refuses a viewer and a call made for a run before it reads the body;
  fails_when=one op is let through; no_claim=which body each op needs.
- test_tenant_isolation: protects=another company's owner can neither change, accept,
  decline, withdraw nor undo this company's items and changes, nor name this company's
  people as owner or decider; fails_when=any of these lands or answers anything but
  not found / refused; no_claim=the web.
- test_constraint_flags_on_a_broken_date: protects=a move that breaks a dependency is
  applied (or proposed) with the dependent's red flag, its one-line reason and its fixes;
  fails_when=the flag, reason or fixes are missing; no_claim=the flags' wording.
"""

import typing
from datetime import datetime
from typing import Any

import pytest
from sqlalchemy import inspect, select

from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts
from oracle.simple.models import RoadmapDateSuggestion, SimpleChange
from oracle.simple.schemas import ChangeOp
from oracle.tenancy import tenant_session
from tests.coverage_helpers import run_headers
from tests.test_simple_changes_api import CHANGES, OPS, World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_roadmap_api import NOW

DRAFTS = "/v1/simple/drafts"
ROADMAP = "/v1/simple/roadmap"
MORE = ["set_milestone", "set_owner", "set_decider"]
ALL = [*OPS, *MORE]
SKIP = {"updated_at", "created_at"}


class DodWorld(World):
    async def build(self, *, decider: bool, track_owner: str | None = None, ops=OPS) -> World:
        self.ops = list(ops)
        return await super().build(decider=decider, track_owner=track_owner, ops=ops)

    def body(self, op: str, **over: Any) -> dict[str, Any]:
        if op == "reorder":
            over = {"before": {"position": self.ops.index(op) * 3}, **over}
        if op not in MORE:
            return super().body(op, **over)
        a = self.ids[f"{op}-a"]
        approver = str(self.ctx.users["approver"].id)
        bodies: dict[str, dict[str, Any]] = {
            "set_milestone": {"target": {"item_id": a}, "before": {"milestone": None},
                              "after": {"milestone": {"name": "Beta", "date": "2026-12-01"}}},
            "set_owner": {"target": {"item_id": a}, "before": {"owner_id": None},
                          "after": {"owner_id": approver}},
            "set_decider": {"target": {"item_id": a}, "before": {"decider_id": None},
                            "after": {"decider_id": approver}},
        }  # fmt: skip
        return {"op": op, **bodies[op], **over}


async def world(*, ops=ALL, decider: bool = True) -> DodWorld:
    ctx = await make_people()
    w = await DodWorld(ctx).build(decider=decider, ops=ops)
    if "restore" in ops:
        async with tenant_session(ctx.tenant_id) as s:
            (await s.get(RoadmapItem, w.ids["restore-a"])).cut = True
            await s.commit()
    return w


def columns(row: RoadmapItem) -> dict[str, Any]:
    return {
        a.key: getattr(row, a.key)
        for a in inspect(RoadmapItem).mapper.column_attrs
        if a.key not in SKIP
    }


async def snapshot(w: World, op: str, *, published: bool = False) -> dict[str, dict]:
    """Every stored column of the op's three items, as the working draft (or the
    published version) has them."""
    out = {}
    async with tenant_session(w.ctx.tenant_id) as s:
        for x in "abu":
            row = await s.get(RoadmapItem, w.ids[f"{op}-{x}"])
            out[x] = columns(row if published else await drafts.effective_row(s, row))
    return out


async def suggestion_status(w: World, op: str) -> str | None:
    sid = w.suggestion.get(f"{op}-u")
    if sid is None:
        return None
    async with tenant_session(w.ctx.tenant_id) as s:
        return (await s.get(RoadmapDateSuggestion, sid)).status


async def test_every_op_records_who_and_when(client):
    w = await world()
    for op in ALL:
        who = "owner" if ALL.index(op) % 2 else "commenter"
        r = await w.post(client, who, op)
        assert r.status_code == 201, (op, r.text)
        change = r.json()["change"]
        assert change["status"] == ("applied" if who == "owner" else "proposed"), op
        assert change["by"] == str(w.ctx.users[who].id), op
        assert datetime.fromisoformat(change["at"]) == NOW, op
        async with tenant_session(w.ctx.tenant_id) as s:
            row = await s.get(SimpleChange, change["id"])
            assert (row.op, row.by, row.at) == (op, w.ctx.users[who].id, NOW), op
    listed = (await client.get(CHANGES, headers=w.ctx.as_("owner"))).json()
    assert sorted(c["op"] for c in listed) == sorted(ALL)


@pytest.mark.parametrize("op", ALL)
async def test_every_op_undo_restores_exactly(client, op):
    w = await world(ops=[op])
    before = await snapshot(w, op)
    suggested = await suggestion_status(w, op)
    r = await w.post(client, "owner", op)
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "applied"
    assert await snapshot(w, op) != before, "the op changed nothing"
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=w.ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert await snapshot(w, op) == before
    assert await suggestion_status(w, op) == suggested


def unoffered(r, op: str) -> list[dict]:
    items = r.json()["items"]
    if op == "accept_date_suggestion":
        items = [{**i, "suggestion": None} for i in items]
    return items


async def the_draft(client, w: World) -> dict:
    rows = (await client.get(DRAFTS, headers=w.ctx.as_("owner"))).json()
    assert len(rows) == 1, rows
    return rows[0]


@pytest.mark.parametrize("op", ALL)
async def test_every_op_waits_in_the_working_draft(client, op):
    w = await world(ops=[op])
    published = await snapshot(w, op, published=True)
    seen = await client.get(ROADMAP, headers=w.ctx.as_("viewer"))
    r = await w.post(client, "decider", op)
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    assert len(r.json()["change"]["draft_ids"]) == 1
    working = await snapshot(w, op)
    assert working != published
    # Nothing published moved, and a viewer reads the roadmap as before.
    assert await snapshot(w, op, published=True) == published
    # (An accepted date suggestion is decided at once: it is no longer offered.)
    assert unoffered(await client.get(ROADMAP, headers=w.ctx.as_("viewer")), op) == unoffered(
        seen, op
    )
    # The review policy publishes it: submitted and approved by the decider.
    d = await the_draft(client, w)
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    if r.json()["status"] != "approved":
        r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
        assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
    view = await client.get(ROADMAP, headers=w.ctx.as_("viewer"))
    assert unoffered(view, op) != unoffered(seen, op)
    assert view.json()["changes_in_review"] == 0


@pytest.mark.parametrize("role", ["owner", "decider", "approver", "commenter", "viewer"])
async def test_new_ops_role_matrix(client, role):
    w = await world(ops=MORE)
    applies = role in ("owner", "decider")
    for op in MORE:
        before = await snapshot(w, op)
        r = await w.post(client, role, op)
        if role == "viewer":
            assert r.status_code == 403, (op, r.text)
        else:
            assert r.status_code == 201, (op, r.text)
            change = r.json()["change"]
            assert change["status"] == ("applied" if applies else "proposed"), op
            if not applies:
                assert change["routed_to"] == [str(w.ctx.users["decider"].id)], op
        assert (await snapshot(w, op) != before) is (applies and role != "viewer"), op


async def test_every_op_refuses_viewers_and_runs(client):
    w = await world(ops=["edit_title"])
    a = w.ids["edit_title-a"]
    run = await run_headers(w.ctx, "owner")
    before = await snapshot(w, "edit_title")
    for op in typing.get_args(ChangeOp):
        body = {"op": op, "target": {"item_id": a}, "before": {"title": "Edit_Title A"},
                "after": {"title": "Ledger v2"}}  # fmt: skip
        for headers in (w.ctx.as_("viewer"), run):
            r = await client.post(CHANGES, json=body, headers=headers)
            assert r.status_code == 403, (op, r.text)
    assert await snapshot(w, "edit_title") == before
    async with tenant_session(w.ctx.tenant_id) as s:
        assert list(await s.scalars(select(SimpleChange))) == []


async def test_tenant_isolation(client):
    w = await world(ops=["edit_title", "move_dates", "set_owner"])
    other = await make_people()
    before = await snapshot(w, "edit_title")
    # Another company's owner cannot reach this company's item.
    r = await client.post(CHANGES, json=w.body("edit_title"), headers=other.as_("owner"))
    assert r.status_code in (404, 422), r.text
    assert await snapshot(w, "edit_title") == before
    # Nor this company's changes: a proposal and an applied change.
    proposal = (await w.post(client, "commenter", "move_dates")).json()["change"]
    applied = (await w.post(client, "owner", "edit_title")).json()["change"]
    for action, change in (("accept", proposal), ("decline", proposal),
                           ("withdraw", proposal), ("undo", applied)):  # fmt: skip
        r = await client.post(f"{CHANGES}/{change['id']}/{action}", json={"reason": "No"},
                              headers=other.as_("owner"))  # fmt: skip
        assert r.status_code == 404, (action, r.text)
    async with tenant_session(w.ctx.tenant_id) as s:
        assert (await s.get(SimpleChange, proposal["id"])).status == "proposed"
        assert (await s.get(SimpleChange, applied["id"])).status == "applied"
    assert (await w.item("edit_title-a")).title == "Ledger v2"
    # Nor list them.
    assert (await client.get(CHANGES, headers=other.as_("owner"))).json() == []
    # An owner names someone of another company as an item's owner: refused.
    stranger = str(other.users["approver"].id)
    r = await w.post(client, "owner", "set_owner", after={"owner_id": stranger})
    assert r.status_code == 422, r.text
    assert (await w.item("set_owner-a")).owner_id is None


async def test_constraint_flags_on_a_broken_date(client):
    w = await world(ops=["move_dates"])
    b = w.ids["move_dates-b"]
    # move_dates-a ends after its dependent starts: applied, the dependent flagged red.
    later = {"start_date": "2026-10-01", "end_date": "2026-12-01"}
    for who, status in (("commenter", "proposed"), ("owner", "applied")):
        r = await w.post(client, who, "move_dates", after=later)
        assert r.status_code == 201, r.text
        out = r.json()
        assert out["change"]["status"] == status
        flags = {f["item_id"]: f["flags"] for f in out["flags"]}
        red = [f for f in flags[b] if f["kind"] == "dependency_order"]
        assert red, flags
        assert red[0]["state"] == "red" and red[0]["reason"]
        assert {"shift_dependents", "move_dependency"} <= set(red[0]["fixes"])
