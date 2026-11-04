"""Goals keep one order on every page (goal-order).

A goal's place is its ``attrs.position`` (1 = first, leftmost). Goals with a position come
first, by position; goals without one follow; ties go to the older goal, then by title
(case-folded, then as written), then by id.
Every API read that lists, groups or picks goals sorts them with :func:`goal_sort_key`;
the web's twin is ``web/lib/goal-order.ts``. Archived goals keep their place among
archived ones: the rule never looks at status.
"""

from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any, Protocol

FAR = datetime.max.replace(tzinfo=UTC)


class GoalLike(Protocol):
    title: str
    attrs: dict[str, Any] | None
    created_at: datetime | None


def goal_position(attrs: dict[str, Any] | None) -> int | None:
    """A goal's stored position: a whole number of 1 or more, else none."""
    value = (attrs or {}).get("position")
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if value != int(value) or value < 1:
        return None
    return int(value)


def position_ok(value: Any) -> bool:
    """Whether ``value`` can be stored as a goal's position (none clears it)."""
    return value is None or goal_position({"position": value}) is not None


def goal_sort_key(goal: GoalLike) -> tuple:
    """The one goal order: position, then no position, then creation time, then title,
    then id."""
    position = goal_position(goal.attrs)
    made = goal.created_at or FAR
    if made.tzinfo is None:
        made = made.replace(tzinfo=UTC)
    title = goal.title or ""
    return (position is None, position or 0, made, title.casefold(), title,
            str(getattr(goal, "id", "") or ""))  # fmt: skip


def sort_goals[G: GoalLike](goals: Iterable[G]) -> list[G]:
    """``goals`` in the one goal order."""
    return sorted(goals, key=goal_sort_key)
