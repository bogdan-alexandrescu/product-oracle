"""trash-features-goals (owner's pick, Nov 4): a roadmap feature and a goal can be deleted
to Settings › Trash and restored from there, as a document is. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_decider_deletes_a_feature_and_restore_puts_it_back: protects=the feature's decider
  deletes it: it leaves the roadmap and the priorities, the item that depends on it keeps
  its link, Trash lists it (kind, name, who, days left); history names it "(deleted)";
  Restore (owners) brings it back with its links, goal and milestone as they were;
  fails_when=it stays in a read, a link or its goal is lost, or Restore leaves it out;
  no_claim=the Trash screen.
- test_an_approver_who_does_not_decide_proposes_the_delete: protects=an approver who is
  not the decider gets a proposal ("proposed: move ... to Trash"), the feature stays;
  the decider accepts it and the feature goes to Trash; a declined one leaves it;
  fails_when=the approver deletes directly or the words show the op's name;
  no_claim=the Inbox screen.
- test_viewers_neither_delete_nor_restore: protects=a viewer is refused a delete (403),
  a non-owner restore is refused (403) and Trash stays owners'; fails_when=either is let
  through; no_claim=commenters' proposals.
- test_delete_a_goal_moves_its_features_and_restore_brings_it_back: protects=deleting a
  goal moves its features to the goal picked (or to none) and the goal leaves the goal
  buckets; Restore brings it back with its order, measure, target and due;
  fails_when=a feature keeps a link to it or Restore loses a field; no_claim=Undo.
- test_trashed_features_and_goals_expire_after_30_days: protects=the ticker's purge deletes
  them for good after 30 days, as documents; fails_when=one is left; no_claim=the tick's
  lock.
"""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from oracle.baseline.models import Edge, Entity
from oracle.roadmap.models import RoadmapItem, TrackMilestone
from oracle.tenancy import tenant_session
from oracle.trash import service as trash_service
from oracle.trash.filter import INCLUDE_TRASHED
from tests.test_simple_changes_api import World, clock, make_people  # noqa: F401
from tests.test_simple_goal_buckets_api import URL as BUCKETS
from tests.test_simple_goal_buckets_api import World as Buckets
from tests.test_simple_roadmap_api import Seed

ROADMAP = "/v1/simple/roadmap"
ITEMS = "/v1/simple/roadmap/items"
ALL = {INCLUDE_TRASHED: True}


async def _world() -> World:
    w = await World(await make_people()).build(decider=True, ops=["cut"])
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        goal = await seed.entity("goal", "faster-rides", position=1, metric="Rides",
                                 target_text="100", due="2027-03-31")  # fmt: skip
        a = await s.get(RoadmapItem, uuid.UUID(w.ids["cut-a"]))
        a.goal_ids = [goal.id]
        s.add(TrackMilestone(roadmap_id=uuid.UUID(w.roadmap_id), name="Beta",
                             item_ids=[a.id], code="M1"))  # fmt: skip
        await s.commit()
        w.goal_id = str(goal.id)  # type: ignore[attr-defined]
    return w


