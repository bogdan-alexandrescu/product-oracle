"""The metric catalog (H5): create, edit, archive, values by hand or by API, variances
explained, and what the API returns. The caller commits."""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.auth.models import User
from oracle.baseline import goals
from oracle.baseline.models import Entity
from oracle.members.names import display_name
from oracle.metrics import posthog, pull
from oracle.metrics.models import Metric, MetricValue, MetricVariance
from oracle.metrics.schemas import (
    Band,
    Change,
    Definition,
    MetricCreate,
    MetricDetail,
    MetricOut,
    MetricPatch,
    MetricTestWeek,
    MetricValueOut,
    PossibleCause,
    VarianceOut,
    WeekValue,
)

SPARK_WEEKS = 12
CHART_WEEKS = 52
MAX_FIND_OUT_DAYS = 28
NOT_CONNECTED = "Connect PostHog in Settings › Analytics first"


class MetricError(Exception):
    status_code = 422

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


def _missing(what: str = "Metric") -> MetricError:
    return MetricError(f"{what} not found", 404)


async def get(db: AsyncSession, metric_id: uuid.UUID, *, for_update: bool = False) -> Metric:
    stmt = select(Metric).where(Metric.id == metric_id)
    if for_update:
        stmt = stmt.with_for_update()
    row = await db.scalar(stmt)
    if row is None:
        raise _missing()
    return row


async def get_variance(
    db: AsyncSession, variance_id: uuid.UUID, *, for_update: bool = False
) -> MetricVariance:
    stmt = select(MetricVariance).where(MetricVariance.id == variance_id)
    if for_update:
        stmt = stmt.with_for_update()
    row = await db.scalar(stmt)
    if row is None:
        raise _missing("Variance")
    return row


# --- checks -------------------------------------------------------------------------------


async def _check(db: AsyncSession, m: dict[str, Any], metric: Metric | None) -> None:
    if not goals.unit_ok(m["unit"]):
        raise MetricError(f"Unknown unit {m['unit']!r}: use a goal unit (%, USD, ms, ...)")
    if m["kind"] == "input":
        if m.get("drives_metric_id") is None:
            raise MetricError("An input needs the output it drives")
        if m.get("goal_id") is not None:
            raise MetricError("Only an output links a goal")
        if metric is not None and m["drives_metric_id"] == metric.id:
            raise MetricError("A metric cannot drive itself")
        target = await db.get(Metric, m["drives_metric_id"])
        if target is None or target.status == "archived":
            raise MetricError("The metric it drives was not found")
        if target.kind != "output":
            # Inputs drive outputs only, so drives links never make a cycle.
            raise MetricError("An input drives an output, never another input")
    elif m.get("drives_metric_id") is not None:
        raise MetricError("An output drives no other metric")
    if m.get("goal_id") is not None:
        goal = await db.get(Entity, m["goal_id"])
        if goal is None or goal.type != "goal" or goal.status != "confirmed":
            raise MetricError("Link a confirmed goal")
        unit = (goal.attrs or {}).get("unit")
        if unit != m["unit"]:
            raise MetricError(f"The metric's unit must match the goal's unit ({unit or 'none'})")
    owner = await db.get(User, m["owner_id"])
    if owner is None or owner.disabled_at is not None:
        raise MetricError("The owner must be a member")


async def _title_taken(db: AsyncSession, title: str, metric: Metric | None) -> None:
    stmt = select(Metric.id).where(
        func.lower(Metric.title) == title.strip().lower(), Metric.status != "archived"
    )
    if metric is not None:
        stmt = stmt.where(Metric.id != metric.id)
    if await db.scalar(stmt) is not None:
        raise MetricError("A metric with this title exists", 409)


async def _goal_taken(db: AsyncSession, goal_id: uuid.UUID | None, metric: Metric | None) -> None:
    if goal_id is None:
        return
    stmt = select(Metric.id).where(Metric.goal_id == goal_id, Metric.status != "archived")
    if metric is not None:
        stmt = stmt.where(Metric.id != metric.id)
    if await db.scalar(stmt) is not None:
        raise MetricError("Another metric already gives this goal its value", 409)


