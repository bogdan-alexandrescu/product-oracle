"""The weekly metrics review (H5, an H2 ritual kind): its two pre-read blocks, the open
variances an occurrence lists, and the metric Inbox rows.

Deterministic, no model call. The week a review reads is the last one complete at its
due time, in the Company time zone.

- ``metrics_table``, the fixed format (research [62]): outputs first, each followed by
  the inputs that drive it; per metric, the week's value, its change against the week
  before, against the 6-week average and against the same week last year (once 52
  weeks exist), the 12-week series and the variance flag. A metric with no value that
  week reads "No value this week"; one whose pull failed reads "Not read".
- ``variances``: each variance of the period (weeks after the one the previous review
  read, up to this one), with its possible causes, explanation state, Oracle's draft
  and the owner. Each is tied to the occurrence that lists it (``occurrence_id``), so
  Explain with Oracle and the Inbox find it.
"""

import uuid
from datetime import date, timedelta
from statistics import mean
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.metrics import pull, service, variance
from oracle.metrics.models import Metric, MetricValue, MetricVariance
from oracle.metrics.schemas import InboxMetric

AVERAGE_WEEKS = 6
YEAR_WEEKS = 52
NOT_READ = "Not read"


def _metric_href(metric_id: uuid.UUID) -> str:
    return f"/company/metrics?metric={metric_id}"


def _pct(change: float | None, base: float | None) -> float | None:
    if change is None or not base:
        return None
    return round(change / base * 100, 1)


def _signed(n: float | int | None) -> str:
    return "" if n is None else f"{'+' if n > 0 else ''}{n:g}"


async def _week(db: AsyncSession, moment) -> tuple[date, str]:
    zone = await company_time.company_time_zone(db)
    return pull.last_complete_week(moment, zone), zone


def _row(metric: Metric, by_week: dict[date, float], week: date, flag: str | None) -> dict:
    value = by_week.get(week)
    previous = by_week.get(week - timedelta(weeks=1))
    before = [by_week.get(week - timedelta(weeks=i)) for i in range(1, AVERAGE_WEEKS + 1)]
    known = [v for v in before if v is not None]
    average = mean(known) if known else None
    last_year = by_week.get(week - timedelta(weeks=YEAR_WEEKS))
    change = value - previous if value is not None and previous is not None else None
    vs_avg = value - average if value is not None and average is not None else None
    vs_year = value - last_year if value is not None and last_year is not None else None
    if metric.status == "error":
        state = "pull_failed"
    elif value is None:
        state = "no_value"
    else:
        state = "ok"
    if state == "pull_failed":
        text = f"{metric.title}: {NOT_READ} ({metric.last_error or 'the pull failed'})"
    elif value is None:
        text = f"{metric.title}: {variance.NO_VALUE}"
    else:
        text = f"{metric.title}: {pull.number(value):g} {metric.unit}"
        if change is not None:
            text += f" ({_signed(pull.number(change))} on the week before)"
        if flag:
            text += f" · {flag.capitalize()}"
    return {
        "metric_id": str(metric.id), "title": metric.title, "kind": metric.kind,
        "unit": metric.unit, "direction": metric.direction,
        "drives_metric_id": str(metric.drives_metric_id) if metric.drives_metric_id else None,
        "status": metric.status, "state": state, "week_start": week.isoformat(),
        "value": pull.number(value), "previous": pull.number(previous),
        "change": pull.number(change), "change_pct": _pct(change, previous),
        "vs_6w_avg": pull.number(vs_avg), "vs_6w_avg_pct": _pct(vs_avg, average),
        "vs_last_year": pull.number(vs_year), "vs_last_year_pct": _pct(vs_year, last_year),
        "spark": [pull.number(by_week.get(week - timedelta(weeks=service.SPARK_WEEKS - 1 - i)))
                  for i in range(service.SPARK_WEEKS)],
        "variance": flag, "href": _metric_href(metric.id), "text": text,
    }  # fmt: skip


async def metrics_table(db: AsyncSession, period_to) -> list[dict[str, Any]]:
    week, _ = await _week(db, period_to)
    metrics = service.ordered(
        list(
            await db.scalars(
                select(Metric).where(Metric.status != "archived").order_by(Metric.title)
            )
        )
    )
    if not metrics:
        return []
    ids = [m.id for m in metrics]
    values: dict[uuid.UUID, dict[date, float]] = {i: {} for i in ids}
    for v in await db.scalars(
        select(MetricValue).where(
            MetricValue.metric_id.in_(ids),
            MetricValue.week_start.between(week - timedelta(weeks=YEAR_WEEKS), week),
        )
    ):
        values[v.metric_id][v.week_start] = float(v.value)
    flags = {
        r.metric_id: r.direction
        for r in await db.scalars(
            select(MetricVariance).where(
                MetricVariance.metric_id.in_(ids), MetricVariance.week_start == week
            )
        )
    }
    return [_row(m, values[m.id], week, flags.get(m.id)) for m in metrics]


