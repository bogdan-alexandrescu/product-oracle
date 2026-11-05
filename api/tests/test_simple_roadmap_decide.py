"""roadmap-decide (Nov 4 QA of Simple Roadmap): acting on a broken link clears it, a cut
item offers its own fixes, the working draft names the item on each line, and a change
asked of a PRD is the PRD owner's to decide. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_cut_item_is_not_checked_for_order: protects=a cut item (below the line) gets no
  "starts before what it depends on ends" flag; a cut item others depend on offers Bring it
  back, Remove the dependency and Accept as risk; fails_when=the cut item stays listed as a
  broken order link or the fixes are missing; no_claim=the web.
- test_move_then_cut_clears_the_link: protects=after Move the dependents the item's dates
  change in the working draft and its order link leaves the read; cutting the item leaves no
  order link on it; fails_when=the read still lists it; no_claim=the web.
- test_remove_dependency_and_restore_from_a_cut_item: protects=Remove the dependency drops
  the link in the working draft (the cut flag clears), Undo puts it back, Bring it back
  restores the item; fails_when=the link stays or undo misses it; no_claim=the web.
- test_remove_dependency_under_a_filter: protects=with a filter on, a cut item's flag names
  every live dependent (one outside the view too), and Remove the dependency applies when the
  dependent also depends on a key the view cannot resolve, its before built by the API;
  fails_when=the dependent is missing or the change is refused as changed; no_claim=the web.
- test_waiting_count_reads_the_whole_roadmap: protects=GET /v1/simple/roadmap/waiting counts
  the broken links of the whole roadmap as the reader sees it, the same number as the
  unfiltered read; fails_when=the route is missing or counts another number; no_claim=the web.
- test_draft_change_list_names_the_item: protects=each line of the working draft's change
  list carries the item's name, fixes included; fails_when=a line has no name;
  no_claim=the web's wording.
- test_prd_owner_sees_and_decides_the_ask: protects=the PRD owner's proposals list holds
  the change asked of the PRD, with can_decide, and the milestone's pending says the viewer
  may decide it; fails_when=it is missing for the owner or decidable by someone else;
  no_claim=the web.
"""

import uuid
from datetime import date

import pytest

from oracle import company_time
from oracle.auth.models import User
from oracle.roadmap.models import RoadmapItem
from oracle.simple import constraints
from oracle.simple.dates import Dated
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_changes_api import CHANGES, World, make_people
from tests.test_simple_goal_milestones_api import MILESTONES, by_code, get_roadmap, seed_prd_roadmap
from tests.test_simple_roadmap_api import NOW

ROADMAP = "/v1/simple/roadmap"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def _d(day: date) -> Dated:
    return Dated(day, "typed", False)


def test_cut_item_is_not_checked_for_order():
    alpha = constraints.Node(id="a", title="Alpha", start=_d(date(2026, 11, 1)),
                             end=_d(date(2026, 12, 11)))  # fmt: skip
    beta = constraints.Node(id="b", title="Beta", start=_d(date(2026, 11, 13)),
                            end=_d(date(2026, 12, 20)), depends_on=["a"], status="cut")  # fmt: skip
    flags = constraints.check([alpha, beta])
    assert [f.kind for f in flags["b"]] == []
    gamma = constraints.Node(id="g", title="Gamma", start=_d(date(2026, 12, 1)),
                             end=_d(date(2026, 12, 20)), depends_on=["a"])  # fmt: skip
    cut_alpha = constraints.Node(id="a", title="Alpha", start=_d(date(2026, 11, 1)),
                                 end=_d(date(2026, 11, 20)), status="cut")  # fmt: skip
    flags = constraints.check([cut_alpha, gamma])
    cut = next(f for f in flags["a"] if f.kind == "cut_with_dependents")
    assert cut.fixes == ["restore", "remove_dependency", "accept_risk"]


