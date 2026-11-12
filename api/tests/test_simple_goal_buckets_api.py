"""Goal buckets in Simple Priorities: add, edit and archive a goal, and move a feature
between goals, each with Undo, through the goal entities and "supports" links Baseline
edits. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_goal_add_and_edit_per_role: protects=owners and approvers add a goal with its
  measure, target and date (it lists after the others, with its order number) and edit
  it; a goal missing its measure, target or date is 422; commenters and viewers get 403
  and read the goals with can_edit false; Undo puts the old fields back;
  fails_when=an incomplete goal saves, a commenter edits or Undo leaves the edit;
  no_claim=Baseline's own goal checks.
- test_archive_moves_links_and_undo: protects=archiving a goal hides it from the
  buckets; a feature that serves another goal too keeps that goal (now its first); the
  rest move to the goal picked, or to no goal; Undo brings the goal and every link
  back; fails_when=a link is lost or Undo leaves a half archive; no_claim=milestones.
- test_archive_moves_items_own_goal_and_undo: protects=archiving a goal with a goal
  picked moves the roadmap items that name it as their own goal (a draft with no
  feature) to that goal, as a delete to Trash does; Undo puts their goals back;
  fails_when=such an item keeps the archived goal or Undo leaves it moved;
  no_claim=the feature links (test_archive_moves_links_and_undo).
- test_archive_keeps_an_items_other_goal_and_leaves_none_unasked: protects=an item that
  serves another live goal too keeps it as its own (first), as a feature does, never the
  goal picked; with no goal picked Archive takes the goal off every item that names it
  (an item in Trash too, so one restored later does not name it) and Undo puts each
  item's goals back exactly; fails_when=an item's own goal changes unasked, a draft keeps
  the archived goal, or Undo leaves one moved; no_claim=the web.
- test_archive_counts_no_key_result_of_the_goal_as_live: protects=an item on the goal
  and one of the goal's own key results moves to the goal picked (or to no goal), as the
  dialog says: the archived goal's key result is not another live goal it keeps;
  fails_when=the item is left on a key result of the archived goal; no_claim=key results
  of other goals (test_archive_keeps_an_items_other_goal_and_leaves_none_unasked).
- test_archive_counts_no_nested_key_result_of_the_goal_as_live: protects=a key result
  of a key result of the archived goal (any depth), or one under an archived goal or a goal
  in Trash, keeps no item: the item moves to the goal picked, as the dialog lifts a key
  result to its top goal;
  fails_when=only direct key results count and the item stays on the nested one;
  no_claim=direct key results (test_archive_counts_no_key_result_of_the_goal_as_live).
- test_move_feature_and_undo: protects=moving a feature makes the new goal its first
  link and drops the old one; Undo restores both links; a viewer gets 403;
  fails_when=the old link stays or the new one is not first; no_claim=the web's drag.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle.baseline.models import Edge, Entity
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from oracle.trash.filter import INCLUDE_TRASHED
from tests.test_simple_changes_api import make_people
from tests.test_simple_roadmap_api import Seed

URL = "/v1/simple/goal-buckets"
ALL = {INCLUDE_TRASHED: True}
GOAL = {"title": "Faster first ride", "measure": "Days to first ride", "target": "3 days",
        "due": "2026-12-31"}  # fmt: skip


class World:
    """Goals ``grow`` and ``quiet``; features ``solo`` (serves grow) and ``both`` (serves
    grow, then quiet)."""

    async def build(self) -> "World":
        self.ctx = await make_people()
        async with tenant_session(self.ctx.tenant_id) as s:
            seed = Seed(s)
            grow = await seed.entity("goal", "grow", position=1, metric="Shops live",
                                     target_text="40 shops", due="2027-03-31")  # fmt: skip
            quiet = await seed.entity("goal", "quiet", position=2, metric="Chats",
                                      target_text="8", due="2027-01-29")  # fmt: skip
            solo = await seed.entity("feature", "solo")
            both = await seed.entity("feature", "both")
            s.add(Edge(src_id=solo.id, dst_id=grow.id, type="supports", status="confirmed",
                       origin="user", attrs={"contribution": 3}))  # fmt: skip
            s.add(Edge(src_id=both.id, dst_id=grow.id, type="supports", status="confirmed",
                       origin="user", attrs={"contribution": 3}))  # fmt: skip
            s.add(Edge(src_id=both.id, dst_id=quiet.id, type="supports", status="confirmed",
                       origin="user", attrs={"contribution": 2}))  # fmt: skip
            await s.commit()
            self.goals = {"grow": str(grow.id), "quiet": str(quiet.id)}
            self.features = {"solo": str(solo.id), "both": str(both.id)}
        return self

    def as_(self, who: str) -> dict:
        return self.ctx.as_(who)

    async def read(self, client, who: str = "owner") -> dict:
        r = await client.get(URL, headers=self.as_(who))
        assert r.status_code == 200, r.text
        return r.json()

    async def links(self, client) -> dict[str, list[str]]:
        names = {v: k for k, v in self.goals.items()}
        out = await self.read(client)
        return {
            f["key"]: [names.get(g, g) for g in f["goal_ids"]]
            for f in out["features"]
            if f["key"] in self.features
        }


@pytest.mark.asyncio
async def test_goal_add_and_edit_per_role(client):
    w = await World().build()
    for who in ("commenter", "viewer"):
        out = await w.read(client, who)
        assert out["can_edit"] is False
        assert all(g["can_edit"] is False for g in out["goals"])
        r = await client.post(f"{URL}/goals", headers=w.as_(who), json=GOAL)
        assert r.status_code == 403
    for missing in ("measure", "target", "due"):
        r = await client.post(f"{URL}/goals", headers=w.as_("owner"), json={**GOAL, missing: ""})
        assert r.status_code == 422, missing
    r = await client.post(f"{URL}/goals", headers=w.as_("approver"), json=GOAL)
    assert r.status_code == 201, r.text
    made = r.json()["goal"]
    assert made["order"] == 3 and made["measure"] == "Days to first ride"
    out = await w.read(client)
    assert out["can_edit"] is True
    assert [g["title"] for g in out["goals"]] == ["Grow", "Quiet", "Faster first ride"]

    r = await client.patch(f"{URL}/goals/{w.goals['grow']}", headers=w.as_("owner"),
                           json={"title": "Grow shops", "measure": "Shops live",
                                 "target": "50 shops", "due": "2027-04-30"})  # fmt: skip
    assert r.status_code == 200, r.text
    undo = r.json()["undo"]
    grow = next(g for g in (await w.read(client))["goals"] if g["id"] == w.goals["grow"])
    assert (grow["title"], grow["target"], grow["due"]) == ("Grow shops", "50 shops", "2027-04-30")
    r = await client.patch(f"{URL}/goals/{w.goals['grow']}", headers=w.as_("commenter"),
                           json={**GOAL})  # fmt: skip
    assert r.status_code == 403
    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=undo)
    assert r.status_code == 200, r.text
    grow = next(g for g in (await w.read(client))["goals"] if g["id"] == w.goals["grow"])
    assert (grow["title"], grow["target"], grow["due"]) == ("Grow", "40 shops", "2027-03-31")


@pytest.mark.asyncio
async def test_archive_moves_links_and_undo(client):
    w = await World().build()
    third = (await client.post(f"{URL}/goals", headers=w.as_("owner"), json=GOAL)).json()["goal"]
    r = await client.post(f"{URL}/goals/{w.goals['grow']}/archive", headers=w.as_("viewer"),
                          json={"to_goal_id": third["id"]})  # fmt: skip
    assert r.status_code == 403
    r = await client.post(f"{URL}/goals/{w.goals['grow']}/archive", headers=w.as_("owner"),
                          json={"to_goal_id": third["id"]})  # fmt: skip
    assert r.status_code == 200, r.text
    undo = r.json()["undo"]
    out = await w.read(client)
    assert w.goals["grow"] not in [g["id"] for g in out["goals"]]
    links = await w.links(client)
    assert links["solo"] == [third["id"]]
    assert links["both"] == ["quiet"]

    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=undo)
    assert r.status_code == 200, r.text
    assert w.goals["grow"] in [g["id"] for g in (await w.read(client))["goals"]]
    assert await w.links(client) == {"solo": ["grow"], "both": ["grow", "quiet"]}

    # No goal picked: those with no other goal are left with none.
    r = await client.post(f"{URL}/goals/{w.goals['grow']}/archive", headers=w.as_("owner"),
                          json={"to_goal_id": None})  # fmt: skip
    assert r.status_code == 200, r.text
    assert await w.links(client) == {"solo": [], "both": ["quiet"]}
    async with tenant_session(w.ctx.tenant_id) as s:
        grow = await s.scalar(select(Entity).where(Entity.key == "grow"))
        assert grow is not None and grow.status == "rejected"


async def test_archive_moves_items_own_goal_and_undo(client):
    w = await World().build()
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("shops")
        grow, quiet = uuid.UUID(w.goals["grow"]), uuid.UUID(w.goals["quiet"])
        draft = await seed.item(rv, pv, "recap", draft=True, goal_ids=[grow])
        two = await seed.item(rv, pv, "two-goals", goal_ids=[quiet, grow])
        await s.commit()
        ids = {"draft": draft.id, "two": two.id}

    async def goals_of() -> dict[str, list[uuid.UUID]]:
        async with tenant_session(w.ctx.tenant_id) as s:
            return {k: list((await s.get(RoadmapItem, i)).goal_ids or []) for k, i in ids.items()}

    third = (await client.post(f"{URL}/goals", headers=w.as_("owner"), json=GOAL)).json()["goal"]
    r = await client.post(f"{URL}/goals/{w.goals['grow']}/archive", headers=w.as_("owner"),
                          json={"to_goal_id": third["id"]})  # fmt: skip
    assert r.status_code == 200, r.text
    to = uuid.UUID(third["id"])
    assert await goals_of() == {"draft": [to], "two": [quiet]}

    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=r.json()["undo"])
    assert r.status_code == 200, r.text
    assert await goals_of() == {"draft": [grow], "two": [quiet, grow]}


@pytest.mark.parametrize("pick", [False, True])
async def test_archive_keeps_an_items_other_goal_and_leaves_none_unasked(client, pick):
    w = await World().build()
    third = (await client.post(f"{URL}/goals", headers=w.as_("owner"), json=GOAL)).json()["goal"]
    grow, quiet, to = (uuid.UUID(x) for x in (w.goals["grow"], w.goals["quiet"], third["id"]))
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("shops")
        draft = await seed.item(rv, pv, "recap", draft=True, goal_ids=[grow])
        two = await seed.item(rv, pv, "two-goals", draft=True, goal_ids=[grow, quiet])
        gone = await seed.item(rv, pv, "in-trash", goal_ids=[grow],
                               deleted_at=datetime.now(UTC))  # fmt: skip
        await s.commit()
        ids = {"draft": draft.id, "two": two.id, "gone": gone.id}

    async def goals_of() -> dict[str, list[uuid.UUID]]:
        async with tenant_session(w.ctx.tenant_id) as s:
            rows = await s.execute(
                select(RoadmapItem.id, RoadmapItem.goal_ids).execution_options(**ALL)
            )
            by_id = {i: list(g or []) for i, g in rows.all()}
        return {k: by_id[i] for k, i in ids.items()}

    before = await goals_of()
    r = await client.post(f"{URL}/goals/{grow}/archive", headers=w.as_("owner"),
                          json={"to_goal_id": str(to) if pick else None})  # fmt: skip
    assert r.status_code == 200, r.text
    moved = [to] if pick else []
    assert await goals_of() == {"draft": moved, "two": [quiet], "gone": moved}
    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=r.json()["undo"])
    assert r.status_code == 200, r.text
    assert await goals_of() == before


@pytest.mark.parametrize("pick", [False, True])
async def test_archive_counts_no_key_result_of_the_goal_as_live(client, pick):
    w = await World().build()
    third = (await client.post(f"{URL}/goals", headers=w.as_("owner"), json=GOAL)).json()["goal"]
    grow, to = uuid.UUID(w.goals["grow"]), uuid.UUID(third["id"])
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        kr = await seed.entity("goal", "grow-kr")
        kr.parent_id = grow
        _, pv, _, rv = await seed.roadmap("shops")
        item = await seed.item(rv, pv, "recap", draft=True, goal_ids=[grow, kr.id])
        await s.commit()
        item_id, kr_id = item.id, kr.id

    r = await client.post(f"{URL}/goals/{grow}/archive", headers=w.as_("owner"),
                          json={"to_goal_id": str(to) if pick else None})  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        goals = list((await s.get(RoadmapItem, item_id)).goal_ids or [])
    assert goals == ([to, kr_id] if pick else [kr_id])


@pytest.mark.parametrize("pick", [False, True])
@pytest.mark.parametrize("under", ["grow", "archived", "trashed"])
async def test_archive_counts_no_nested_key_result_of_the_goal_as_live(client, pick, under):
    w = await World().build()
    third = (await client.post(f"{URL}/goals", headers=w.as_("owner"), json=GOAL)).json()["goal"]
    grow, to = uuid.UUID(w.goals["grow"]), uuid.UUID(third["id"])
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        top = grow
        if under in ("archived", "trashed"):
            gone = await seed.entity("goal", "gone")
            if under == "archived":
                gone.status = "rejected"
            else:
                gone.deleted_at = datetime.now(UTC)
            top = gone.id
        kr1 = await seed.entity("goal", "kr-1")
        kr1.parent_id = top
        kr2 = await seed.entity("goal", "kr-2")
        kr2.parent_id = kr1.id
        _, pv, _, rv = await seed.roadmap("shops")
        item = await seed.item(rv, pv, "recap", draft=True, goal_ids=[grow, kr2.id])
        await s.commit()
        item_id, kr_id = item.id, kr2.id

    r = await client.post(f"{URL}/goals/{grow}/archive", headers=w.as_("owner"),
                          json={"to_goal_id": str(to) if pick else None})  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        goals = list((await s.get(RoadmapItem, item_id)).goal_ids or [])
    assert goals == ([to, kr_id] if pick else [kr_id])


@pytest.mark.asyncio
async def test_move_feature_and_undo(client):
    w = await World().build()
    body = {"from_goal_id": w.goals["grow"], "to_goal_id": w.goals["quiet"]}
    r = await client.post(f"{URL}/features/{w.features['solo']}/move", headers=w.as_("viewer"),
                          json=body)  # fmt: skip
    assert r.status_code == 403
    r = await client.post(f"{URL}/features/{w.features['solo']}/move", headers=w.as_("owner"),
                          json=body)  # fmt: skip
    assert r.status_code == 200, r.text
    undo = r.json()["undo"]
    r = await client.post(f"{URL}/features/{w.features['both']}/move", headers=w.as_("owner"),
                          json=body)  # fmt: skip
    assert r.status_code == 200, r.text
    assert await w.links(client) == {"solo": ["quiet"], "both": ["quiet"]}
    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=undo)
    assert r.status_code == 200, r.text
    assert (await w.links(client))["solo"] == ["grow"]


async def _edges(w: World, feature_key: str) -> list[tuple]:
    """A feature's supports links, whole: id, goal, attrs, status, origin, created_at."""
    async with tenant_session(w.ctx.tenant_id) as s:
        f = await s.scalar(select(Entity).where(Entity.key == feature_key))
        rows = await s.scalars(select(Edge).where(Edge.src_id == f.id, Edge.type == "supports"))
        return sorted(
            (str(e.id), str(e.dst_id), e.attrs, e.status, e.origin, e.created_at) for e in rows
        )


