"""The Goal map as the scoreboard (owner, Nov 5): where each goal's reading comes from and
what is missing, the gates with no feature and the features serving no gate, picking a
goal's metric from the map, and why a feature is helping (the reading before and after it
shipped). The world is test_simple_goal_map_api's (sign-ups and conversions read by hand,
revenue not measured). Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_each_goal_says_where_its_reading_comes_from: protects=a goal tied to a metric names
  it; a metric with no values reads missing "values", no metric and no reading reads
  missing "metric", readings typed by hand read nothing missing; fails_when=a gate cannot
  say why it is not measured; no_claim=the web's words.
- test_choices_are_the_outputs_that_fit: protects=a goal's picker lists the company's live
  output metrics in its unit that give no other goal its value, with their last value;
  fails_when=an input, an archived metric, another unit or a taken metric is offered.
- test_pick_a_metric_measures_the_goal: protects=picking a metric ties it to the goal and
  its weekly values become the goal's readings at once; another unit is refused; the
  goal's old metric lets go; fails_when=the goal stays not measured after a pick.
- test_pick_a_metric_needs_approver: protects=commenters and viewers are refused (403).
- test_gaps_and_unplaced_features: protects=a gated area cell with no feature is a gap and a
  confirmed roadmap feature linked to no gate is unplaced; attaching it removes both;
  fails_when=the counts do not move with the attach; no_claim=the web's drawer.
- test_lift_says_why: protects=a shipped feature's link reads its goal before and after it
  shipped and whether it helped; a link whose goal has no reading is not measured;
  fails_when=Helping is shown without the readings behind it.
"""

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest

from oracle.metrics.models import Metric, MetricValue
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_goal_map_api import URL, clock, read, world  # noqa: F401

LAST_MONDAY = date(2026, 10, 26)


async def metric(ctx, title: str, unit: str, goal: str | None = None, **kw) -> Metric:
    async with tenant_session(ctx.tenant_id) as s:
        m = Metric(
            title=title, description=f"{title} each week", kind=kw.pop("kind", "output"),
            unit=unit, direction="up", goal_id=uuid.UUID(goal) if goal else None,
            owner_id=ctx.users["owner"].id, source="manual", definition_version=1,
            status=kw.pop("status", "active"), attempts=0, lock_version=1, **kw,
        )  # fmt: skip
        s.add(m)
        await s.commit()
        return m


async def values(ctx, m: Metric, *vals: float) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        for i, v in enumerate(vals):
            week = LAST_MONDAY - timedelta(weeks=len(vals) - 1 - i)
            s.add(MetricValue(metric_id=m.id, week_start=week, value=Decimal(str(v)),
                              source="manual", definition_version=1))  # fmt: skip
        await s.commit()


async def test_each_goal_says_where_its_reading_comes_from(client):
    ctx, ids = await world()
    goals = {g["id"]: g for g in (await read(client, ctx))["goals"]}
    assert goals[ids["revenue"]]["metric"] is None
    assert goals[ids["revenue"]]["missing"] == "metric"
    assert goals[ids["signups"]]["missing"] is None
    weekly = await metric(ctx, "Weekly revenue", "$", ids["revenue"])
    await metric(ctx, "Paid conversions", "", ids["conv"])
    goals = {g["id"]: g for g in (await read(client, ctx, "viewer"))["goals"]}
    rev = goals[ids["revenue"]]
    assert rev["metric"] == {"id": str(weekly.id), "title": "Weekly revenue"}
    assert rev["missing"] == "values" and rev["status"] == "not_measured"
    conv = goals[ids["conv"]]
    assert conv["metric"]["title"] == "Paid conversions" and conv["missing"] is None


async def test_choices_are_the_outputs_that_fit(client):
    ctx, ids = await world()
    daily = await metric(ctx, "Daily revenue", "$")
    await values(ctx, daily, 9000, 11500)
    await metric(ctx, "Old revenue", "$", status="archived")
    await metric(ctx, "Refunds", "$", ids["conv"])
    out = await metric(ctx, "Sign-ups", "")
    await metric(ctx, "Calls made", "", kind="input", drives_metric_id=out.id)
    goals = {g["id"]: g for g in (await read(client, ctx))["goals"]}
    assert goals[ids["revenue"]]["choices"] == [
        {"id": str(daily.id), "title": "Daily revenue", "last": 11500.0}
    ]
    assert [c["title"] for c in goals[ids["signups"]]["choices"]] == ["Sign-ups"]
    assert goals[ids["signups"]]["choices"][0]["last"] is None


async def test_pick_a_metric_measures_the_goal(client):
    ctx, ids = await world()
    old = await metric(ctx, "Weekly revenue", "$", ids["revenue"])
    daily = await metric(ctx, "Daily revenue", "$")
    await values(ctx, daily, 9000, 11500)
    wrong = await metric(ctx, "Sign-ups", "")
    h = ctx.as_("approver")
    bad = await client.post(
        f"{URL}/goals/{ids['revenue']}/metric", json={"metric": str(wrong.id)}, headers=h
    )
    assert bad.status_code == 422, bad.text
    r = await client.post(
        f"{URL}/goals/{ids['revenue']}/metric", json={"metric": str(daily.id)}, headers=h
    )
    assert r.status_code == 200, r.text
    rev = next(g for g in r.json()["goals"] if g["id"] == ids["revenue"])
    assert rev["metric"]["title"] == "Daily revenue" and rev["missing"] is None
    assert rev["current"] == 11500 and rev["status"] == "at_risk"
    m3 = next(m for m in r.json()["milestones"] if m["id"] == ids["m3"])
    assert m3["current"] == 11500 and m3["status"] == "on_track"
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Metric, old.id)).goal_id is None
        assert (await s.get(Metric, daily.id)).goal_id == uuid.UUID(ids["revenue"])


@pytest.mark.parametrize("role", ["commenter", "viewer"])
async def test_pick_a_metric_needs_approver(client, role):
    ctx, ids = await world()
    daily = await metric(ctx, "Daily revenue", "$")
    r = await client.post(
        f"{URL}/goals/{ids['revenue']}/metric",
        json={"metric": str(daily.id)},
        headers=ctx.as_(role),
    )
    assert r.status_code == 403


async def test_gaps_and_unplaced_features(client):
    ctx, ids = await world()
    body = await read(client, ctx, "viewer")
    assert body["gaps"] == [{"milestone": ids["m2"], "area": ids["scale"]}]
    assert body["unplaced"] == [{"id": ids["f3"], "name": "Rep leaderboard"}]
    r = await client.post(
        f"{URL}/links",
        json={"feature": ids["f3"], "milestone": ids["m2"], "area": ids["scale"]},
        headers=ctx.as_("owner"),
    )
    assert r.status_code == 200, r.text
    assert r.json()["gaps"] == [] and r.json()["unplaced"] == []


async def test_lift_says_why(client):
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        f1 = await s.get(RoadmapItem, uuid.UUID(ids["f1"]))
        f1.shipped = {"note": "Live", "on": "2026-10-31"}
        await s.commit()
    feats = {f["id"]: f for f in (await read(client, ctx))["features"]}
    link = feats[ids["f1"]]["links"][0]
    assert link["shipped_on"] == "Oct 31"
    assert link["before"] == 27 and link["after"] == 31 and link["lift"] == "helping"
    f2 = {x["milestone"]: x for x in feats[ids["f2"]]["links"]}
    assert f2[ids["m3"]]["lift"] == "not_measured" and f2[ids["m3"]]["before"] is None
    assert f2[ids["m2"]]["shipped_on"] is None and f2[ids["m2"]]["after"] is None