async def _items(client, w: World, who: str = "owner") -> dict[str, dict]:
    r = await client.get(ROADMAP, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return {i["key"]: i for i in r.json()["items"]}


@pytest.mark.asyncio
async def test_decider_deletes_a_feature_and_restore_puts_it_back(client):
    w = await _world()
    a, b = w.ids["cut-a"], w.ids["cut-b"]
    before = await _items(client, w)
    assert before["cut-b"]["depends_on"] == [a]

    r = await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["change"] is None and out["can_restore"] is False
    entry = out["entry"]
    assert entry["root"]["type"] == "feature" and entry["root"]["title"] == "Cut A"
    assert entry["deleted_by_name"] == "Dee Cider" and entry["days_left"] == 30

    after = await _items(client, w)
    assert "cut-a" not in after and "cut-b" in after
    r = await client.get("/v1/simple/priorities", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert a not in r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await s.get(RoadmapItem, uuid.UUID(a)) is None
        row = await s.scalar(
            select(RoadmapItem).where(RoadmapItem.id == uuid.UUID(a)).execution_options(**ALL)
        )
        assert row.deleted_at is not None and row.goal_ids == [uuid.UUID(w.goal_id)]
        dep = await s.get(RoadmapItem, uuid.UUID(b))
        assert dep.depends_on == ["cut-a"]

    listed = (await client.get("/v1/trash", headers=w.ctx.as_("owner"))).json()
    assert [(e["root"]["kind"], e["root"]["title"]) for e in listed] == [("feature", "Cut A")]

    r = await client.post(f"{ITEMS}/{a}/restore", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    back = await _items(client, w)
    assert back["cut-a"]["id"] == a
    assert back["cut-b"]["depends_on"] == [a]
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(a))
        assert row is not None and row.deleted_at is None
        assert row.goal_ids == [uuid.UUID(w.goal_id)]
        m = await s.scalar(select(TrackMilestone).where(TrackMilestone.name == "Beta"))
        assert m.item_ids == [row.id]
    assert (await client.get("/v1/trash", headers=w.ctx.as_("owner"))).json() == []


@pytest.mark.asyncio
async def test_an_approver_who_does_not_decide_proposes_the_delete(client):
    w = await _world()
    a, b = w.ids["cut-a"], w.ids["cut-b"]
    r = await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("approver"))
    assert r.status_code == 200, r.text
    change = r.json()["change"]
    assert r.json()["entry"] is None
    assert change["status"] == "proposed" and change["op"] == "delete_item"
    assert "proposed: move" in change["words"] and "Cut A to Trash" in change["words"]
    assert "delete_item" not in change["words"]
    assert "cut-a" in await _items(client, w)
    # A second ask while one waits is refused.
    r = await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("approver"))
    assert r.status_code == 409

    # The approver may not accept their own ask; the decider does.
    r = await client.post(f"/v1/simple/changes/{change['id']}/accept",
                          headers=w.ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 403
    r = await client.post(f"/v1/simple/changes/{change['id']}/accept",
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    # History keeps naming it, with "(deleted)".
    assert "Cut A (deleted) to Trash" in r.json()["change"]["words"]
    assert "cut-a" not in await _items(client, w)
    listed = (await client.get("/v1/trash", headers=w.ctx.as_("owner"))).json()
    assert [e["root"]["id"] for e in listed] == [a]

    # A declined ask leaves the feature where it is.
    r = await client.post("/v1/simple/changes", headers=w.ctx.as_("approver"),
                          json={"op": "delete_item", "target": {"item_id": b},
                                "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 201, r.text
    cid = r.json()["change"]["id"]
    r = await client.post(f"/v1/simple/changes/{cid}/decline", headers=w.ctx.as_("decider"),
                          json={"reason": "Still needed"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert "cut-b" in await _items(client, w)


@pytest.mark.asyncio
async def test_viewers_neither_delete_nor_restore(client):
    w = await _world()
    a = w.ids["cut-a"]
    r = await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("viewer"))
    assert r.status_code == 403
    assert "cut-a" in await _items(client, w)
    r = await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["can_restore"] is True
    for who in ("viewer", "approver", "decider"):
        assert (
            await client.post(f"{ITEMS}/{a}/restore", headers=w.ctx.as_(who))
        ).status_code == 403
        assert (await client.get("/v1/trash", headers=w.ctx.as_(who))).status_code == 403
    g = await client.delete(f"{BUCKETS}/goals/{w.goal_id}", headers=w.ctx.as_("commenter"))
    assert g.status_code == 403


@pytest.mark.asyncio
async def test_delete_a_goal_moves_its_features_and_restore_brings_it_back(client):
    w = await Buckets().build()
    grow, quiet = w.goals["grow"], w.goals["quiet"]
    before = next(g for g in (await w.read(client))["goals"] if g["id"] == grow)

    r = await client.delete(f"{BUCKETS}/goals/{grow}", params={"to_goal_id": quiet},
                            headers=w.as_("approver"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["entry"]["root"] == {**r.json()["entry"]["root"], "type": "goal",
                                         "title": "Grow", "kind": "goal"}  # fmt: skip
    out = await w.read(client)
    assert grow not in [g["id"] for g in out["goals"]]
    assert await w.links(client) == {"solo": ["quiet"], "both": ["quiet"]}
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await s.get(Entity, uuid.UUID(grow)) is None
        left = await s.scalar(
            select(func.count()).select_from(Edge).where(Edge.dst_id == uuid.UUID(grow))
            .execution_options(**ALL)
        )  # fmt: skip
        assert left == 0
    listed = (await client.get("/v1/trash", headers=w.as_("owner"))).json()
    assert [(e["root"]["kind"], e["root"]["title"]) for e in listed] == [("goal", "Grow")]

    r = await client.post(f"{BUCKETS}/goals/{grow}/restore", headers=w.as_("approver"))
    assert r.status_code == 403
    r = await client.post(f"{BUCKETS}/goals/{grow}/restore", headers=w.as_("owner"))
    assert r.status_code == 200, r.text
    back = next(g for g in (await w.read(client))["goals"] if g["id"] == grow)
    assert back == before


@pytest.mark.asyncio
async def test_trashed_features_and_goals_expire_after_30_days(client, monkeypatch):
    w = await _world()
    a = w.ids["cut-a"]
    assert (await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("owner"))).status_code == 200
    r = await client.delete(f"{BUCKETS}/goals/{w.goal_id}", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    start = trash_service.now()

    monkeypatch.setattr(trash_service, "now", lambda: start + timedelta(days=29))
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await trash_service.purge_due(s) == 0
    monkeypatch.setattr(trash_service, "now", lambda: start + timedelta(days=30, minutes=1))
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await trash_service.purge_due(s) == 2
    async with tenant_session(w.ctx.tenant_id) as s:
        gone = await s.scalar(
            select(RoadmapItem).where(RoadmapItem.id == uuid.UUID(a)).execution_options(**ALL)
        )
        goal = await s.scalar(
            select(Entity).where(Entity.id == uuid.UUID(w.goal_id)).execution_options(**ALL)
        )
        assert gone is None and goal is None
    assert (await client.get("/v1/trash", headers=w.ctx.as_("owner"))).json() == []