async def _loose(w: World) -> None:
    """Feature ``loose`` serves grow, then quiet, with no contribution on either link."""
    async with tenant_session(w.ctx.tenant_id) as s:
        loose = await Seed(s).entity("feature", "loose")
        grow, quiet = (uuid.UUID(w.goals[k]) for k in ("grow", "quiet"))
        s.add(Edge(src_id=loose.id, dst_id=grow, type="supports", status="proposed",
                   origin="agent", attrs={"note": "from the brief"},
                   created_at=datetime(2026, 1, 5, tzinfo=UTC)))  # fmt: skip
        s.add(Edge(src_id=loose.id, dst_id=quiet, type="supports", status="confirmed",
                   origin="import", attrs={},
                   created_at=datetime(2026, 2, 5, tzinfo=UTC)))  # fmt: skip
        await s.commit()
    w.features["loose"] = str(loose.id)


@pytest.mark.asyncio
async def test_undo_puts_links_back_exactly(client):
    """protects=Undo of a move or an archive puts every supports link back whole: links
    with no contribution get none, a dropped link comes back with its id, created_at,
    status, origin and attrs, so the feature's first goal is the same again;
    fails_when=Undo merges a contribution in or makes a new link; no_claim=the web."""
    w = await World().build()
    await _loose(w)
    third = (await client.post(f"{URL}/goals", headers=w.as_("owner"), json=GOAL)).json()["goal"]
    before = await _edges(w, "loose")
    assert (await w.links(client))["loose"] == ["grow", "quiet"]

    move = {"from_goal_id": w.goals["grow"], "to_goal_id": third["id"]}
    r = await client.post(f"{URL}/features/{w.features['loose']}/move", headers=w.as_("owner"),
                          json=move)  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=r.json()["undo"])
    assert r.status_code == 200, r.text
    assert await _edges(w, "loose") == before
    assert (await w.links(client))["loose"] == ["grow", "quiet"]

    r = await client.post(f"{URL}/goals/{w.goals['grow']}/archive", headers=w.as_("owner"),
                          json={"to_goal_id": third["id"]})  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=r.json()["undo"])
    assert r.status_code == 200, r.text
    assert await _edges(w, "loose") == before
    assert (await w.links(client))["loose"] == ["grow", "quiet"]


