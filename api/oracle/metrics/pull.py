"""Weekly values (H5): week bounds in the Company time zone, storing a value (the goal
link and the variance follow it), the 12-week backfill and the ticker's pulls.

Deterministic: no model call. A week runs Monday 00:00 to the next Monday 00:00 in the
Company time zone. The ticker (``pull_due``) reads, for each PostHog metric whose last
complete week has no value, that week's value: at most 20 queries per company per tick,
a failed pull retried on the next hourly attempt, and the metric ``error`` after 24
hours of failures.

The caller commits.
"""

import uuid
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, exists, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.baseline import service as baseline
from oracle.baseline.models import Entity, GoalMeasurement
from oracle.integrations.models import CompanyIntegration
from oracle.metrics import activate, causes, posthog, variance
from oracle.metrics.models import Metric, MetricValue, MetricVariance
from oracle.tenancy import current_tenant

BACKFILL_WEEKS = 12
MAX_QUERIES_PER_TICK = 20
RETRY_AFTER = timedelta(hours=1)
ERROR_AFTER = timedelta(hours=24)
DISCONNECTED = "Analytics disconnected"
READING_ATTRS = ("current", "current_as_of")


def now() -> datetime:
    return datetime.now(UTC)


def _zone(zone: str) -> ZoneInfo:
    try:
        return ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError):
        return ZoneInfo(company_time.DEFAULT_ZONE)


def week_bounds(week_start: date, zone: str) -> tuple[datetime, datetime]:
    """The week's start and end (exclusive) as UTC instants: Monday 00:00 to the next
    Monday 00:00 in ``zone`` (a DST change makes a week 167 or 169 hours)."""
    tz = _zone(zone)
    start = datetime.combine(week_start, time(0), tzinfo=tz)
    end = datetime.combine(week_start + timedelta(days=7), time(0), tzinfo=tz)
    return start.astimezone(UTC), end.astimezone(UTC)


def fill_query(query: str, start: datetime, end: datetime, zone: str) -> str:
    """``{period_start}`` and ``{period_end}`` as ISO timestamps in the Company time zone."""
    tz = _zone(zone)
    return query.replace("{period_start}", start.astimezone(tz).isoformat()).replace(
        "{period_end}", end.astimezone(tz).isoformat()
    )


def week_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


def last_complete_week(at: datetime, zone: str) -> date:
    """The Monday of the last week that has ended at ``at`` in ``zone``."""
    return week_of(at.astimezone(_zone(zone)).date()) - timedelta(weeks=1)


def recent_weeks(at: datetime, zone: str, n: int) -> list[date]:
    """The ``n`` complete weeks up to the last one, oldest first."""
    last = last_complete_week(at, zone)
    return [last - timedelta(weeks=n - 1 - i) for i in range(n)]


def number(value: Decimal | float | None) -> int | float | None:
    if value is None:
        return None
    f = float(value)
    return int(f) if f.is_integer() else f


# --- the connection ---------------------------------------------------------------------


async def integration(db: AsyncSession) -> CompanyIntegration | None:
    return await db.scalar(
        select(CompanyIntegration).where(
            CompanyIntegration.provider == posthog.PROVIDER,
            CompanyIntegration.purpose == posthog.PURPOSE,
        )
    )


async def connection(db: AsyncSession) -> posthog.Connection | None:
    row = await integration(db)
    if row is None or row.status != "active" or not row.ciphertext:
        return None
    config = row.config or {}
    return posthog.Connection(
        host=str(config.get("host", "")),
        project_id=str(config.get("project_id", "")),
        api_key=posthog.unseal(row.ciphertext),
    )


async def query_week(conn: posthog.Connection, query: str, week: date, zone: str) -> float:
    start, end = week_bounds(week, zone)
    return await posthog.query_number(conn, fill_query(query, start, end, zone))


# --- storing a value ----------------------------------------------------------------------


async def series(db: AsyncSession, metric: Metric, week: date) -> list[float | None]:
    """The metric's values for the 14 weeks up to ``week`` (oldest first; None: none)."""
    first = week - timedelta(weeks=variance.HISTORY + 1)
    found = {
        v.week_start: float(v.value)
        for v in await db.scalars(
            select(MetricValue).where(
                MetricValue.metric_id == metric.id,
                MetricValue.week_start.between(first, week),
            )
        )
    }
    return [found.get(first + timedelta(weeks=i)) for i in range(variance.HISTORY + 2)]