async def variances(
    db: AsyncSession, period_from, period_to, occurrence_id: uuid.UUID | None
) -> list[dict[str, Any]]:
    week, zone = await _week(db, period_to)
    after = pull.last_complete_week(period_from, zone)
    if after >= week:
        after = week - timedelta(weeks=1)
    rows = list(
        await db.scalars(
            select(MetricVariance)
            .join(Metric, Metric.id == MetricVariance.metric_id)
            .where(
                Metric.status != "archived",
                MetricVariance.week_start > after,
                MetricVariance.week_start <= week,
            )
            .order_by(MetricVariance.week_start.desc(), Metric.title)
        )
    )
    if occurrence_id is not None:
        for r in rows:
            r.occurrence_id = occurrence_id
        await db.flush()
    # Built once and read by every member: Oracle's drafts as a commenter sees them.
    outs = await service.variance_outs(db, rows, as_member=True)
    owners = await service.names(db, {o.owner_id for o in outs})
    out = []
    for o in outs:
        word = "Better" if o.direction == "better" else "Worse"
        day = f"{o.week_start:%b} {o.week_start.day}"
        row = o.model_dump(mode="json")
        row["variance_id"] = row.pop("id")
        row.update(
            owner_name=owners.get(o.owner_id),
            href=_metric_href(o.metric_id),
            text=f"{o.metric_title}, week of {day}: {_signed(o.change)} · {word} · "
            f"{o.status.capitalize()}",
        )
        out.append(row)
    return out


def variance_ids(pre_read: dict[str, Any] | None) -> list[uuid.UUID]:
    """The variances an occurrence's pre-read lists."""
    out = []
    for block in (pre_read or {}).get("blocks") or []:
        if block.get("key") != "variances":
            continue
        for row in block.get("rows") or []:
            try:
                out.append(uuid.UUID(str(row.get("variance_id"))))
            except ValueError:
                continue
    return out


async def open_variances(db: AsyncSession, pre_read: dict[str, Any] | None) -> list[MetricVariance]:
    """The variances the pre-read lists that nobody has answered yet."""
    ids = variance_ids(pre_read)
    if not ids:
        return []
    return list(
        await db.scalars(
            select(MetricVariance)
            .where(MetricVariance.id.in_(ids), MetricVariance.status == "open")
            .order_by(MetricVariance.week_start, MetricVariance.id)
        )
    )


# --- the Inbox --------------------------------------------------------------------------


async def inbox_rows(db: AsyncSession, principal: Principal) -> list[InboxMetric]:
    """Explain a variance (open, the metric's owner), Find out (Don't know yet whose day
    has come in the Company time zone, the metric's owner) and Metric not read for a day
    (a metric in error, owners). All counted."""
    zone = await company_time.company_time_zone(db)
    now = pull.now()
    today = company_time.day(now, zone)
    rows: list[InboxMetric] = []
    # The person, whatever credential they call with (principal.id is a token's id for a
    # token); a company token owns no metric.
    pairs = (
        await db.execute(
            select(MetricVariance, Metric)
            .join(Metric, Metric.id == MetricVariance.metric_id)
            .where(
                Metric.owner_id == principal.user_id,
                Metric.status != "archived",
                MetricVariance.status.in_(("open", "unknown")),
            )
            .order_by(MetricVariance.week_start, Metric.title)
        )
    ).all()
    for v, m in pairs:
        if v.status == "unknown" and (v.find_out_by is None or v.find_out_by > today):
            continue
        rows.append(InboxMetric(
            variance_id=v.id, metric_id=m.id, metric_title=m.title,
            reason="explain" if v.status == "open" else "find_out", week_start=v.week_start,
            due_on=v.find_out_by if v.status == "unknown" else None,
            occurrence_id=v.occurrence_id, counts=True,
        ))  # fmt: skip
    if has_role(principal.role, "owner"):
        week = pull.last_complete_week(now, zone)
        for m in await db.scalars(
            select(Metric).where(Metric.status == "error").order_by(Metric.title)
        ):
            rows.append(InboxMetric(metric_id=m.id, metric_title=m.title, reason="pull_failed",
                                    week_start=week, counts=True))  # fmt: skip
    return rows