@pytest.mark.asyncio
async def test_edit_keeps_typed_target_when_unchanged(client):
    """protects=editing a goal whose target Baseline typed (a number and a unit) keeps that
    typed target when the target text is the same; a new target is stored as text;
    fails_when=an edit that leaves the target alone drops Baseline's typed target;
    no_claim=parsing a new target."""
    w = await World().build()
    async with tenant_session(w.ctx.tenant_id) as s:
        typed = await Seed(s).entity("goal", "typed", position=3, metric="Shops live",
                                     target=40, unit="shops", due="2027-03-31")  # fmt: skip
        await s.commit()
    body = {"title": "Typed shops", "measure": "Shops live", "target": "40 shops",
            "due": "2027-03-31"}  # fmt: skip
    r = await client.patch(f"{URL}/goals/{typed.id}", headers=w.as_("owner"), json=body)
    assert r.status_code == 200, r.text
    assert r.json()["goal"]["target"] == "40 shops"
    async with tenant_session(w.ctx.tenant_id) as s:
        attrs = (await s.get(Entity, typed.id)).attrs
    assert (attrs.get("target"), attrs.get("unit")) == (40, "shops")
    assert "target_text" not in attrs

    r = await client.patch(f"{URL}/goals/{typed.id}", headers=w.as_("owner"),
                           json={**body, "target": "55 shops"})  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        attrs = (await s.get(Entity, typed.id)).attrs
    assert attrs.get("target_text") == "55 shops" and "target" not in attrs


