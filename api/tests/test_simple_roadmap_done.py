"""roadmap-done (owner, Nov 4): a Done or shipped roadmap item leaves the plan. Every check
skips it and a dependency on it is satisfied, so it raises no broken link and no count
(the roadmap's Needs a decision, Home, the side menu and "Walk me through it" all count the
read's red flags). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_done_item_is_not_checked: protects=a done item gets no flag of its own, a dependency
  on a done item is never "starts before what it depends on ends", and a cut item a done item
  depends on is not "Cut, but X depends on it"; fails_when=any of those flags is raised;
  no_claim=the web.
- test_shipped_dependency_clears_the_link: protects=marking the dependency shipped clears
  its dependent's order link in the read and in the walk; fails_when=the link or the walk
  step stays; no_claim=the web.
- test_shipped_dependent_clears_the_cut_flag: protects=a cut item whose only dependent is
  shipped has no cut flag; fails_when=the flag stays; no_claim=the web.
"""

import uuid
from datetime import date

import pytest

from oracle import company_time
from oracle.roadmap.models import RoadmapItem
from oracle.simple import constraints
from oracle.simple.dates import Dated
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import World, make_people
from tests.test_simple_roadmap_api import NOW

ROADMAP = "/v1/simple/roadmap"
WALK = "/v1/simple/walk"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def _d(day: date) -> Dated:
    return Dated(day, "typed", False)


def _node(id_: str, start: date, end: date, **kw) -> constraints.Node:
    return constraints.Node(id=id_, title=id_.title(), start=_d(start), end=_d(end), **kw)


def test_done_item_is_not_checked():
    alpha = _node("alpha", date(2026, 11, 1), date(2026, 12, 11), status="done")
    beta = _node("beta", date(2026, 11, 13), date(2026, 12, 20), depends_on=["alpha"])
    flags = constraints.check([alpha, beta])
    assert flags["beta"] == []
    # A done item's own checks are skipped too: its order, its milestone, its blockers.
    vendor = constraints.Blocker("x", "Vendor", date(2026, 12, 5), True)
    ms = ("Beta", date(2026, 12, 1))
    late = _node("gamma", date(2026, 11, 2), date(2027, 1, 30), depends_on=["beta"],
                 status="done", milestone=ms, blockers=[vendor])  # fmt: skip
    flags = constraints.check([beta, late])
    assert flags["gamma"] == []
    # A cut item only a done item depends on leaves nothing to decide.
    cut = _node("delta", date(2026, 11, 1), date(2026, 11, 20), status="cut")
    shipped = _node("echo", date(2026, 12, 1), date(2026, 12, 20), depends_on=["delta"],
                    status="done")  # fmt: skip
    flags = constraints.check([cut, shipped])
    assert flags["delta"] == []


async def _ship(ctx, item_id: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(item_id))
        row.shipped = {"note": "Runs in the example app", "on": "2026-11-04"}
        await s.commit()


async def _read(client, ctx, ids: dict[str, str]) -> dict[str, dict]:
    r = await client.get(ROADMAP, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    by = {i["id"]: i for i in r.json()["items"]}
    return {k: by[v] for k, v in ids.items() if v in by}


async def _walk_links(client, ctx) -> list[dict]:
    r = await client.get(WALK, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    return [s for s in r.json()["steps"] if s["kind"] == "broken_link"]


async def test_shipped_dependency_clears_the_link(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["shift_dependents"])
    ids = {"a": w.ids["shift_dependents-a"], "b": w.ids["shift_dependents-b"]}
    items = await _read(client, ctx, ids)
    assert [f["kind"] for f in items["b"]["flags"]] == ["dependency_order"]
    assert await _walk_links(client, ctx)
    await _ship(ctx, ids["a"])
    items = await _read(client, ctx, ids)
    assert items["a"]["status"] == "done"
    assert items["b"]["flags"] == []
    assert await _walk_links(client, ctx) == []


async def test_shipped_dependent_clears_the_cut_flag(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["cut"])
    ids = {"a": w.ids["cut-a"], "b": w.ids["cut-b"]}
    r = await w.post(client, "decider", "cut")
    assert r.status_code == 201, r.text
    items = await _read(client, ctx, ids)
    assert [f["kind"] for f in items["a"]["flags"]] == ["cut_with_dependents"]
    await _ship(ctx, ids["b"])
    items = await _read(client, ctx, ids)
    assert items["b"]["status"] == "done"
    assert items["a"]["flags"] == []
    assert await _walk_links(client, ctx) == []


async def test_decider_approves_and_publishes_a_working_draft(client):
    """roadmap-decide (owner, Nov 4: draft, shown live): the decider's working draft offers
    Approve and publish (can_publish) in place of Send for review, and approving it publishes
    the version at once; the owner, not its decider, keeps Send for review."""
    from tests.test_simple_drafts_api import DRAFTS, edit_title, the_draft, title_in, world
    from tests.test_simple_drafts_api import roadmap as read

    w = await world()
    await edit_title(client, w, "decider")
    d = await the_draft(client, w)
    assert d["status"] == "working" and d["can_publish"] is True
    owner = await the_draft(client, w, "owner")
    assert owner["can_publish"] is False and owner["can_submit"] is True
    # The owner, not the decider, may not approve a working draft.
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("owner"))
    # Review minor 6: one rule (can_publish) for the button and the endpoint.
    assert r.status_code == 403, r.text
    assert d["required_reviewers"] == []
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved" and r.json()["version"] == 2
    assert title_in(await read(client, w, "viewer"), "edit_title-a") == "Ledger v2"


async def test_publish_waits_for_required_reviewers(client):
    """With a required reviewer, the decider's Approve and publish sends the draft and
    records the decider's approval; it is published once the reviewer approves."""
    from tests.test_simple_drafts_api import DRAFTS, edit_title, the_draft, world

    w = await world(reviewers=("approver",))
    await edit_title(client, w, "decider")
    d = await the_draft(client, w)
    assert d["can_publish"] is True
    # Review minor 3: who still reviews it after the decider's approval, before the click.
    assert d["required_reviewers"] == [str(w.ctx.users["approver"].id)]
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "submitted" and r.json()["decider_approved"]
    assert r.json()["waiting_on"] == [str(w.ctx.users["approver"].id)]
