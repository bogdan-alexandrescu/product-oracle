"""A goal's dated measurements (B5) and Fill from text.

Recording or deleting a measurement sets the goal's ``attrs.current`` and
``current_as_of`` to the latest row by ``measured_on`` through the normal write path: a
revision is written and the person's write locks the goal, as any edit does. One row per
goal per day: a second on the same day replaces the value.

The caller commits.
"""

import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.baseline import goals, service
from oracle.baseline.models import Entity, GoalMeasurement


async def _goal(db: AsyncSession, entity_id: uuid.UUID) -> Entity:
    entity = await service.get_entity(db, entity_id)
    if entity.type != "goal":
        raise service.InvalidError("measurements are recorded on goals only")
    return entity


async def list_for(db: AsyncSession, entity_id: uuid.UUID) -> list[GoalMeasurement]:
    """The goal's measurements, latest day first."""
    await _goal(db, entity_id)
    rows = await db.scalars(
        select(GoalMeasurement)
        .where(GoalMeasurement.entity_id == entity_id)
        .order_by(GoalMeasurement.measured_on.desc())
    )
    return list(rows.all())


def _number(value: Decimal) -> int | float:
    f = float(value)
    return int(f) if f.is_integer() else f


async def _sync_current(db: AsyncSession, principal: Principal, goal: Entity, reason: str) -> None:
    latest = await db.scalar(
        select(GoalMeasurement)
        .where(GoalMeasurement.entity_id == goal.id)
        .order_by(GoalMeasurement.measured_on.desc())
        .limit(1)
    )
    patch: dict[str, Any] = (
        {"current": _number(latest.value), "current_as_of": latest.measured_on.isoformat()}
        if latest is not None
        else {"current": None, "current_as_of": None}
    )
    writer = service.Writer(principal, "user", reason=reason)
    await service.update_entity(db, writer, goal, {"attrs": patch})


async def record(
    db: AsyncSession,
    principal: Principal,
    entity_id: uuid.UUID,
    *,
    value: float,
    measured_on: date,
    note: str | None,
    evidence_id: uuid.UUID | None,
) -> GoalMeasurement:
    goal = await _goal(db, entity_id)
    if not goals.unit_ok((goal.attrs or {}).get("unit")):
        raise service.InvalidError("give the goal its unit before recording a value")
    if measured_on > goals.today():
        raise service.InvalidError("a value cannot be measured in the future")
    if (goal.attrs or {}).get("unit") == "%" and value < 0:
        raise service.InvalidError(goals.MESSAGES["percent_negative"])
    row = await db.scalar(
        select(GoalMeasurement).where(
            GoalMeasurement.entity_id == goal.id, GoalMeasurement.measured_on == measured_on
        )
    )
    if row is None:
        row = GoalMeasurement(entity_id=goal.id, measured_on=measured_on)
        db.add(row)
    row.value = Decimal(str(value))
    row.note = note
    row.evidence_id = evidence_id
    row.recorded_by = principal.id
    await db.flush()
    await _sync_current(db, principal, goal, f"value {value:g} measured on {measured_on}")
    await db.flush()
    return row


async def delete(db: AsyncSession, principal: Principal, measurement_id: uuid.UUID) -> None:
    row = await db.get(GoalMeasurement, measurement_id)
    if row is None:
        raise service.NotFoundError("Measurement not found")
    goal = await _goal(db, row.entity_id)
    await db.delete(row)
    await db.flush()
    await _sync_current(db, principal, goal, f"measurement of {row.measured_on} deleted")
    await db.flush()


async def fill_from_text(db: AsyncSession, principal: Principal) -> dict[str, Any]:
    """Read every goal's ``*_text`` values and write what they say, as an Oracle (agent)
    write: applied to an unlocked goal, a proposal on a locked one. No model call."""
    writer = service.Writer(principal, "agent", reason="Fill from text")
    applied = proposed = 0
    left: list[dict[str, Any]] = []
    rows = await db.scalars(
        select(Entity)
        .where(Entity.type == "goal", Entity.status != "rejected")
        .order_by(Entity.key)
    )
    for goal in rows.all():
        attrs = dict(goal.attrs or {})
        values, unread = goals.read_text(attrs)
        left += [
            {"entity_id": goal.id, "field": k, "text": str(attrs[f"{k}_text"])} for k in unread
        ]
        if not values:
            continue
        patch: dict[str, Any] = {**values}
        for key in values:
            if f"{key}_text" in attrs:
                patch[f"{key}_text"] = None
        result = await service.update_entity(db, writer, goal, {"attrs": patch})
        if result.proposal is not None:
            proposed += 1
        else:
            applied += 1
    await db.flush()
    return {"applied": applied, "proposed": proposed, "left_as_text": left}
