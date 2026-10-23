"""The track record (H3 Predicted versus actual): how well past predictions held, as a
factor on priority confidence.

Assessed outcomes of the last 365 days, ``inconclusive`` left out, score held = 1,
partly held = 0.5, not held = 0. Per goal with at least ``calibration_min_outcomes``
(company setting, default 5) of them, else company-wide, else none:

    factor = clamp((Σ score + 1) / (Σ confidence_at_prediction + 1), FLOOR, CEILING)

Decided 2026-10-21 ("Track record"): it only lowers. A poor record lowers scores; a good
one never lifts confidence above what the evidence says. A record without a confidence
at prediction (one tracked by hand) expects the scoring default, 0.5.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Entity
from oracle.priorities.scoring import DEFAULT_CONFIDENCE
from oracle.quality.models import OutcomeRecord
from oracle.quality.schemas import CalibrationFigures, CalibrationOut, GoalCalibration
from oracle.tenant_settings_api import get_setting

FLOOR = 0.5
CEILING = 1.0
WINDOW_DAYS = 365
SCORES = {"held": 1.0, "partially_held": 0.5, "not_held": 0.0}


def factor(score: float, expected: float) -> float:
    return round(min(max((score + 1) / (expected + 1), FLOOR), CEILING), 2)


def _figures(rows: list[OutcomeRecord], minimum: int) -> dict:
    score = sum(SCORES[r.status] for r in rows)
    expected = sum(
        float(r.confidence_at_prediction)
        if r.confidence_at_prediction is not None
        else DEFAULT_CONFIDENCE
        for r in rows
    )
    return {
        "n": len(rows),
        "score": round(score, 3),
        "expected": round(expected, 3),
        "factor": factor(score, expected) if len(rows) >= minimum and rows else None,
        "held": sum(1 for r in rows if r.status == "held"),
    }


async def compute(db: AsyncSession) -> CalibrationOut:
    minimum = int(await get_setting(db, "calibration_min_outcomes"))
    since = datetime.now(UTC) - timedelta(days=WINDOW_DAYS)
    rows = list(
        await db.scalars(
            select(OutcomeRecord).where(
                OutcomeRecord.status.in_(tuple(SCORES)), OutcomeRecord.assessed_at >= since
            )
        )
    )
    by_goal: dict[uuid.UUID, list[OutcomeRecord]] = {}
    for r in rows:
        by_goal.setdefault(r.goal_id, []).append(r)
    found = await db.execute(select(Entity.id, Entity.title).where(Entity.id.in_(list(by_goal))))
    titles = {goal_id: title for goal_id, title in found}
    goals = sorted(
        (
            GoalCalibration(goal_id=g, title=titles.get(g, ""), **_figures(rs, minimum))
            for g, rs in by_goal.items()
        ),
        key=lambda g: (g.title.lower(), str(g.goal_id)),
    )
    return CalibrationOut(
        setting=await get_setting(db, "outcome_calibration"),
        min_outcomes=minimum,
        floor=FLOOR,
        ceiling=CEILING,
        company=CalibrationFigures(**_figures(rows, minimum)),
        goals=goals,
    )


def _basis(label: str, f: CalibrationFigures) -> str:
    return f"{label}: {f.held} of {f.n} assessed predictions held (expected {f.expected:g})"


def for_goals(cal: CalibrationOut, goal_ids: list[uuid.UUID]) -> tuple[float, str, int] | None:
    """The smallest factor among a feature's confirmed goals, its basis and n: the goal's
    own record when it has enough outcomes, else the company's; None when neither does."""
    by_goal = {g.goal_id: g for g in cal.goals}
    best: tuple[float, str, int] | None = None
    for goal_id in goal_ids:
        g = by_goal.get(goal_id)
        if g is not None and g.factor is not None:
            found = (g.factor, _basis(f"Goal '{g.title}'", g), g.n)
        elif cal.company.factor is not None:
            found = (cal.company.factor, _basis("Company", cal.company), cal.company.n)
        else:
            continue
        if best is None or found[0] < best[0]:
            best = found
    return best
