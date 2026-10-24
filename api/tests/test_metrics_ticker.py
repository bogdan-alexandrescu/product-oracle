"""H5 Metrics review, lane 1: the ticker's pulls (retries, no duplicates, isolation), the
goal link through the ``reading`` writer, H3's ``metric`` source and the possible
causes' order. PostHog is a fake transport (the real API's shape is not exercised)."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, update

from oracle.baseline.models import Edge, Entity, EntityRevision, GoalMeasurement, Proposal
from oracle.launches.models import Launch
from oracle.metrics import causes
from oracle.metrics.models import Metric, MetricValue
from oracle.quality import shipping
from oracle.tenancy import tenant_session
from oracle.ticker import router as ticker
from tests import metrics_helpers, test_roadmap
from tests.baseline_helpers import make_ctx
from tests.metrics_helpers import (
    LAST_WEEK,
    NOW,
    QUERY,
    connect,
    create,
    pct_goal,
)

# Fixtures (assigned, so ruff does not read the test arguments as redefinitions).
clock = metrics_helpers.clock
fake_posthog = metrics_helpers.fake_posthog
owner = test_roadmap.owner
runtime = test_roadmap.runtime


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _tick(tenant_id) -> None:
    out = ticker.TickerOut()
    await ticker._tick_company(tenant_id, out, ticker._Failures(out))


async def _metric(tenant_id, metric_id) -> Metric:
    async with tenant_session(tenant_id) as s:
        return await s.get(Metric, metric_id)


async def _count(tenant_id) -> int:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(MetricValue))


# protects=criterion 5: with the last complete week missing one tick stores it; ten more
# ticks, two of them overlapping, store no duplicate and query no more; fails_when=a tick
# misses the week, stores it twice or re-queries a stored week; no_claim=the hourly
# cadence of the scheduler itself.
async def test_one_tick_stores_the_missing_week_once(client, ctx, clock, fake_posthog):
    assert (await connect(client, ctx)).status_code == 200
    metric = (await create(client, ctx, source="posthog", query=QUERY)).json()
    assert await _count(ctx.tenant_id) == 12
    clock.at(NOW + timedelta(days=7))
    await _tick(ctx.tenant_id)
    assert await _count(ctx.tenant_id) == 13
    sent = len(fake_posthog.requests)
    for _ in range(4):
        await _tick(ctx.tenant_id)
    await asyncio.gather(_tick(ctx.tenant_id), _tick(ctx.tenant_id))
    for _ in range(4):
        await _tick(ctx.tenant_id)
    assert await _count(ctx.tenant_id) == 13
    assert len(fake_posthog.requests) == sent
    row = await _metric(ctx.tenant_id, metric["id"])
    assert row.last_pulled_at is not None and row.attempts == 0


# protects=criterion 5: a provider 500 increments attempts and is retried on the next
# hourly attempt (not sooner); after 24 hours of failures the metric is error; another
# company's metric is pulled in the same pass; fails_when=a failure stops the other
# company, retries every tick, or never reaches error; no_claim=the Inbox row (lane 2).
async def test_failures_retry_hourly_then_error(client, ctx, clock, fake_posthog):
    assert (await connect(client, ctx)).status_code == 200
    metric = (await create(client, ctx, source="posthog", query=QUERY)).json()
    other = await make_ctx("Other Co")
    assert (await connect(client, other, project_id="67890")).status_code == 200
    theirs = (await create(client, other, source="posthog", query=QUERY)).json()
    fake_posthog.failing = {"12345"}
    start = NOW + timedelta(days=7)
    clock.at(start)
    await _tick(ctx.tenant_id)
    await _tick(other.tenant_id)
    row = await _metric(ctx.tenant_id, metric["id"])
    assert (row.attempts, row.status) == (1, "active")
    assert "Query failed upstream" in row.last_error
    assert (await _metric(other.tenant_id, theirs["id"])).last_pulled_at is not None
    assert await _count(other.tenant_id) == 13
    clock.at(start + timedelta(minutes=30))
    await _tick(ctx.tenant_id)
    assert (await _metric(ctx.tenant_id, metric["id"])).attempts == 1
    clock.at(start + timedelta(hours=1, minutes=1))
    await _tick(ctx.tenant_id)
    assert (await _metric(ctx.tenant_id, metric["id"])).attempts == 2
    clock.at(start + timedelta(hours=24, minutes=5))
    await _tick(ctx.tenant_id)
    row = await _metric(ctx.tenant_id, metric["id"])
    assert row.status == "error"
    fake_posthog.failing = set()
    clock.at(start + timedelta(hours=25, minutes=10))
    await _tick(ctx.tenant_id)
    row = await _metric(ctx.tenant_id, metric["id"])
    assert (row.status, row.attempts, row.last_error) == ("active", 0, None)
    assert await _count(ctx.tenant_id) == 13


# protects=criterion 6: an output metric linked to a % goal writes the goal's
# measurement on the week's last day (metric_id set, recorded_by null) and its current,
# as actor system; the goal's locked flag is unchanged and no proposal is made though the
# goal is locked; a person's POST .../measurements is then 409; fails_when=the value goes
# through a user writer (locking) or an agent writer (a proposal), or a person can still
# record; no_claim=the chart.
async def test_goal_link_writes_the_goals_value(client, ctx, clock):
    goal = await pct_goal(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        locked = (await s.get(Entity, goal["id"])).locked
    assert locked is True
    metric = (await create(client, ctx, unit="%", goal_id=goal["id"])).json()
    resp = await client.put(f"/v1/metrics/{metric['id']}/values/{LAST_WEEK}",
                            json={"value": 41.5}, headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    sunday = LAST_WEEK + timedelta(days=6)
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(GoalMeasurement)))
        assert len(rows) == 1
        m = rows[0]
        assert (m.measured_on, float(m.value), str(m.metric_id), m.recorded_by) == (
            sunday, 41.5, metric["id"], None,
        )  # fmt: skip
        assert m.note == "Weekly value from Weekly active teams"
        g = await s.get(Entity, goal["id"])
        assert (g.attrs["current"], g.attrs["current_as_of"]) == (41.5, sunday.isoformat())
        assert g.locked is True
        assert await s.scalar(select(func.count()).select_from(Proposal)) == 0
        rev = await s.scalar(
            select(EntityRevision).where(EntityRevision.entity_id == g.id)
            .order_by(EntityRevision.created_at.desc()).limit(1)
        )  # fmt: skip
        assert rev.actor == "system"
    resp = await client.post(
        f"/v1/baseline/entities/{goal['id']}/measurements",
        json={"value": 40, "measured_on": LAST_WEEK.isoformat()},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 409
    assert "This goal's value comes from Weekly active teams. Record values on the metric." in (
        resp.text
    )


# protects=the reading writer changes only current and current_as_of; fails_when=it can
# write any other goal field; no_claim=other entity types.
async def test_the_reading_writer_writes_only_the_value(client, ctx):
    from oracle.baseline import service

    goal = await pct_goal(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        g = await s.get(Entity, goal["id"])
        writer = service.Writer(None, "reading", reason="Weekly value")
        with pytest.raises(service.InvalidError):
            await service.update_entity(s, writer, g, {"attrs": {"target": 99}})
        with pytest.raises(service.InvalidError):
            await service.update_entity(s, writer, g, {"title": "Other"})


# protects=criterion 7: H3 judges a linked goal on the metric's value, with source
# "metric"; fails_when=the source reads "measurement"; no_claim=the verdict rule.
async def test_h3_reads_the_metric_source(client, ctx, clock):
    goal = await pct_goal(client, ctx)
    metric = (await create(client, ctx, unit="%", goal_id=goal["id"])).json()
    await client.put(f"/v1/metrics/{metric['id']}/values/{LAST_WEEK}", json={"value": 43},
                     headers=ctx.as_("approver"))  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        found = await shipping.actual_value(s, goal["id"], None)
    value, on, _, _, source = found
    assert (value, on, source) == (43, LAST_WEEK + timedelta(days=6), "metric")


# protects=the possible causes' order: a launch of a feature serving the metric's goal
# comes before an unrelated launch, and a definition change that week is listed;
# fails_when=launches are listed by date only or the definition change is missing;
# no_claim=changelog and decision causes' wording.
async def test_causes_put_the_goals_launch_first(client, owner, runtime):
    from tests.launch_helpers import launched_world

    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    pay, ship = by_item["payment-step"]["id"], by_item["shipping-step"]["id"]
    async with tenant_session(tenant_id) as s:
        goal = await s.scalar(select(Entity).where(Entity.type == "goal"))
        feature = await s.scalar(select(Entity).where(Entity.key == "shipping-step"))
        await s.execute(update(Edge).where(Edge.src_id == feature.id, Edge.dst_id == goal.id)
                        .values(status="rejected"))  # fmt: skip
        # The unrelated launch is the later one, so date order alone would list it first.
        for launch_id, day in ((pay, 13), (ship, 15)):
            await s.execute(update(Launch).where(Launch.id == launch_id).values(
                state="launched", launched_at=datetime(2026, 10, day, 18, tzinfo=UTC)))  # fmt: skip
        metric = Metric(
            title="Activated teams", description="Teams that finished setup", kind="output",
            unit="%", direction="up", goal_id=goal.id, owner_id=goal.id, source="manual",
            definition_version=2,
            definitions=[
                {"version": 1, "unit": "%", "query": None, "at": "2026-09-01T00:00:00+00:00"},
                {"version": 2, "unit": "%", "query": None, "at": "2026-10-14T00:00:00+00:00"},
            ],
        )  # fmt: skip
        s.add(metric)
        await s.flush()
        found = await causes.possible_causes(s, metric, LAST_WEEK, "America/Los_Angeles")
    kinds = [(c["kind"], c["href"]) for c in found]
    launches = [h for k, h in kinds if k == "launch"]
    assert launches == [f"/roadmap/launches?launch={pay}", f"/roadmap/launches?launch={ship}"]
    assert ("definition", f"/company/metrics?metric={metric.id}") in kinds
    definition = next(c for c in found if c["kind"] == "definition")
    assert definition["title"] == "The metric's definition changed"
    assert len(found) <= 8
