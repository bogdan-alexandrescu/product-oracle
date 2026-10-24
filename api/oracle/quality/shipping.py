"""Notice that a predicted item shipped, and propose its actual (H3 Predicted versus
actual). The ticker step :func:`tick_due`, hourly per company, no model call.

A ``predicted`` record ships at the first of: its tracker records all done or its
milestones all done (H6's rule, :func:`oracle.roadmap.shipped.shipped_items`), a launch
holding its item marked launched, or a person (``POST /v1/outcomes/{id}/shipped``). It
becomes ``tracking`` (on screen: Measuring) and is due for its check at the later of its
prediction's ``by`` and ``outcome_measure_days`` after it shipped.

On or after the due date Oracle reads the goal's value (B5's dated measurements, else
the history of ``attrs.current``): the first one on or after ``by``, else the latest
("measured early"), and proposes a verdict. A person confirms it, unless H11 Autonomy
has ``outcomes`` at "Act within limits": then Oracle records it as itself.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy
from oracle.baseline.models import EntityRevision, GoalMeasurement
from oracle.quality import outcomes
from oracle.quality.capture import figure_text, number
from oracle.quality.models import OutcomeRecord
from oracle.quality.schemas import Assessment
from oracle.roadmap.models import TrackerRecord
from oracle.roadmap.shipped import shipped_items
from oracle.tenant_settings_api import get_setting

CAVEAT = (
    "This compares the goal's value with the prediction. Goals move for many reasons; "
    "it does not prove the item caused it."
)


def verdict(prediction: dict[str, Any], actual: float | None) -> str:
    """held when the actual reaches the prediction in its direction; partly held when it
    reaches the line (with none: at least half the predicted change); not held otherwise;
    inconclusive with no value or no numeric prediction."""
    want = prediction.get("predicted_value")
    if actual is None or want is None:
        return "inconclusive"
    base = prediction.get("baseline_value")
    way = prediction.get("direction")
    if way is None and base is not None and base != want:
        way = "increase" if want > base else "decrease"
    if way is None:
        return "inconclusive"
    sign = 1 if way == "increase" else -1
    if sign * (actual - want) >= 0:
        return "held"
    line = prediction.get("threshold_value")
    if line is None and base is not None:
        line = base + (want - base) / 2
    if line is not None and sign * (actual - line) >= 0:
        return "partially_held"
    return "not_held"


async def due_date(db: AsyncSession, row: OutcomeRecord, shipped_at: datetime) -> date:
    days = int(await get_setting(db, "outcome_measure_days"))
    after = shipped_at.date() + timedelta(days=days)
    by = (row.prediction or {}).get("by")
    return max(date.fromisoformat(by), after) if by else after


async def ship(
    db: AsyncSession, row: OutcomeRecord, kind: str, at: datetime, *, refs=(), note=None,
    actor: Any = audit.ORACLE,
) -> None:  # fmt: skip
    row.status = "tracking"
    row.shipped_at = at
    row.ship_signal = {"kind": kind, "refs": list(refs), "at": at.isoformat(), "note": note}
    row.assess_due_on = await due_date(db, row, at)
    await db.flush()
    await audit.record(
        db, actor, "outcome.shipped", "outcome_record", row.id,
        {"kind": kind, "assess_due_on": row.assess_due_on.isoformat()},
    )  # fmt: skip


async def _launched(db: AsyncSession, track_id: uuid.UUID) -> dict[str, datetime]:
    from oracle.launches.models import Launch

    out: dict[str, datetime] = {}
    for launch in await db.scalars(
        select(Launch).where(Launch.track_id == track_id, Launch.state == "launched")
    ):
        for key in launch.item_keys or []:
            if launch.launched_at is not None:
                out.setdefault(key, launch.launched_at)
    return out


async def detect_shipped(db: AsyncSession) -> int:
    predicted = list(
        await db.scalars(
            select(OutcomeRecord)
            .where(OutcomeRecord.status == "predicted", OutcomeRecord.track_id.is_not(None))
            .order_by(OutcomeRecord.created_at, OutcomeRecord.id)
        )
    )
    signals: dict[uuid.UUID, tuple[dict, dict]] = {}
    shipped = 0
    for row in predicted:
        track_id: uuid.UUID = row.track_id  # type: ignore[assignment]
        if track_id not in signals:
            signals[track_id] = (await shipped_items(db, track_id), await _launched(db, track_id))
        items, launched = signals[track_id]
        key = row.roadmap_item_key or ""
        found: list[tuple[datetime, str]] = []
        if key in items:
            found.append((items[key][1], items[key][0]))
        if key in launched:
            found.append((launched[key], "launch"))
        if not found:
            continue
        at, kind = min(found)
        refs: list[str] = []
        if kind == "tracker":
            refs = [
                f"{r.tracker}:{r.external_ref}"
                for r in await db.scalars(
                    select(TrackerRecord)
                    .where(TrackerRecord.track_id == track_id, TrackerRecord.item_key == key)
                    .order_by(TrackerRecord.external_ref)
                )
            ]
        await ship(db, row, kind, at, refs=refs)
        shipped += 1
    return shipped


async def actual_value(
    db: AsyncSession, goal_id: uuid.UUID, by: date | None
) -> tuple[float, date, str, str | None, str] | None:
    """The goal's value to judge on: (value, measured on, observed text, note, source)."""
    measurements = list(
        await db.scalars(
            select(GoalMeasurement)
            .where(GoalMeasurement.entity_id == goal_id)
            .order_by(GoalMeasurement.measured_on)
        )
    )
    # H5: a measurement read from the goal's linked metric is the metric's value.
    readings: list[tuple[date, float, str, str]] = [
        (m.measured_on, float(m.value), f"{float(m.value):g}",
         "metric" if m.metric_id is not None else "measurement")
        for m in measurements
    ]  # fmt: skip
    if not readings:
        for rev in await db.scalars(
            select(EntityRevision)
            .where(EntityRevision.entity_id == goal_id)
            .order_by(EntityRevision.created_at)
        ):
            attrs = (rev.after or {}).get("attrs") or {}
            raw = attrs.get("current")
            raw = raw if raw is not None else attrs.get("current_text")
            value = number(raw)
            if value is not None:
                readings.append((rev.created_at.date(), value, str(raw), "goal_history"))
    if not readings:
        return None
    after = [r for r in readings if by is None or r[0] >= by]
    on, value, observed, source = after[0] if after else readings[-1]
    return value, on, observed, (None if after else "measured early"), source