def _query(query: str | None) -> None:
    """A PostHog metric's query: one read-only SELECT over the allowed tables (422)."""
    if query is None:
        return
    try:
        posthog.check_query(query)
    except posthog.QueryRefused as exc:
        raise MetricError(str(exc)) from None


def _definition(metric: Metric) -> dict[str, Any]:
    return {
        "version": metric.definition_version,
        "unit": metric.unit,
        "query": metric.query,
        "at": datetime.now(UTC).isoformat(),
    }


# --- writes -------------------------------------------------------------------------------


async def create(db: AsyncSession, actor_id: uuid.UUID | None, body: MetricCreate) -> Metric:
    data = body.model_dump()
    data["title"] = data["title"].strip()
    if (body.source == "posthog") != (body.query is not None):
        raise MetricError("A PostHog metric has a query; others have none")
    _query(body.query)
    await _check(db, data, None)
    await _title_taken(db, data["title"], None)
    await _goal_taken(db, body.goal_id, None)
    conn = None
    if body.source == "posthog":
        conn = await pull.connection(db)
        if conn is None:
            raise MetricError(NOT_CONNECTED, 409)
    metric = Metric(**data, created_by=actor_id, definition_version=1, status="active",
                    attempts=0, lock_version=1)  # fmt: skip
    metric.definitions = [_definition(metric)]
    db.add(metric)
    await db.flush()
    if conn is not None:
        await pull.backfill(db, metric, conn)
    return metric


async def update(db: AsyncSession, metric: Metric, body: MetricPatch) -> Metric:
    if body.lock_version != metric.lock_version:
        raise MetricError("The metric changed since you opened it; reload it", 409)
    if metric.status == "archived":
        raise MetricError("Restore the metric before editing it", 409)
    changes = body.model_dump(include=body.model_fields_set - {"lock_version"})
    if "query" in changes and (metric.source == "posthog") != (changes["query"] is not None):
        raise MetricError("Only a PostHog metric has a query")
    if "query" in changes:
        _query(changes["query"])
    merged = {
        c: getattr(metric, c)
        for c in ("title", "unit", "kind", "goal_id", "drives_metric_id", "owner_id")
    }
    merged.update(changes)
    await _check(db, merged, metric)
    if "title" in changes:
        changes["title"] = changes["title"].strip()
        await _title_taken(db, changes["title"], metric)
    if "goal_id" in changes:
        await _goal_taken(db, changes["goal_id"], metric)
    redefined = any(k in changes and changes[k] != getattr(metric, k) for k in ("query", "unit"))
    for k, v in changes.items():
        setattr(metric, k, v)
    if redefined:
        metric.definition_version += 1
        metric.definitions = [*(metric.definitions or []), _definition(metric)]
    metric.lock_version += 1
    await db.flush()
    return metric


async def set_archived(db: AsyncSession, metric: Metric, archived: bool) -> Metric:
    if archived:
        metric.status = "archived"
    elif metric.status == "archived":
        await _title_taken(db, metric.title, metric)
        await _goal_taken(db, metric.goal_id, metric)
        metric.status = "active"
        if metric.source == "posthog" and await pull.connection(db) is None:
            metric.status, metric.last_error = "paused", pull.DISCONNECTED
    metric.lock_version += 1
    await db.flush()
    return metric


async def company_today(db: AsyncSession, zone: str) -> date:
    return company_time.day(pull.now(), zone)


async def record_value(
    db: AsyncSession, metric: Metric, week: date, value: float, note: str | None,
    actor_id: uuid.UUID | None,
) -> MetricValue:  # fmt: skip
    if metric.source == "posthog":
        raise MetricError("This metric's values are read from PostHog", 409)
    if metric.status == "archived":
        raise MetricError("Restore the metric before recording a value", 409)
    if week.weekday() != 0:
        raise MetricError("A week starts on a Monday")
    zone = await company_time.company_time_zone(db)
    if week > pull.last_complete_week(pull.now(), zone):
        raise MetricError("A value is recorded for a week that has ended")
    await pull.store(db, metric, week, value, source=metric.source, zone=zone,
                     recorded_by=actor_id, note=note)  # fmt: skip
    await pull.link_goal(db, metric)
    await db.flush()
    row = await db.scalar(
        select(MetricValue)
        .where(MetricValue.metric_id == metric.id, MetricValue.week_start == week)
        .execution_options(populate_existing=True)
    )
    assert row is not None
    return row


