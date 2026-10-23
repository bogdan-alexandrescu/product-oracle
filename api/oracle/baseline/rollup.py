"""Goal progress and its roll-up to the parent (#345).

A goal's own progress is how far its current value has come from its start toward its
target, 0 to 1 (without a start: the current value against the target in the goal's
direction). A parent's progress is its own measurement when it has one, and otherwise the
weighted progress of its subgoals (weight 1 when unset; archived subgoals left out;
subgoals without a value left out of the average but counted).
"""

import math
from typing import Any

from oracle.baseline.models import Entity

UP = ("at_least", "above")
DOWN = ("at_most", "below")


def _num(v: Any) -> float | None:
    if isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v):
        return float(v)
    return None


def _clamp(v: float) -> float:
    return max(0.0, min(1.0, v))


def own_progress(attrs: dict[str, Any]) -> float | None:
    """0 to 1, or None when the goal has no typed target or no current value."""
    current, target = _num(attrs.get("current")), _num(attrs.get("target"))
    comparison, start = attrs.get("comparison"), _num(attrs.get("start"))
    if current is None or target is None or comparison not in UP + DOWN:
        return None
    if start is not None and start != target:
        return _clamp((current - start) / (target - start))
    if comparison in UP:
        return 1.0 if current >= target else (_clamp(current / target) if target > 0 else 0.0)
    if current <= target:
        return 1.0
    return _clamp(target / current) if current > 0 else 0.0


def rollup(attrs: dict[str, Any], subgoals: list[tuple[dict[str, Any], str]]) -> dict[str, Any]:
    """``{"value", "source", "subgoals"}``: source "own", "subgoals" or None.
    ``subgoals`` are (attrs, status) pairs."""
    live = [a for a, status in subgoals if status != "rejected"]
    own = own_progress(attrs)
    if own is not None:
        return {"value": own, "source": "own", "subgoals": len(live)}
    total = weights = 0.0
    for a in live:
        p = own_progress(a)
        if p is None:
            continue
        w = _num(a.get("weight"))
        w = w if w is not None and w > 0 else 1.0
        total, weights = total + w * p, weights + w
    if not weights:
        return {"value": None, "source": None, "subgoals": len(live)}
    return {"value": total / weights, "source": "subgoals", "subgoals": len(live)}


def progress_of(goals: list[Entity]) -> dict[Any, dict[str, Any]]:
    """Each goal's roll-up by id, from every goal of the company."""
    children: dict[Any, list[tuple[dict[str, Any], str]]] = {}
    for g in goals:
        if g.parent_id is not None:
            children.setdefault(g.parent_id, []).append((dict(g.attrs or {}), g.status))
    return {g.id: rollup(dict(g.attrs or {}), children.get(g.id, [])) for g in goals}