@pytest.mark.asyncio
async def test_undo_takes_only_what_the_api_gave(client):
    """protects=Undo applies only the undo a write answered with: a changed snapshot (another
    goal's title, a forged link) is refused with 400 and changes nothing;
    fails_when=a client-made undo rewrites a goal; no_claim=the web."""
    w = await World().build()
    r = await client.patch(f"{URL}/goals/{w.goals['grow']}", headers=w.as_("owner"),
                           json={**GOAL, "title": "Grow shops"})  # fmt: skip
    assert r.status_code == 200, r.text
    undo = r.json()["undo"]
    forged = {**undo, "goals": [{**undo["goals"][0], "title": "Forged"}]}
    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=forged)
    assert r.status_code == 400, r.text
    made = {"goals": [{"id": w.goals["quiet"], "title": "Forged", "status": "confirmed",
                       "attrs": {}}], "features": [], "added_goal_id": None}  # fmt: skip
    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=made)
    assert r.status_code == 400, r.text
    titles = [g["title"] for g in (await w.read(client))["goals"]]
    assert titles == ["Grow shops", "Quiet"]
    r = await client.post(f"{URL}/undo", headers=w.as_("owner"), json=undo)
    assert r.status_code == 200, r.text
    assert [g["title"] for g in (await w.read(client))["goals"]] == ["Grow", "Quiet"]


