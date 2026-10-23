"""Figures in goal text, the Python port of Home's reader (``web/app/home/_goals.ts``).

``parse_figure("45%")`` -> 45 "%", ``"400 clinics by 2027"`` -> 400 "clinics",
``"FY26 revenue $4M"`` -> 4000000 with currency "$", ``"p95 < 200ms"`` -> 200 "ms",
``"10-15%"`` -> the range 10 to 15 "%". ``direction("below 8%")`` -> down, strict.
B5 (fill from text) owns this module; the cadence and predicted-versus-actual picks import it.
"""

import re
from dataclasses import dataclass
from datetime import date
from typing import Any

SCALE = {
    "k": 1e3,
    "K": 1e3,
    "thousand": 1e3,
    "M": 1e6,
    "mn": 1e6,
    "million": 1e6,
    "B": 1e9,
    "bn": 1e9,
    "billion": 1e9,
}
# Time units by the spelling they are written in.
TIME = {
    "ms": "ms",
    "s": "s",
    "sec": "s",
    "secs": "s",
    "second": "s",
    "seconds": "s",
    "min": "min",
    "mins": "min",
    "minute": "min",
    "minutes": "min",
    "h": "h",
    "hr": "h",
    "hrs": "h",
    "hour": "h",
    "hours": "h",
    "day": "days",
    "days": "days",
}
# Words after a number that are not its unit: "400 by 2027", "8% or less".
NOT_UNITS = {
    "by", "in", "on", "at", "to", "from", "for", "and", "or", "of", "per", "within", "before",
    "after", "less", "more", "fewer",
}  # fmt: skip

_L = r"[^\W\d_]"
_NUM = r"\d+(?:\.\d+)?"
# 1 currency, 2 number, 3 range currency, 4 range number, 5 scale, 6 what follows.
_CANDIDATE = re.compile(
    rf"(?:([$€£])\s?)?({_NUM})(?:\s?(?:-|–|to)\s?([$€£])?({_NUM}))?"
    rf"(?:\s?(k|K|M|mn|B|bn|thousand|million|billion)(?![^\W_]))?(\s*(?:%|{_L}[\w-]*))?"
)


@dataclass(frozen=True)
class Figure:
    value: float
    unit: str = ""
    currency: str = ""
    compact: bool = False
    range: tuple[float, float] | None = None


@dataclass(frozen=True)
class Direction:
    way: str  # up | down
    strict: bool


def _candidate(text: str, m: re.Match[str]) -> tuple[Figure, int] | None:
    # A number glued to letters before it is a name, not a value: FY26, p95, v2.
    if m.start() > 0 and re.match(r"[^\W_]|\.", text[m.start() - 1]):
        return None
    scale = SCALE[m[5]] if m[5] else 1
    low = float(m[2]) * scale
    high = float(m[4]) * scale if m[4] is not None else None
    currency = m[1] or m[3] or ""
    unit = ""
    after = (m[6] or "").strip()
    if after == "%":
        unit = "%"
    elif after:
        word = after.lower()
        if after in TIME or word in TIME:
            unit = TIME.get(after) or TIME[word]
        elif word not in NOT_UNITS:
            unit = word
    marked = currency != "" or m[5] is not None or unit == "%" or unit in TIME.values()
    year = not marked and not unit and high is None and re.fullmatch(r"(19|20|21)\d\d", m[2])
    figure = Figure(
        value=low,
        unit=unit,
        currency=currency,
        compact=m[5] is not None,
        range=(min(low, high), max(low, high)) if high is not None else None,
    )
    return figure, (-1 if year else 2 if marked else 1 if unit else 0)


def parse_figure(raw: Any) -> Figure | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int | float):
        return Figure(value=float(raw)) if raw == raw and abs(raw) != float("inf") else None
    if not isinstance(raw, str):
        return None
    text = re.sub(r"(\d),(?=\d{3}\b)", r"\1", raw)
    best: tuple[Figure, int] | None = None
    for m in _CANDIDATE.finditer(text):
        c = _candidate(text, m)
        if c and (best is None or c[1] > best[1]):
            best = c
    return best[0] if best else None


_DIRECTIONS = (
    (re.compile(r"\b(below|under|less than|fewer than)\b|<(?!=)", re.I), Direction("down", True)),
    (
        re.compile(
            r"\b(reduce[sd]?|cut|lower|decrease[sd]?|drop|shrink|at most|no more than"
            r"|max(imum)?)\b|≤|<=",
            re.I,
        ),
        Direction("down", False),
    ),
    (re.compile(r"\b(above|over|more than|greater than)\b|>(?!=)", re.I), Direction("up", True)),
    (
        re.compile(
            r"\b(raise[sd]?|grow|increase[sd]?|boost|at least|no less than|min(imum)?)\b|≥|>=",
            re.I,
        ),
        Direction("up", False),
    ),
)


def direction(raw: Any) -> Direction | None:
    """The direction the target text says, earliest word first; None for a bare target."""
    if not isinstance(raw, str):
        return None
    hits = []
    for pattern, d in _DIRECTIONS:
        m = pattern.search(raw)
        if m:
            hits.append((m.start(), d))
    hits.sort(key=lambda h: h[0])
    return hits[0][1] if hits else None


def comparison_of(d: Direction | None) -> str:
    """The typed comparison a direction reads as; a bare target is "at least"."""
    if d is None or d.way == "up":
        return "above" if d is not None and d.strict else "at_least"
    return "below" if d.strict else "at_most"


_PERIOD = re.compile(r"\b((?:19|20|21)\d\d)\s*-?\s*(Q[1-4]|H[12])\b", re.I)


def period_end(raw: Any) -> date | None:
    """The last day of a quarter or half label: "2026-Q4" -> 2026-12-31, "2027-H1" -> 2027-06-30."""
    if not isinstance(raw, str):
        return None
    m = _PERIOD.search(raw)
    if not m:
        return None
    year, part = int(m[1]), m[2].upper()
    month = int(part[1]) * 3 if part[0] == "Q" else int(part[1]) * 6
    return date(year, month, 30 if month in (6, 9) else 31)