async def propose(db: AsyncSession, row: OutcomeRecord) -> None:
    p = row.prediction or {}
    by = date.fromisoformat(p["by"]) if p.get("by") else None
    found = await actual_value(db, row.goal_id, by)
    value, on, observed, note, source = found if found else (None, None, None, None, None)
    v = verdict(p, value)
    row.proposed_assessment = {
        "verdict": v,
        "observed": figure_text(value, p.get("unit")) if value is not None else observed,
        "actual_value": value,
        "measured_at": on.isoformat() if on else None,
        "source": source,
        "note": note,
    }
    await db.flush()
    await audit.record(db, audit.ORACLE, "outcome.proposed", "outcome_record", row.id,
                       {"verdict": v})  # fmt: skip
    if v != "inconclusive" and await autonomy.allows(db, "outcomes", "act"):
        await record_verdict(db, row, actor="oracle")


async def record_verdict(db: AsyncSession, row: OutcomeRecord, *, actor: str) -> None:
    """Oracle records its own proposal (H11 at "Act within limits")."""
    prop = row.proposed_assessment or {}
    entry = Assessment(
        verdict=prop["verdict"],
        observed=prop.get("observed") or "no value",
        note=CAVEAT,
        assessed_at=datetime.now(UTC),
        actual_value=prop.get("actual_value"),
        measured_at=prop.get("measured_at"),
        actor="oracle",
        learnings=outcomes.drafted(row, prop["verdict"]),
    )
    row.assessments = [*(row.assessments or []), entry.model_dump(mode="json")]
    row.status = entry.verdict
    row.observed = entry.observed
    row.assessed_at = entry.assessed_at
    await db.flush()
    await audit.record(db, audit.ORACLE, "outcome.assessed", "outcome_record", row.id,
                       {"from": "tracking", "to": entry.verdict, "actor": actor})  # fmt: skip


async def tick_due(db: AsyncSession) -> tuple[int, int]:
    """The ticker step: ship what shipped, then propose what is due. Flushes; the caller
    commits. Returns (shipped, proposed)."""
    shipped = await detect_shipped(db)
    due = list(
        await db.scalars(
            select(OutcomeRecord)
            .where(
                OutcomeRecord.status == "tracking",
                OutcomeRecord.assess_due_on <= date.today(),
                OutcomeRecord.proposed_assessment.is_(None),
            )
            .order_by(OutcomeRecord.assess_due_on, OutcomeRecord.id)
        )
    )
    for row in due:
        await propose(db, row)
    return shipped, len(due)