async def evaluate(db: AsyncSession, metric: Metric, week: date, zone: str) -> None:
    """The variance rule on ``week``: one row per (metric, week). An open row the rule no
    longer flags (a corrected value) goes; one a person answered stays."""
    got = variance.check(
        await series(db, metric, week),
        metric.direction,
        float(metric.threshold_pct) if metric.threshold_pct is not None else None,
    )
    row = await db.scalar(
        select(MetricVariance).where(
            MetricVariance.metric_id == metric.id, MetricVariance.week_start == week
        )
    )
    if got.variance is None:
        if row is not None and row.status == "open":
            await db.delete(row)
        return
    if row is not None and row.status != "open":
        return
    if row is None:
        row = MetricVariance(metric_id=metric.id, week_start=week)
        db.add(row)
    row.value = Decimal(str(got.value))
    row.previous = Decimal(str(got.previous))
    row.band_low = Decimal(str(got.band[0])) if got.band else None
    row.band_high = Decimal(str(got.band[1])) if got.band else None
    row.direction = got.variance
    row.possible_causes = await causes.possible_causes(db, metric, week, zone)
    await db.flush()


async def link_goal(db: AsyncSession, metric: Metric) -> None:
    """The goal's ``current`` and ``current_as_of`` from its latest measurement, through
    the ``reading`` writer: applied even to a locked goal, never locking it."""
    goal = await db.get(Entity, metric.goal_id) if metric.goal_id else None
    if goal is None or goal.type != "goal":
        return
    latest = await db.scalar(
        select(GoalMeasurement)
        .where(GoalMeasurement.entity_id == goal.id)
        .order_by(GoalMeasurement.measured_on.desc())
        .limit(1)
    )
    patch: dict[str, Any] = (
        {"current": number(latest.value), "current_as_of": latest.measured_on.isoformat()}
        if latest is not None
        else {"current": None, "current_as_of": None}
    )
    writer = baseline.Writer(None, "reading", reason=f"Weekly value from {metric.title}")
    await baseline.update_entity(db, writer, goal, {"attrs": patch})


async def _goal_measurement(
    db: AsyncSession, metric: Metric, week: date, value: Decimal | None
) -> None:
    if metric.goal_id is None or metric.kind != "output":
        return
    day = week + timedelta(days=6)
    if value is None:
        await db.execute(
            delete(GoalMeasurement).where(
                GoalMeasurement.entity_id == metric.goal_id,
                GoalMeasurement.measured_on == day,
                GoalMeasurement.metric_id == metric.id,
            )
        )
        return
    note = f"Weekly value from {metric.title}"
    await db.execute(
        insert(GoalMeasurement)
        .values(
            id=uuid.uuid4(), tenant_id=current_tenant(db), entity_id=metric.goal_id,
            measured_on=day, value=value, note=note, metric_id=metric.id, recorded_by=None,
        )
        .on_conflict_do_update(
            index_elements=["entity_id", "measured_on"],
            set_={"value": value, "note": note, "metric_id": metric.id, "recorded_by": None,
                  "evidence_id": None},
        )
    )  # fmt: skip


async def store(
    db: AsyncSession,
    metric: Metric,
    week: date,
    value: float,
    *,
    source: str,
    zone: str,
    recorded_by: uuid.UUID | None = None,
    note: str | None = None,
    replace: bool = True,
    check: bool = True,
) -> bool:
    """Store the week's value (replacing one already there unless ``replace`` is False),
    write the linked goal's measurement and run the variance rule. False when a value
    was there and kept."""
    amount = Decimal(str(value))
    stmt = insert(MetricValue).values(
        id=uuid.uuid4(), tenant_id=current_tenant(db), metric_id=metric.id, week_start=week,
        value=amount, source=source, definition_version=metric.definition_version, note=note,
        recorded_by=recorded_by, recorded_at=now(),
    )  # fmt: skip
    if replace:
        stmt = stmt.on_conflict_do_update(
            index_elements=["metric_id", "week_start"],
            set_={"value": amount, "source": source, "note": note, "recorded_by": recorded_by,
                  "definition_version": metric.definition_version, "recorded_at": now()},
        )  # fmt: skip
    else:
        stmt = stmt.on_conflict_do_nothing(index_elements=["metric_id", "week_start"])
    stored = (await db.execute(stmt.returning(MetricValue.id))).first() is not None
    if not stored:
        return False
    await _goal_measurement(db, metric, week, amount)
    if check:
        await evaluate(db, metric, week, zone)
    # The company's first weekly value: the metrics review takes over the goals check-in.
    await activate.activate_review(db)
    return True


async def remove(db: AsyncSession, metric: Metric, week: date, zone: str) -> bool:
    found = (
        await db.execute(
            delete(MetricValue)
            .where(MetricValue.metric_id == metric.id, MetricValue.week_start == week)
            .returning(MetricValue.id)
        )
    ).first()
    if found is None:
        return False
    await _goal_measurement(db, metric, week, None)
    await link_goal(db, metric)
    await evaluate(db, metric, week, zone)
    return True


