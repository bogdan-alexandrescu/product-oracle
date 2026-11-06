"""Goal ladder editing (goal-map-editing, the owner's ask of Nov 6: "this doesn't have delete
or drag-drop"): every feature on the ladder, a feature let go of a milestone, and a
milestone moved to Settings > Trash and back. The world is the Goal map's
(tests.test_simple_goal_map_api.world): goals sign-ups, conversions and revenue, milestones
M1, M2 (sign-ups) and M3 (revenue), f1 under M1, f2 under M2 and M3, f3 on no milestone.
Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_unplaced_names_the_goal_it_serves: protects=each feature serving no milestone reads
  the goal its roadmap item serves (``unplaced[].goal``), none when it serves none, so the
  ladder draws it under its goal ("Not on a key result") or in "No goal"; fails_when=the
  goal is missing or another item's; no_claim=the web's groups (Playwright).
- test_detach_a_feature_from_a_milestone: protects=``POST /links/detach`` takes one link
  off (the feature keeps its other milestone; with none left it is unplaced under its
  goal); approvers and up only; a link that is not there is 404; fails_when=a commenter
  detaches, both links go, or the feature is lost from the map.
- test_a_milestone_goes_to_trash_and_back: protects=deleting a goal milestone puts it in
  Settings > Trash (type ``milestone``, its name, who deleted it), off the map with its
  features unplaced; Trash's Restore puts it back with its links; fails_when=it is not
  listed in Trash, it stays on the map or comes back without its features.
- test_undo_of_a_milestone_delete_empties_its_trash_entry: protects=the milestone's own
  restore (the ladder's Undo) also takes its entry out of Trash; fails_when=Trash still
  lists a milestone that is back on the map.
- test_purging_a_milestone_deletes_it: protects=Delete for good removes the milestone and
  its links; fails_when=the row or a link is left behind.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update

from oracle import company_time
from oracle.roadmap.models import RoadmapItem, TrackMilestone
from oracle.simple.models import MilestoneFeature
from oracle.tenancy import tenant_session
from tests.test_simple_goal_map_api import URL, read, world

DETACH = f"{URL}/links/detach"
MILESTONE = "/v1/simple/milestones/{}"
NOW = datetime(2026, 11, 3, 17, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def unplaced(body: dict) -> dict[str, str | None]:
    return {f["id"]: f["goal"] for f in body["unplaced"]}


async def test_unplaced_names_the_goal_it_serves(client):
    ctx, ids = await world()
    assert unplaced(await read(client, ctx))[ids["f3"]] is None
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(RoadmapItem).where(RoadmapItem.id == ids["f3"]).values(goal_ids=[ids["conv"]])
        )
        await s.commit()
    for role in ("owner", "viewer"):
        assert unplaced(await read(client, ctx, role))[ids["f3"]] == ids["conv"]


async def test_detach_a_feature_from_a_milestone(client):
    ctx, ids = await world()
    body = {"feature": ids["f2"], "milestone": ids["m2"]}
    for role in ("commenter", "viewer"):
        r = await client.post(DETACH, json=body, headers=ctx.as_(role))
        assert r.status_code == 403, r.text
    r = await client.post(DETACH, json=body, headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    f2 = next(f for f in r.json()["features"] if f["id"] == ids["f2"])
    assert f2["milestones"] == [ids["m3"]]
    r = await client.post(DETACH, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 404, r.text
    r = await client.post(
        DETACH, json={"feature": ids["f1"], "milestone": ids["m1"]}, headers=ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert ids["f1"] not in {f["id"] for f in out["features"]}
    assert ids["f1"] in unplaced(out)
    async with tenant_session(ctx.tenant_id) as s:
        left = (
            await s.scalars(select(MilestoneFeature).where(MilestoneFeature.item_id == ids["f1"]))
        ).all()
        assert left == []


async def trash_entries(client, ctx) -> list[dict]:
    r = await client.get("/v1/trash", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return [e for e in r.json() if e["root"]["type"] == "milestone"]


async def test_a_milestone_goes_to_trash_and_back(client):
    ctx, ids = await world()
    r = await client.delete(MILESTONE.format(ids["m1"]), headers=ctx.as_("owner"))
    assert r.status_code == 204, r.text
    [entry] = await trash_entries(client, ctx)
    assert entry["root"]["id"] == ids["m1"]
    assert entry["root"]["title"] == "25 sign-ups per rep"
    assert entry["root"]["kind"] == "Milestone"
    body = await read(client, ctx)
    assert ids["m1"] not in {m["id"] for m in body["milestones"]}
    assert ids["f1"] in unplaced(body)
    r = await client.post(f"/v1/trash/{entry['id']}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await trash_entries(client, ctx) == []
    body = await read(client, ctx)
    assert ids["m1"] in {m["id"] for m in body["milestones"]}
    f1 = next(f for f in body["features"] if f["id"] == ids["f1"])
    assert f1["milestones"] == [ids["m1"]]


async def test_undo_of_a_milestone_delete_empties_its_trash_entry(client):
    ctx, ids = await world()
    r = await client.delete(MILESTONE.format(ids["m2"]), headers=ctx.as_("owner"))
    assert r.status_code == 204, r.text
    assert len(await trash_entries(client, ctx)) == 1
    r = await client.post(MILESTONE.format(ids["m2"]) + "/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await trash_entries(client, ctx) == []
    assert ids["m2"] in {m["id"] for m in (await read(client, ctx))["milestones"]}


async def test_purging_a_milestone_deletes_it(client):
    ctx, ids = await world()
    r = await client.delete(MILESTONE.format(ids["m3"]), headers=ctx.as_("owner"))
    assert r.status_code == 204, r.text
    [entry] = await trash_entries(client, ctx)
    r = await client.delete(f"/v1/trash/{entry['id']}", headers=ctx.as_("owner"))
    assert r.status_code == 204, r.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(TrackMilestone, ids["m3"]) is None
        links = (
            await s.scalars(
                select(MilestoneFeature).where(MilestoneFeature.milestone_id == ids["m3"])
            )
        ).all()
        assert links == []