async def _read(client, ctx, who: str, key_ids: dict[str, str]) -> dict[str, dict]:
    r = await client.get(ROADMAP, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    by = {i["id"]: i for i in r.json()["items"]}
    return {k: by[v] for k, v in key_ids.items() if v in by}


async def test_move_then_cut_clears_the_link(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["shift_dependents"])
    ids = {"a": w.ids["shift_dependents-a"], "b": w.ids["shift_dependents-b"]}
    items = await _read(client, ctx, "decider", ids)
    assert [f["kind"] for f in items["b"]["flags"]] == ["dependency_order"]
    r = await w.post(client, "decider", "shift_dependents")
    assert r.status_code == 201, r.text
    items = await _read(client, ctx, "decider", ids)
    assert items["b"]["start"]["date"] == "2026-11-16"
    assert items["b"]["flags"] == []
    # Undo, then cut the dependent instead: a cut item is not checked for its order.
    r = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code == 201, r.text
    r = await client.post(CHANGES, headers=ctx.as_("decider"), json={
        "op": "cut", "target": {"item_id": ids["b"]}, "before": {"cut": False},
        "after": {"cut": True}})  # fmt: skip
    assert r.status_code == 201, r.text
    items = await _read(client, ctx, "decider", ids)
    assert [f["kind"] for f in items["b"]["flags"]] == []


async def test_remove_dependency_and_restore_from_a_cut_item(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["cut"])
    ids = {"a": w.ids["cut-a"], "b": w.ids["cut-b"]}
    r = await w.post(client, "decider", "cut")
    assert r.status_code == 201, r.text
    items = await _read(client, ctx, "decider", ids)
    cut = next(f for f in items["a"]["flags"] if f["kind"] == "cut_with_dependents")
    assert cut["fixes"] == ["restore", "remove_dependency", "accept_risk"]
    r = await client.post(CHANGES, headers=ctx.as_("decider"), json={
        "op": "remove_dependency", "target": {"item_id": ids["b"], "subject": ids["a"]},
        "before": {"depends_on": ["cut-a"]}, "after": {"depends_on": []}})  # fmt: skip
    assert r.status_code == 201, r.text
    removal = r.json()["change"]
    assert (await w.item("cut-b")).depends_on == []
    items = await _read(client, ctx, "decider", ids)
    assert items["a"]["flags"] == []
    r = await client.post(f"{CHANGES}/{removal['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code == 201, r.text
    assert (await w.item("cut-b")).depends_on == ["cut-a"]
    r = await client.post(CHANGES, headers=ctx.as_("decider"), json={
        "op": "restore", "target": {"item_id": ids["a"]}, "before": {"cut": True},
        "after": {"cut": False}})  # fmt: skip
    assert r.status_code == 201, r.text
    items = await _read(client, ctx, "decider", ids)
    assert not any(f["kind"] == "cut_with_dependents" for f in items["a"]["flags"])
    # Only a dependency the item has may be removed.
    r = await client.post(CHANGES, headers=ctx.as_("decider"), json={
        "op": "remove_dependency", "target": {"item_id": ids["a"], "subject": ids["b"]},
        "before": {"depends_on": []}, "after": {"depends_on": []}})  # fmt: skip
    assert r.status_code == 422, r.text


async def test_remove_dependency_under_a_filter(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["cut"])
    ids = {"a": w.ids["cut-a"], "b": w.ids["cut-b"]}
    async with tenant_session(ctx.tenant_id) as s:
        b = await s.get(RoadmapItem, uuid.UUID(ids["b"]))
        b.depends_on = ["cut-a", "elsewhere-key"]
        await s.commit()
    r = await w.post(client, "decider", "cut")
    assert r.status_code == 201, r.text
    # The dependent starts Nov 10: a view to Nov 5 shows the cut item alone.
    r = await client.get(ROADMAP, params={"to": "2026-11-05"}, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    shown = {i["id"]: i for i in r.json()["items"]}
    assert ids["b"] not in shown
    cut = next(f for f in shown[ids["a"]]["flags"] if f["kind"] == "cut_with_dependents")
    assert [(d["id"], d["can_decide"]) for d in cut["dependents"]] == [(ids["b"], True)]
    assert cut["dependents"][0]["title"]
    # The page knows only the keys it can resolve: the API checks the subject alone.
    r = await client.post(CHANGES, headers=ctx.as_("decider"), json={
        "op": "remove_dependency", "target": {"item_id": ids["b"], "subject": ids["a"]},
        "before": {"depends_on": ["cut-a"]}, "after": {"depends_on": []}})  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await w.item("cut-b")).depends_on == ["elsewhere-key"]
    r = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo",
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await w.item("cut-b")).depends_on == ["cut-a", "elsewhere-key"]
    r = await client.post(CHANGES, headers=ctx.as_("decider"), json={
        "op": "remove_dependency", "target": {"item_id": ids["b"], "subject": ids["a"]},
        "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await w.item("cut-b")).depends_on == ["elsewhere-key"]


async def test_waiting_count_reads_the_whole_roadmap(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["cut"])
    r = await client.get(f"{ROADMAP}/waiting", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json() == {"broken_links": 0}
    r = await w.post(client, "decider", "cut")
    assert r.status_code == 201, r.text
    r = await client.get(f"{ROADMAP}/waiting", headers=ctx.as_("decider"))
    assert r.json() == {"broken_links": 1}
    # Seen without the working draft, the approved roadmap has none.
    r = await client.get(f"{ROADMAP}/waiting", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    full = await client.get(ROADMAP, headers=ctx.as_("viewer"))
    links = [f for i in full.json()["items"] if i["status"] != "done" for f in i["flags"]
             if f["state"] == "red" and f["fixes"]
             and f["kind"] in ("dependency_order", "cut_with_dependents")]  # fmt: skip
    assert r.json() == {"broken_links": len(links)}


async def test_draft_change_list_names_the_item(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["shift_dependents"])
    r = await w.post(client, "decider", "shift_dependents")
    assert r.status_code == 201, r.text
    async with tenant_session(ctx.tenant_id) as s:
        title = (await s.get(RoadmapItem, uuid.UUID(w.ids["shift_dependents-b"]))).title
    r = await client.get("/v1/simple/drafts", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    drafts_ = r.json()
    drafts_ = drafts_["drafts"] if isinstance(drafts_, dict) else drafts_
    changes = [c for d in drafts_ for c in d["change_log"]]
    assert changes and all(c["titles"] for c in changes), changes
    fix = next(c for c in changes if c["op"] == "shift_dependents")
    assert fix["titles"][0] == title


async def test_prd_owner_sees_and_decides_the_ask(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        owner = User(email="prdowner@example.com", name="Priya Owner", password_hash="x",
                     role="approver")  # fmt: skip
        s.add(owner)
        await s.commit()
        ctx.users["prdowner"] = owner
    await seed_prd_roadmap(ctx, owner.id)
    m1 = by_code(await get_roadmap(client, ctx, "viewer"))["M1"]
    r = await client.patch(f"{MILESTONES}/{m1['id']}", json={"date": "2026-12-11"},
                           headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    change_id = r.json()["pending"]["change_id"]
    assert r.json()["pending"]["can_decide"] is False
    mine = by_code(await get_roadmap(client, ctx, "prdowner"))["M1"]
    assert mine["pending"]["can_decide"] is True
    r = await client.get(CHANGES, params={"status": "proposed"}, headers=ctx.as_("prdowner"))
    assert r.status_code == 200, r.text
    listed = {c["id"]: c for c in r.json()}
    assert change_id in listed and listed[change_id]["can_decide"] is True
    r = await client.get(CHANGES, params={"status": "proposed"}, headers=ctx.as_("commenter"))
    listed = {c["id"]: c for c in r.json()}
    assert change_id not in listed or listed[change_id]["can_decide"] is False