# --- pulls --------------------------------------------------------------------------------


def _succeeded(metric: Metric, at: datetime) -> None:
    metric.attempts = 0
    metric.last_error = None
    metric.failing_since = None
    metric.next_pull_at = None
    metric.last_pulled_at = at
    if metric.status == "error":
        metric.status = "active"


def _failed(metric: Metric, message: str, at: datetime) -> None:
    metric.attempts += 1
    metric.last_error = message
    metric.failing_since = metric.failing_since or at
    metric.next_pull_at = at + RETRY_AFTER
    if at - metric.failing_since >= ERROR_AFTER:
        metric.status = "error"


async def pull_week(
    db: AsyncSession, metric: Metric, conn: posthog.Connection, week: date, zone: str,
    *, replace: bool,
) -> None:  # fmt: skip
    """Read one week from PostHog and store it; PostHogError when the read fails (the
    metric's pull state records it)."""
    at = now()
    try:
        value = await query_week(conn, metric.query or "", week, zone)
    except posthog.PostHogError as exc:
        _failed(metric, exc.message, at)
        await db.flush()
        raise
    await store(db, metric, week, value, source="posthog", zone=zone, replace=replace)
    _succeeded(metric, at)
    await db.flush()


async def backfill(db: AsyncSession, metric: Metric, conn: posthog.Connection) -> None:
    """The last 12 complete weeks, so the normal range works at once; the variance rule
    runs on the last one only. A failure stops it (the ticker retries the last week)."""
    zone = await company_time.company_time_zone(db)
    weeks = recent_weeks(now(), zone, BACKFILL_WEEKS)
    at = now()
    try:
        for week in weeks:
            value = await query_week(conn, metric.query or "", week, zone)
            await store(db, metric, week, value, source="posthog", zone=zone,
                        check=week == weeks[-1])  # fmt: skip
    except posthog.PostHogError as exc:
        _failed(metric, exc.message, at)
    else:
        _succeeded(metric, at)
    await link_goal(db, metric)
    await db.flush()


async def pull_due(db: AsyncSession) -> int:
    """The ticker step: each active (or failing) PostHog metric whose last complete week
    has no value and whose next attempt is due, at most 20 per tick. Overlapping ticks
    skip a metric another holds, and a value is never stored twice. Returns the values
    stored."""
    conn = await connection(db)
    if conn is None:
        return 0
    at = now()
    zone = await company_time.company_time_zone(db)
    week = last_complete_week(at, zone)
    has_week = exists().where(MetricValue.metric_id == Metric.id, MetricValue.week_start == week)
    due = list(
        await db.scalars(
            select(Metric)
            .where(
                Metric.source == "posthog",
                Metric.status.in_(("active", "error")),
                or_(Metric.next_pull_at.is_(None), Metric.next_pull_at <= at),
                ~has_week,
            )
            .order_by(Metric.created_at)
            .limit(MAX_QUERIES_PER_TICK)
            .with_for_update(skip_locked=True)
        )
    )
    stored = 0
    for metric in due:
        # Read again under the lock: an overlapping tick may have stored it meanwhile.
        if await db.scalar(
            select(MetricValue.id).where(
                MetricValue.metric_id == metric.id, MetricValue.week_start == week
            )
        ):
            continue
        attempt = now()
        try:
            value = await query_week(conn, metric.query or "", week, zone)
        except posthog.PostHogError as exc:
            _failed(metric, exc.message, attempt)
            await db.flush()
            continue
        async with db.begin_nested():
            if await store(db, metric, week, value, source="posthog", zone=zone, replace=False):
                await link_goal(db, metric)
                stored += 1
        _succeeded(metric, attempt)
        await db.flush()
    return stored


async def pause_all(db: AsyncSession) -> int:
    """Disconnect: every PostHog metric not archived is paused ("Analytics disconnected")."""
    rows = list(
        await db.scalars(
            select(Metric).where(Metric.source == "posthog", Metric.status != "archived")
        )
    )
    for m in rows:
        m.status, m.last_error = "paused", DISCONNECTED
    await db.flush()
    return len(rows)


async def resume_all(db: AsyncSession) -> None:
    """Connect again: the metrics Disconnect paused are active again."""
    for m in await db.scalars(
        select(Metric).where(
            Metric.source == "posthog", Metric.status == "paused",
            Metric.last_error == DISCONNECTED,
        )
    ):  # fmt: skip
        m.status, m.last_error = "active", None
        m.attempts, m.failing_since, m.next_pull_at = 0, None, None
    await db.flush()
