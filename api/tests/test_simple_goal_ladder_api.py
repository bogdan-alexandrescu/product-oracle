"""Simple Goal map as the Goal ladder (goal-ladder): the canvas's own changes, against Postgres.
The world is the Goal map's (tests.test_simple_goal_map_api.world): three goals, gated goal
milestones M1, M2 and M3 and features f1 (under M1) and f2 (under M2 and M3). Invented
example data only.

Test cards (protects / fails_when / no_claim):

- test_place_card_is_per_person: protects=``POST /place-card`` stores where this person put
  a card and the map reads it back as theirs alone; another person still reads the ladder's
  places; fails_when=a place is shared or lost; no_claim=the web's canvas (Playwright).
- test_place_card_never_changes_data: protects=placing a card leaves the goals, milestones,
  features and links read exactly as before; fails_when=a place moves a feature to another
  milestone or goal; no_claim=Edit ladder's moves (test_move_a_feature_to_another_milestone).
- test_a_viewer_places_cards_for_themselves: protects=a viewer may place cards (their own
  view) though every edit is refused; fails_when=a viewer gets 403; no_claim=commenters.
- test_tidy_up_puts_back_only_my_cards and test_a_card_put_back_by_itself: protects=Tidy up
  (``DELETE /places``) and a place of null put cards back where the ladder places them for
  this person only; fails_when=another person's places go too.
- test_places_of_a_feature_in_trash_are_not_shown: protects=a feature moved to Trash has no
  place in the read, and its place shows again once restored; fails_when=a place of a
  trashed feature is read; no_claim=Trash's own pages.
- test_place_card_needs_a_feature_on_the_map: protects=a place for no feature is refused
  (404); fails_when=places pile up for any id.
- test_move_a_feature_to_another_milestone: protects=``POST /links/move`` moves a feature's
  link from one milestone to another, keeping its expected lift and area; approvers and up
  only; fails_when=the feature serves both or a commenter moves it.
- test_set_depends_refuses_a_loop: protects=the change engine refuses a dependency that
  makes a loop, saying which item already waits on which by code and name; fails_when=the
  loop is stored; no_claim=dates through dependencies.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import MilestoneFeature
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import make_people
from tests.test_simple_goal_map_api import URL, read, world
from tests.test_simple_panel_fields import Panel

PLACE = f"{URL}/place-card"
PLACES = f"{URL}/places"
MOVE = f"{URL}/links/move"
NOW = datetime(2026, 11, 3, 17, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def places(body: dict) -> dict[str, tuple[float, float]]:
    return {p["feature"]: (p["x"], p["y"]) for p in body["places"]}


async def place(client, ctx, role, feature, x, y):
    r = await client.post(PLACE, json={"feature": feature, "x": x, "y": y}, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


async def test_place_card_is_per_person(client):
    ctx, ids = await world()
    body = await place(client, ctx, "owner", ids["f1"], 1240.5, 80)
    assert places(body) == {ids["f1"]: (1240.5, 80)}
    assert places(await read(client, ctx, "owner")) == {ids["f1"]: (1240.5, 80)}
    assert places(await read(client, ctx, "approver")) == {}
    await place(client, ctx, "approver", ids["f1"], 10, 20)
    await place(client, ctx, "owner", ids["f1"], 300, 400)
    assert places(await read(client, ctx, "owner")) == {ids["f1"]: (300, 400)}
    assert places(await read(client, ctx, "approver")) == {ids["f1"]: (10, 20)}


async def test_place_card_never_changes_data(client):
    ctx, ids = await world()
    before = await read(client, ctx, "approver")
    await place(client, ctx, "owner", ids["f2"], 900, 30)
    after = await read(client, ctx, "approver")
    assert after == before
    mine = await read(client, ctx, "owner")
    assert {k: v for k, v in mine.items() if k not in ("places", "can_edit")} == {
        k: v for k, v in before.items() if k not in ("places", "can_edit")
    }


async def test_a_viewer_places_cards_for_themselves(client):
    ctx, ids = await world()
    body = await place(client, ctx, "viewer", ids["f1"], 50, 60)
    assert body["can_edit"] is False and places(body) == {ids["f1"]: (50, 60)}
    assert places(await read(client, ctx, "viewer")) == {ids["f1"]: (50, 60)}
    assert places(await read(client, ctx, "owner")) == {}


async def test_tidy_up_puts_back_only_my_cards(client):
    ctx, ids = await world()
    await place(client, ctx, "owner", ids["f1"], 1, 2)
    await place(client, ctx, "owner", ids["f2"], 3, 4)
    await place(client, ctx, "commenter", ids["f1"], 5, 6)
    r = await client.delete(PLACES, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert places(r.json()) == {}
    assert places(await read(client, ctx, "commenter")) == {ids["f1"]: (5, 6)}


async def test_a_card_put_back_by_itself(client):
    ctx, ids = await world()
    await place(client, ctx, "owner", ids["f1"], 1, 2)
    await place(client, ctx, "owner", ids["f2"], 3, 4)
    body = await place(client, ctx, "owner", ids["f1"], None, None)
    assert places(body) == {ids["f2"]: (3, 4)}


async def test_places_of_a_feature_in_trash_are_not_shown(client):
    ctx, ids = await world()
    await place(client, ctx, "owner", ids["f1"], 7, 8)
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, ids["f1"])
        item.deleted_at = NOW
        await s.commit()
    body = await read(client, ctx, "owner")
    assert ids["f1"] not in {f["id"] for f in body["features"]}
    assert places(body) == {}
    r = await client.post(
        PLACE, json={"feature": ids["f1"], "x": 1, "y": 1}, headers=ctx.as_("owner")
    )
    assert r.status_code == 404, r.text
    from oracle.trash.filter import INCLUDE_TRASHED

    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, ids["f1"], execution_options={INCLUDE_TRASHED: True})
        item.deleted_at = None
        await s.commit()
    assert places(await read(client, ctx, "owner")) == {ids["f1"]: (7, 8)}


async def test_place_card_needs_a_feature_on_the_map(client):
    ctx, ids = await world()
    for feature in (ids["m1"], ids["f3"]):
        r = await client.post(
            PLACE, json={"feature": feature, "x": 1, "y": 1}, headers=ctx.as_("owner")
        )
        assert r.status_code == 404, r.text


async def test_move_a_feature_to_another_milestone(client):
    ctx, ids = await world()
    body = {"feature": ids["f1"], "from_milestone": ids["m1"], "to_milestone": ids["m2"]}
    for role in ("commenter", "viewer"):
        r = await client.post(MOVE, json=body, headers=ctx.as_(role))
        assert r.status_code == 403, r.text
    r = await client.post(MOVE, json=body, headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    f1 = next(f for f in r.json()["features"] if f["id"] == ids["f1"])
    assert f1["milestones"] == [ids["m2"]]
    assert f1["expected"] == "+6 a day" and f1["area"] == ids["scale"]
    async with tenant_session(ctx.tenant_id) as s:
        links = (
            await s.scalars(select(MilestoneFeature).where(MilestoneFeature.item_id == ids["f1"]))
        ).all()
        assert [str(link.milestone_id) for link in links] == [ids["m2"]]
    # Onto a milestone it already serves: the old link goes, the feature is drawn once.
    r = await client.post(
        MOVE,
        json={"feature": ids["f2"], "from_milestone": ids["m2"], "to_milestone": ids["m3"]},
        headers=ctx.as_("owner"),
    )
    assert r.status_code == 200, r.text
    f2 = next(f for f in r.json()["features"] if f["id"] == ids["f2"])
    assert f2["milestones"] == [ids["m3"]]
    r = await client.post(
        MOVE,
        json={"feature": ids["f3"], "from_milestone": ids["m1"], "to_milestone": ids["m2"]},
        headers=ctx.as_("owner"),
    )
    assert r.status_code == 404, r.text


async def test_set_depends_refuses_a_loop(client):
    p = await Panel().build(await make_people())
    r = await p.post(client, "set_depends", {"depends_on": []}, {"depends_on": ["a"]}, item=p.b)
    assert r.status_code == 201, r.text
    items = await p.read(client)
    a, b = items["a"], items["b"]
    r = await p.post(client, "set_depends", {"depends_on": []}, {"depends_on": ["b"]}, item=p.a)
    assert r.status_code == 422, r.text
    words = r.json()["detail"]
    assert "loop" in words
    name = lambda i: f"{i['code'] or i['key']} {i['title']}"  # noqa: E731
    assert f"{name(b)} already waits on {name(a)}" in words
    assert (await p.read(client))["a"]["depends_keys"] == []
