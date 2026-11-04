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
- test_move_feature_and_undo: protects=moving a feature makes the new goal its first
  link and drops the old one; Undo restores both links; a viewer gets 403;
  fails_when=the old link stays or the new one is not first; no_claim=the web's drag.
"""

import pytest
from sqlalchemy import select

from oracle.baseline.models import Edge, Entity
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import make_people
from tests.test_simple_roadmap_api import Seed

URL = "/v1/simple/goal-buckets"
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
