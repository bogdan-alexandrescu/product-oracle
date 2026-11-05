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
- test_viewers_neither_delete_nor_restore: protects=a viewer is refused a delete (403) and
  Trash; who neither owns nor deleted it is refused its restore (403) and Trash does not
  list it to them; fails_when=either is let through; no_claim=commenters' proposals.
- test_whoever_deleted_a_feature_or_goal_restores_it: protects=(owner's answer, Nov 5) the
  approver who deleted a feature or a goal sees it in Trash and restores it, with no
  owner; another approver neither sees it nor restores it (403); an owner sees and
  restores anything; fails_when=the deleter is refused, another approver is let through,
  or a can_restore says otherwise; no_claim=documents, intakes and runs (owners' alone).
- test_delete_a_goal_moves_its_features_and_restore_brings_it_back: protects=deleting a
  goal moves its features to the goal picked (or to none) and the goal leaves the goal
  buckets; Restore brings it back with its order, measure, target and due;
  fails_when=a feature keeps a link to it or Restore loses a field; no_claim=Undo.
- test_trashed_features_and_goals_expire_after_30_days: protects=the ticker's purge deletes
  them for good after 30 days, as documents; fails_when=one is left; no_claim=the tick's
  lock.
- test_delete_a_goal_and_restore_keep_links_and_item_goals_exactly: protects=(review round 2)
  a goal's delete with no goal picked rewrites no link and no item's goal_ids, the reads
  leave it out while it is in Trash; with a goal picked its features move there; either
  way Restore puts every link (id, attrs, status, origin, created_at) and every item's
  goal_ids back exactly; fails_when=a feature or an item loses its goal; no_claim=the web.
- test_a_new_feature_never_takes_a_trashed_key_and_restore_keeps_dependents: protects=a
  new feature never takes a trashed feature's key; Restore refuses (409) when a live item
  holds it anyway; restored, the item that depended on it points at it again;
  fails_when=two items share a key or the dependent points at the new one; no_claim=PRD
  imports (the same helper).
- test_a_commenters_goal_delete_is_a_proposal_to_its_decider: protects=a commenter's goal
  delete is a delete_goal proposal ("proposed: move the goal Grow to Trash"), the goal
  stays until an owner accepts it; the commenter may not accept it; a viewer is refused;
  fails_when=the commenter is refused or deletes directly; no_claim=the Inbox screen.
- test_a_proposed_delete_of_a_feature_already_in_trash_is_closed: protects=a proposal to
  delete a feature that its decider then deletes is closed "Already in Trash";
  fails_when=it stays proposed; no_claim=goals (the same close).
- test_a_purged_feature_leaves_no_milestone_or_dependency_on_it: protects=a purge takes
  the feature's id out of milestones and its key out of other items' depends_on, and a
  purged goal's id out of the items' goal_ids; fails_when=any still names it;
  no_claim=decisions (they name it "(deleted)").
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
    assert out["change"] is None and out["can_restore"] is True
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
    # History says it, and keeps naming it, with "(deleted)".
    r = await client.get("/v1/simple/changes", headers=w.ctx.as_("owner"))
    assert "Dee Cider moved Cut A (deleted) to Trash" in [c["words"] for c in r.json()]

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
    entry = r.json()["entry"]["id"]
    for who in ("viewer", "approver", "decider"):
        assert (
            await client.post(f"{ITEMS}/{a}/restore", headers=w.ctx.as_(who))
        ).status_code == 403
        assert (
            await client.post(f"/v1/trash/{entry}/restore", headers=w.ctx.as_(who))
        ).status_code == 403
    assert (await client.get("/v1/trash", headers=w.ctx.as_("viewer"))).status_code == 403
    for who in ("approver", "decider"):
        assert (await client.get("/v1/trash", headers=w.ctx.as_(who))).json() == []
    # A commenter's goal delete is a proposal (below); a viewer's is refused.
    g = await client.delete(f"{BUCKETS}/goals/{w.goal_id}", headers=w.ctx.as_("viewer"))
    assert g.status_code == 403


@pytest.mark.asyncio
async def test_whoever_deleted_a_feature_or_goal_restores_it(client):
    w = await _world()
    a, b = w.ids["cut-a"], w.ids["cut-b"]

    def trash(who: str):
        return client.get("/v1/trash", headers=w.ctx.as_(who))

    # The decider (an approver) deletes a feature: they may restore it, another approver not.
    r = await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["can_restore"] is True
    entry = r.json()["entry"]["id"]
    listed = (await trash("decider")).json()
    assert [(e["root"]["title"], e["can_restore"]) for e in listed] == [("Cut A", True)]
    assert (await trash("approver")).json() == []
    assert [(e["id"], e["can_restore"]) for e in (await trash("owner")).json()] == [(entry, True)]
    for url in (f"{ITEMS}/{a}/restore", f"/v1/trash/{entry}/restore"):
        r = await client.post(url, headers=w.ctx.as_("approver"))
        assert r.status_code == 403, url
    r = await client.post(f"{ITEMS}/{a}/restore", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert "cut-a" in await _items(client, w)

    # Deleted again: from Trash's own Restore, by the deleter; an owner restores anyone's.
    entry = (await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("decider"))).json()
    r = await client.post(f"/v1/trash/{entry['entry']['id']}/restore",
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.delete(f"{ITEMS}/{b}", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    r = await client.post(f"/v1/trash/{r.json()['entry']['id']}/restore",
                          headers=w.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert {"cut-a", "cut-b"} <= set(await _items(client, w))

    # A goal: the approver who deleted it restores it; another approver may not.
    r = await client.delete(f"{BUCKETS}/goals/{w.goal_id}", headers=w.ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["can_restore"] is True
    assert [e["root"]["kind"] for e in (await trash("approver")).json()] == ["goal"]
    assert (await trash("decider")).json() == []
    url = f"{BUCKETS}/goals/{w.goal_id}/restore"
    assert (await client.post(url, headers=w.ctx.as_("decider"))).status_code == 403
    r = await client.post(url, headers=w.ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert (await trash("owner")).json() == []

    # An owner's own delete stays theirs and the owners': the approvers neither see nor
    # restore it.
    r = await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert (await trash("decider")).json() == []
    r = await client.post(f"{ITEMS}/{a}/restore", headers=w.ctx.as_("decider"))
    assert r.status_code == 403
    r = await client.post(f"{ITEMS}/{a}/restore", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text


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


# --- fix round 2 ------------------------------------------------------------------------


async def _links_and_goals(w: World, feature_ids: list[uuid.UUID]) -> tuple:
    """Every supports link of the features, whole, and every item's goal_ids, trashed or
    not: what a goal delete and its Restore must leave exactly as they were."""
    async with tenant_session(w.ctx.tenant_id) as s:
        edges = await s.scalars(
            select(Edge).where(Edge.src_id.in_(feature_ids), Edge.type == "supports")
            .execution_options(**ALL)
        )  # fmt: skip
        links = sorted(
            (str(e.id), str(e.src_id), str(e.dst_id), e.attrs, e.status, e.origin, e.created_at)
            for e in edges
        )
        rows = await s.execute(
            select(RoadmapItem.id, RoadmapItem.goal_ids).execution_options(**ALL)
        )
        goals = {str(i): list(g or []) for i, g in rows.all()}
    return links, goals


@pytest.mark.asyncio
@pytest.mark.parametrize("move_to_other", [False, True])
async def test_delete_a_goal_and_restore_keep_links_and_item_goals_exactly(client, move_to_other):
    w = await _world()
    goal = uuid.UUID(w.goal_id)
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        other = await seed.entity("goal", "fewer-tickets", position=2)
        solo = await seed.entity("feature", "solo-pay")
        both = await seed.entity("feature", "both-pay")
        s.add(Edge(src_id=solo.id, dst_id=goal, type="supports", status="confirmed",
                   origin="user", attrs={"contribution": 3}))  # fmt: skip
        s.add(Edge(src_id=both.id, dst_id=goal, type="supports", status="proposed",
                   origin="agent", attrs={"contribution": 2, "why": "rides"}))  # fmt: skip
        s.add(Edge(src_id=both.id, dst_id=other.id, type="supports", status="confirmed",
                   origin="user", attrs={"contribution": 3}))  # fmt: skip
        b = await s.get(RoadmapItem, uuid.UUID(w.ids["cut-b"]))
        b.goal_ids = [other.id, goal]
        await s.commit()
        features = [solo.id, both.id]
        other_id = str(other.id)
    before = await _links_and_goals(w, features)

    params = {"to_goal_id": other_id} if move_to_other else {}
    r = await client.delete(f"{BUCKETS}/goals/{w.goal_id}", params=params,
                            headers=w.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    items = await _items(client, w)
    # While the goal is in Trash no read names it.
    assert w.goal_id not in items["cut-a"]["goal_ids"]
    assert items["cut-b"]["goal_ids"] == [other_id]
    if not move_to_other:
        assert items["cut-a"]["goal"] is None
        # Nothing was rewritten: the trash filter hides the goal and its links.
        assert await _links_and_goals(w, features) == before

    r = await client.post(f"{BUCKETS}/goals/{w.goal_id}/restore", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await _links_and_goals(w, features) == before
    items = await _items(client, w)
    assert items["cut-a"]["goal_ids"] == [w.goal_id]
    assert items["cut-a"]["goal"]["id"] == w.goal_id


@pytest.mark.asyncio
async def test_a_new_feature_never_takes_a_trashed_key_and_restore_keeps_dependents(client):
    from tests.test_simple_additions_api import World as Additions

    w = await Additions().build()
    a, b = w.ids["import-a"], w.ids["import-b"]
    r = await client.delete(f"{ITEMS}/{a}", headers=w.as_("owner"))
    assert r.status_code == 200, r.text
    # A new feature named as the trashed one gets a key of its own.
    added = (await w.add(client, "owner", "Import A"))["change"]["target"]["item_id"]
    async with tenant_session(w.ctx.tenant_id) as s:
        new = await s.get(RoadmapItem, uuid.UUID(added))
        assert new.item_key != "import-a"
        # A clash made some other way: Restore refuses rather than share the key.
        kept, new.item_key = new.item_key, "import-a"
        await s.commit()
    r = await client.post(f"{ITEMS}/{a}/restore", headers=w.as_("owner"))
    assert r.status_code == 409, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        (await s.get(RoadmapItem, uuid.UUID(added))).item_key = kept
        await s.commit()

    r = await client.post(f"{ITEMS}/{a}/restore", headers=w.as_("owner"))
    assert r.status_code == 200, r.text
    items = await w.items(client)
    assert items[b]["depends_on"] == [a]
    assert items[a]["key"] == "import-a"


@pytest.mark.asyncio
async def test_a_commenters_goal_delete_is_a_proposal_to_its_decider(client):
    w = await Buckets().build()
    grow = w.goals["grow"]
    r = await client.delete(f"{BUCKETS}/goals/{grow}", headers=w.as_("viewer"))
    assert r.status_code == 403
    r = await client.delete(f"{BUCKETS}/goals/{grow}", headers=w.as_("commenter"))
    assert r.status_code == 200, r.text
    assert r.json()["entry"] is None
    change = r.json()["change"]
    assert change["status"] == "proposed" and change["op"] == "delete_goal"
    assert "proposed: move the goal Grow to Trash" in change["words"]
    assert grow in [g["id"] for g in (await w.read(client))["goals"]]
    # The owners read it among the changes, theirs to decide.
    r = await client.get("/v1/simple/changes", headers=w.as_("owner"))
    assert r.status_code == 200, r.text
    mine = next(c for c in r.json() if c["id"] == change["id"])
    assert mine["can_decide"] is True and str(w.ctx.users["owner"].id) in mine["routed_to"]
    assert (await client.get("/v1/inbox", headers=w.as_("owner"))).status_code == 200
    r = await client.post(f"/v1/simple/changes/{change['id']}/accept",
                          headers=w.as_("commenter"))  # fmt: skip
    assert r.status_code == 403
    r = await client.post(f"/v1/simple/changes/{change['id']}/accept",
                          headers=w.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    assert grow not in [g["id"] for g in (await w.read(client))["goals"]]
    listed = (await client.get("/v1/trash", headers=w.as_("owner"))).json()
    assert [(e["root"]["kind"], e["root"]["title"]) for e in listed] == [("goal", "Grow")]


@pytest.mark.asyncio
async def test_a_proposed_delete_of_a_feature_already_in_trash_is_closed(client):
    w = await _world()
    a = w.ids["cut-a"]
    r = await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("approver"))
    proposal = r.json()["change"]["id"]
    r = await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    r = await client.get("/v1/simple/changes", headers=w.ctx.as_("owner"))
    c = next(c for c in r.json() if c["id"] == proposal)
    assert c["status"] == "declined" and c["decision_reason"] == "Already in Trash"


@pytest.mark.asyncio
async def test_a_purged_feature_leaves_no_milestone_or_dependency_on_it(client):
    w = await _world()
    a, b = w.ids["cut-a"], w.ids["cut-b"]
    assert (await client.delete(f"{ITEMS}/{a}", headers=w.ctx.as_("owner"))).status_code == 200
    async with tenant_session(w.ctx.tenant_id) as s:
        for entry in await trash_service.list_entries(s):
            await trash_service.purge_entry(s, None, entry)
        await s.commit()
    async with tenant_session(w.ctx.tenant_id) as s:
        m = await s.scalar(select(TrackMilestone).where(TrackMilestone.name == "Beta"))
        assert m.item_ids == []
        assert (await s.get(RoadmapItem, uuid.UUID(b))).depends_on == []

    # A purged goal leaves the goal_ids of the items still on the roadmap.
    async with tenant_session(w.ctx.tenant_id) as s:
        (await s.get(RoadmapItem, uuid.UUID(b))).goal_ids = [uuid.UUID(w.goal_id)]
        await s.commit()
    r = await client.delete(f"{BUCKETS}/goals/{w.goal_id}", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        for entry in await trash_service.list_entries(s):
            await trash_service.purge_entry(s, None, entry)
        await s.commit()
    async with tenant_session(w.ctx.tenant_id) as s:
        assert (await s.get(RoadmapItem, uuid.UUID(b))).goal_ids == []
        rows = await s.scalars(select(RoadmapItem).execution_options(**ALL))
        assert all(uuid.UUID(w.goal_id) not in (r.goal_ids or []) for r in rows)


async def _publish(client, w: World) -> None:
    """The open draft submitted and approved: the roadmap's next version is published."""
    from tests import test_simple_drafts_api as D

    d = await D.the_draft(client, w)
    r = await client.post(f"{D.DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    if r.json()["status"] != "approved":
        r = await client.post(f"{D.DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
        assert r.status_code == 200 and r.json()["status"] == "approved", r.text


async def _detailed(client, w: World) -> set[str]:
    from tests import test_simple_drafts_api as D

    r = await client.get(f"/v1/roadmaps/{await D.slug(w)}/items", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return {i["item_key"] for i in r.json()["items"]}


@pytest.mark.asyncio
@pytest.mark.parametrize("then", ["published", "working_draft", "in_review"])
async def test_restore_after_a_new_version_puts_the_feature_on_the_current_roadmap(client, then):
    """protects=(review round 3) a feature deleted before a new version is published comes
    back on the roadmap's current version (Simple and Detailed), and on the open draft's
    or the version in review's when one is open, with its dependencies and milestone; a
    dependency on what is no longer on the roadmap is dropped and the answer says which;
    fails_when=Restore answers 200 and the feature stays on the old version only;
    no_claim=the Trash screen."""
    from tests import test_simple_drafts_api as D

    w = await D.world()
    victim = w.ids["move_dates-b"]
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(victim))
        row.depends_on = ["move_dates-a", "gone-feature"]
        s.add(TrackMilestone(roadmap_id=uuid.UUID(w.roadmap_id), name="Pilot",
                             item_ids=[row.id], code="M1"))  # fmt: skip
        await s.commit()
    r = await client.delete(f"{ITEMS}/{victim}", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert (await D.edit_title(client, w, "decider")).status_code == 201
    await _publish(client, w)
    assert "move_dates-b" not in await _items(client, w)
    if then != "published":
        a = (await _items(client, w, "decider"))["move_dates-a"]
        r = await w.post(client, "decider", "move_dates", target={"item_id": a["id"]})
        assert r.status_code == 201, r.text
    if then == "in_review":
        d = await D.the_draft(client, w)
        r = await client.post(f"{D.DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
        assert r.status_code == 200, r.text

    r = await client.post(f"{ITEMS}/{victim}/restore", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    [gone] = r.json()["not_restored"]
    assert gone["item"]["slug"] == "move_dates-b" and "gone-feature" in gone["reason"]
    if then == "published":
        items = await _items(client, w)
        assert "move_dates-b" in items and "move_dates-b" in await _detailed(client, w)
        assert items["move_dates-b"]["depends_on"] == [items["move_dates-a"]["id"]]
    else:
        assert "move_dates-b" in await _items(client, w, "decider")
        if then == "working_draft":
            await _publish(client, w)
        else:
            d = await D.the_draft(client, w)
            r = await client.post(f"{D.DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
            assert r.status_code == 200 and r.json()["status"] == "approved", r.text
        items = await _items(client, w)
        assert "move_dates-b" in items and "move_dates-b" in await _detailed(client, w)
    async with tenant_session(w.ctx.tenant_id) as s:
        live = {
            r.id: r.depends_on
            for r in await s.scalars(
                select(RoadmapItem).where(RoadmapItem.item_key == "move_dates-b")
            )
        }
        m = await s.scalar(select(TrackMilestone).where(TrackMilestone.name == "Pilot"))
    shown = uuid.UUID(items["move_dates-b"]["id"])
    assert live[shown] == ["move_dates-a"] and shown in m.item_ids


@pytest.mark.asyncio
async def test_restore_after_a_new_version_still_refuses_a_key_clash(client):
    from tests import test_simple_drafts_api as D

    w = await D.world()
    victim = w.ids["move_dates-b"]
    assert (
        await client.delete(f"{ITEMS}/{victim}", headers=w.ctx.as_("decider"))
    ).status_code == 200
    assert (await D.edit_title(client, w, "decider")).status_code == 201
    await _publish(client, w)
    shown = (await _items(client, w))["move_dates-u"]["id"]
    async with tenant_session(w.ctx.tenant_id) as s:
        (await s.get(RoadmapItem, uuid.UUID(shown))).item_key = "move_dates-b"
        await s.commit()
    r = await client.post(f"{ITEMS}/{victim}/restore", headers=w.ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert len((await client.get("/v1/trash", headers=w.ctx.as_("owner"))).json()) == 1
