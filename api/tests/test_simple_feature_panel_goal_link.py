"""The one feature panel reads the goal a feature serves from the same link the Goal map and
its ladder draw (pre-demo QA P-6 / L-2): a feature under a goal milestone (MilestoneFeature),
with no goal set on the item itself, reads that goal and its measure. The world is the Goal
map's (tests.test_simple_goal_map_api.world). Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_a_feature_on_the_map_reads_its_goal: protects=``GET /v1/simple/roadmap`` gives an item
  under a goal milestone the milestone's goal, with its measure, for every role; f2 under two
  goals reads the first in the one goal order; fails_when=the panel says "No goal yet" for a
  feature the Goal map draws as helping a goal; no_claim=the goal a person sets in the panel
  (test_simple_panel_fields), which still wins.
- test_a_goal_set_on_the_item_wins: protects=a goal set on the item (its panel) is read over
  the map's link; fails_when=the panel's own change is lost.
"""

import pytest

from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_goal_map_api import world
from tests.test_simple_roadmap_api import by_key, get

pytestmark = pytest.mark.usefixtures("clock")


@pytest.fixture
def clock(monkeypatch):
    from oracle import company_time
    from tests.test_simple_goal_map_api import NOW

    monkeypatch.setattr(company_time, "now", lambda: NOW)


@pytest.mark.parametrize("role", ["owner", "viewer"])
async def test_a_feature_on_the_map_reads_its_goal(client, role):
    ctx, ids = await world()
    items = by_key(await get(client, ctx, role))
    f1, f2, f3 = items["one-tap-link"], items["guided-week"], items["rep-leaderboard"]
    assert f1["goal"] is not None, f1
    assert f1["goal"]["id"] == ids["signups"]
    assert f1["goal"]["metric"] == "sign-ups per rep per day"
    # Under M2 (sign-ups) and M3 (revenue): the first in the one goal order.
    assert f2["goal"]["id"] == ids["signups"]
    # On no milestone: no goal.
    assert f3["goal"] is None


async def test_a_goal_set_on_the_item_wins(client):
    ctx, ids = await world()
    import uuid

    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(ids["f1"]))
        row.goal_ids = [uuid.UUID(ids["revenue"])]
        await s.commit()
    items = by_key(await get(client, ctx, "owner"))
    assert items["one-tap-link"]["goal"]["id"] == ids["revenue"]
    assert items["one-tap-link"]["goal"]["metric"] == "revenue per day"
