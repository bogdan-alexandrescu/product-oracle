"""The variance rule (H5, deterministic, no model call).

For a metric's weekly values ``v`` (oldest first, this week last), this week's change is
``c = v[w] - v[w-1]``; the previous 12 week-on-week changes before ``c`` are the history.

1. With at least 6 changes in the history, ``typical = median(|history|)``; the week is
   a variance when ``typical > 0`` and ``|c| > 2 x typical``.
2. With fewer than 6 changes, or ``typical = 0``, the week is a variance when
   ``|c / v[w-1]| >= threshold_pct``, the metric's own (10% when it has none; from 0 any
   change counts).
3. An owner-set ``threshold_pct`` always applies too: rule 1 or rule 3.
4. A change in the metric's good direction is Better, the other way Worse.
5. A week with no value is no variance ("No value this week").

The normal range shown is ``v[w-1] +- 2 x typical``. These thresholds are engineering
defaults; an owner overrides a metric's ``threshold_pct``.
"""

from dataclasses import dataclass
from statistics import median

HISTORY = 12
MIN_HISTORY = 6
DEFAULT_THRESHOLD_PCT = 10.0
NO_VALUE = "No value this week"


@dataclass(frozen=True)
class Check:
    variance: str | None  # "better" | "worse" | None
    value: float | None = None
    previous: float | None = None
    change: float | None = None
    change_pct: float | None = None
    typical: float | None = None
    band: tuple[float, float] | None = None
    no_value: bool = False

    @property
    def label(self) -> str | None:
        return NO_VALUE if self.no_value else None


def _pct_rule(change: float, previous: float, threshold_pct: float) -> bool:
    if previous == 0:
        return change != 0
    return abs(change / previous) * 100 >= threshold_pct


def check(values: list[float | None], direction: str, threshold_pct: float | None) -> Check:
    """The rule on ``values`` (oldest first; the last is the week checked)."""
    if not values or values[-1] is None:
        return Check(None, no_value=True)
    if len(values) < 2 or values[-2] is None:
        return Check(None, value=values[-1])
    value, previous = float(values[-1]), float(values[-2])
    change = value - previous
    window = values[-2 - HISTORY : -1]
    history = [
        float(b) - float(a)
        for a, b in zip(window, window[1:], strict=False)
        if a is not None and b is not None
    ]
    typical = median(abs(h) for h in history) if len(history) >= MIN_HISTORY else None
    limit = DEFAULT_THRESHOLD_PCT if threshold_pct is None else float(threshold_pct)
    if typical:
        # Rule 1, or rule 3: an owner-set threshold applies too.
        flagged = abs(change) > 2 * typical or (
            threshold_pct is not None and _pct_rule(change, previous, limit)
        )
        band = (previous - 2 * typical, previous + 2 * typical)
    else:
        # Rule 2: the metric's threshold_pct, 10% by default.
        flagged = _pct_rule(change, previous, limit)
        band = None
    pct = round(change / previous * 100, 1) if previous else None
    better = (change > 0) == (direction == "up")
    return Check(
        ("better" if better else "worse") if flagged and change != 0 else None,
        value=value,
        previous=previous,
        change=change,
        change_pct=pct,
        typical=typical,
        band=band,
    )