@pytest.mark.asyncio
async def test_a_link_with_an_assumed_contribution_is_named(client):
    """Review of PR 1244, round 3: a supports link whose contribution is assumed (an approved
    order's new feature, ASSUMED_LINK) is listed in assumed_goal_ids, as the Ground Truth
    marks it; setting the contribution clears it."""
    w = await World().build()
    async with tenant_session(w.ctx.tenant_id) as s:
        added = await Seed(s).entity("feature", "added")
        s.add(Edge(src_id=added.id, dst_id=uuid.UUID(w.goals["quiet"]), type="supports",
                   status="proposed", origin="agent",
                   attrs={"contribution": 1, "contribution_assumed": True}))  # fmt: skip
        await s.commit()
    by_key = {f["key"]: f for f in (await w.read(client))["features"]}
    assert by_key["added"]["assumed_goal_ids"] == [w.goals["quiet"]]
    assert by_key["both"]["assumed_goal_ids"] == []
    # Dropped on its own goal: the link is kept, its contribution set (3), no longer assumed.
    body = {"from_goal_id": w.goals["grow"], "to_goal_id": w.goals["quiet"]}
    r = await client.post(f"{URL}/features/{added.id}/move", headers=w.as_("owner"), json=body)
    assert r.status_code == 200, r.text
    by_key = {f["key"]: f for f in (await w.read(client))["features"]}
    assert by_key["added"]["assumed_goal_ids"] == []
    assert [attrs for _, _, attrs, *_ in await _edges(w, "added")] == [{"contribution": 3}]