async def delete_value(db: AsyncSession, metric: Metric, week: date) -> None:
    if metric.source == "posthog":
        raise MetricError("This metric's values are read from PostHog", 409)
    zone = await company_time.company_time_zone(db)
    if not await pull.remove(db, metric, week, zone):
        raise _missing("Value")


async def pull_now(db: AsyncSession, metric: Metric) -> None:
    if metric.source != "posthog":
        raise MetricError("Only a PostHog metric is pulled", 409)
    if metric.status == "archived":
        raise MetricError("Restore the metric before pulling it", 409)
    conn = await pull.connection(db)
    if conn is None:
        raise MetricError(NOT_CONNECTED, 409)
    zone = await company_time.company_time_zone(db)
    week = pull.last_complete_week(pull.now(), zone)
    await pull.pull_week(db, metric, conn, week, zone, replace=True)
    await pull.link_goal(db, metric)


async def test_query(db: AsyncSession, query: str) -> tuple[list[MetricTestWeek], str | None]:
    _query(query)
    conn = await pull.connection(db)
    if conn is None:
        raise MetricError(NOT_CONNECTED, 409)
    zone = await company_time.company_time_zone(db)
    out = []
    try:
        for week in pull.recent_weeks(pull.now(), zone, 4):
            value = await pull.query_week(conn, query, week, zone)
            out.append(MetricTestWeek(week_start=week, value=value))
    except posthog.PostHogError as exc:
        return [], exc.message
    return out, None


def _lock(row: MetricVariance, lock_version: int | None) -> None:
    if lock_version is not None and lock_version != row.lock_version:
        raise MetricError("The variance changed since you opened it; reload it", 409)


async def explain(
    db: AsyncSession, row: MetricVariance, text: str, actor_id: uuid.UUID | None,
    lock_version: int | None,
) -> MetricVariance:  # fmt: skip
    _lock(row, lock_version)
    row.status, row.explanation = "explained", text.strip()
    row.explained_by, row.explained_at = actor_id, datetime.now(UTC)
    row.find_out_by = None
    row.lock_version += 1
    await db.flush()
    return row


async def unknown(
    db: AsyncSession, row: MetricVariance, find_out_by: date, lock_version: int | None
) -> MetricVariance:
    _lock(row, lock_version)
    if row.status in ("explained", "noise"):
        raise MetricError("This variance is already answered", 409)
    zone = await company_time.company_time_zone(db)
    today = await company_today(db, zone)
    if not today < find_out_by <= today + timedelta(days=MAX_FIND_OUT_DAYS):
        raise MetricError(f"Pick a day 1 to {MAX_FIND_OUT_DAYS} days ahead")
    row.status, row.find_out_by = "unknown", find_out_by
    row.lock_version += 1
    await db.flush()
    return row


async def noise(
    db: AsyncSession, row: MetricVariance, reason: str, actor_id: uuid.UUID | None,
    lock_version: int | None,
) -> MetricVariance:  # fmt: skip
    _lock(row, lock_version)
    row.status, row.noise_reason = "noise", reason.strip()
    row.explained_by, row.explained_at = actor_id, datetime.now(UTC)
    row.find_out_by = None
    row.lock_version += 1
    await db.flush()
    return row


# --- reads --------------------------------------------------------------------------------


async def names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return {
        u.id: display_name(u.email, u.name)
        for u in await db.scalars(select(User).where(User.id.in_(wanted)))
    }


async def _values(db: AsyncSession, metric_ids: list[uuid.UUID], since: date) -> dict:
    out: dict[uuid.UUID, list[MetricValue]] = {i: [] for i in metric_ids}
    for v in await db.scalars(
        select(MetricValue)
        .where(MetricValue.metric_id.in_(metric_ids), MetricValue.week_start >= since)
        .order_by(MetricValue.week_start)
    ):
        out[v.metric_id].append(v)
    return out


def _out(
    metric: Metric, values: list[MetricValue], last: date, owner_names: dict,
    flagged: dict[tuple[uuid.UUID, date], str],
) -> dict[str, Any]:  # fmt: skip
    by_week = {v.week_start: float(v.value) for v in values}
    spark_weeks = [last - timedelta(weeks=SPARK_WEEKS - 1 - i) for i in range(SPARK_WEEKS)]
    latest = max((v for v in values), key=lambda v: v.week_start, default=None)
    change = None
    if latest is not None:
        before = by_week.get(latest.week_start - timedelta(weeks=1))
        if before is not None:
            diff = float(latest.value) - before
            change = Change(
                value=pull.number(diff),
                pct=round(diff / before * 100, 1) if before else None,
                variance=flagged.get((metric.id, latest.week_start)),  # type: ignore[arg-type]
            )
    return {
        "id": metric.id, "title": metric.title, "description": metric.description,
        "kind": metric.kind, "unit": metric.unit, "direction": metric.direction,
        "goal_id": metric.goal_id, "drives_metric_id": metric.drives_metric_id,
        "owner_id": metric.owner_id, "owner_name": owner_names.get(metric.owner_id),
        "source": metric.source, "query": metric.query,
        "threshold_pct": float(metric.threshold_pct) if metric.threshold_pct is not None
        else None,
        "status": metric.status, "definition_version": metric.definition_version,
        "last_week": WeekValue(week_start=latest.week_start, value=pull.number(latest.value))
        if latest is not None else None,
        "change": change,
        "spark": [pull.number(by_week.get(w)) for w in spark_weeks],
        "last_pulled_at": metric.last_pulled_at, "last_error": metric.last_error,
        "lock_version": metric.lock_version,
    }  # fmt: skip


async def _flagged(db: AsyncSession, metric_ids: list[uuid.UUID]) -> dict:
    return {
        (v.metric_id, v.week_start): v.direction
        for v in await db.scalars(
            select(MetricVariance).where(MetricVariance.metric_id.in_(metric_ids))
        )
    }


async def outs(db: AsyncSession, metrics: list[Metric]) -> list[MetricOut]:
    if not metrics:
        return []
    zone = await company_time.company_time_zone(db)
    last = pull.last_complete_week(pull.now(), zone)
    ids = [m.id for m in metrics]
    values = await _values(db, ids, last - timedelta(weeks=SPARK_WEEKS + 1))
    owner_names = await names(db, {m.owner_id for m in metrics})
    flagged = await _flagged(db, ids)
    return [MetricOut(**_out(m, values[m.id], last, owner_names, flagged)) for m in metrics]


async def listed(db: AsyncSession, include_archived: bool) -> list[MetricOut]:
    """Outputs first, each followed by the inputs that drive it (then by title)."""
    stmt = select(Metric).order_by(func.lower(Metric.title))
    if not include_archived:
        stmt = stmt.where(Metric.status != "archived")
    return await outs(db, ordered(list(await db.scalars(stmt))))


def ordered(rows: list[Metric]) -> list[Metric]:
    """Outputs first, each followed by the inputs that drive it; ``rows``' order kept
    otherwise."""
    out: list[Metric] = []
    for output in (m for m in rows if m.kind == "output"):
        out.append(output)
        out += [m for m in rows if m.drives_metric_id == output.id]
    out += [m for m in rows if m not in out]
    return out


async def variance_outs(
    db: AsyncSession, rows: list[MetricVariance], *, as_member: bool = False
) -> list[VarianceOut]:
    """``as_member``: Oracle's drafts as a commenter may see them (a pre-read's)."""
    metrics = {
        m.id: m
        for m in await db.scalars(select(Metric).where(Metric.id.in_({r.metric_id for r in rows})))
    }
    who = await names(db, {r.explained_by for r in rows})
    withheld = await _withheld_drafts(db, rows, as_member=as_member)
    out = []
    for r in rows:
        m = metrics[r.metric_id]
        value, previous = float(r.value), float(r.previous)
        out.append(VarianceOut(
            id=r.id, metric_id=r.metric_id, metric_title=m.title, owner_id=m.owner_id,
            week_start=r.week_start, value=pull.number(value), previous=pull.number(previous),
            change=pull.number(value - previous),
            change_pct=round((value - previous) / previous * 100, 1) if previous else None,
            band=Band(low=pull.number(r.band_low), high=pull.number(r.band_high))
            if r.band_low is not None and r.band_high is not None else None,
            direction=r.direction, status=r.status, explanation=r.explanation,
            explained_by_name=who.get(r.explained_by) if r.status == "explained" else None,
            find_out_by=r.find_out_by, noise_reason=r.noise_reason,
            oracle_draft=None if r.id in withheld else r.oracle_draft,
            oracle_confidence=None if r.id in withheld else r.oracle_confidence,
            possible_causes=[PossibleCause(**c) for c in r.possible_causes or []],
            lock_version=r.lock_version,
        ))  # fmt: skip
    return out


async def _withheld_drafts(
    db: AsyncSession, rows: list[MetricVariance], *, as_member: bool = False
) -> set[uuid.UUID]:
    """The variances whose Oracle draft the reader may not see: it cites (a decision, a
    roadmap item of a document) or names something hidden from them (oracle.docs.
    visibility), as a draft written before #541 part 4 may (its run read as its
    creator)."""
    from oracle.docs import visibility
    from oracle.roadmap.draft_items import item_documents

    drafted = [r for r in rows if r.oracle_draft]
    hidden = await visibility.hidden_for_reader(db, as_member=as_member) if drafted else None
    if hidden is None:
        return set()

    def ids(r: MetricVariance, kind: str) -> list[uuid.UUID]:
        out = []
        for ref in r.oracle_refs or []:
            try:
                if ref.get("kind") == kind:
                    out.append(uuid.UUID(str(ref.get("id"))))
            except (ValueError, AttributeError):
                continue
        return out

    items = {i for r in drafted for i in ids(r, "roadmap_item")}
    item_docs = await item_documents(db, items) if items else {}
    return {
        r.id
        for r in drafted
        if hidden.names(r.oracle_draft)
        or hidden.cites(ids(r, "decision"), [item_docs.get(i) for i in ids(r, "roadmap_item")])
    }


async def list_variances(
    db: AsyncSession, status: str | None, metric_id: uuid.UUID | None
) -> list[VarianceOut]:
    stmt = select(MetricVariance).order_by(
        MetricVariance.week_start.desc(), MetricVariance.created_at
    )
    if status is not None:
        stmt = stmt.where(MetricVariance.status == status)
    if metric_id is not None:
        stmt = stmt.where(MetricVariance.metric_id == metric_id)
    return await variance_outs(db, list(await db.scalars(stmt)))


async def detail(db: AsyncSession, metric: Metric) -> MetricDetail:
    [base] = await outs(db, [metric])
    values = list(
        await db.scalars(
            select(MetricValue)
            .where(MetricValue.metric_id == metric.id)
            .order_by(MetricValue.week_start.desc())
            .limit(CHART_WEEKS)
        )
    )
    values.reverse()
    variances = await variance_outs(
        db,
        list(
            await db.scalars(
                select(MetricVariance)
                .where(MetricVariance.metric_id == metric.id)
                .order_by(MetricVariance.week_start.desc())
            )
        ),
    )
    return MetricDetail(
        **base.model_dump(),
        values=[
            MetricValueOut(
                week_start=v.week_start,
                value=pull.number(v.value),
                source=v.source,
                definition_version=v.definition_version,
                note=v.note,
                recorded_by=v.recorded_by,
                recorded_at=v.recorded_at,
            )
            for v in values
        ],  # fmt: skip
        variances=variances,
        definitions=[Definition(**d) for d in metric.definitions or []],
    )
