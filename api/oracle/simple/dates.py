"""Simple S2 (#723): a roadmap item's dates, its waterfall phases and Oracle's date
suggestion. Pure functions: the caller (oracle.simple.service) gathers the candidates.

**Precedence** (:func:`resolve`), for the start and the end each:

1. the item's own dates (``roadmap_items.start_date`` / ``end_date``) when their
   ``date_source`` is ``typed`` or ``accepted`` (null with dates reads as ``typed``);
2. engineering dates (F4, migration 0069_eng_dates): the item's milestone date, which
   ``items.recheck_date`` keeps only with a verified basis, and every verified schedule
   basis scoped to the item (its key, or a tracker issue matched to it). An end date only;
3. tracker dates: the ``target_date`` of a tracker record matched to the item. An end
   date only;
4. else estimated: the item's horizon window from the company's planning horizons on the
   company's day (now = short, next = medium, later = from the day after Next ends
   to the end of long).

An item's own dates stored with ``date_source`` ``engineering`` or ``tracker`` rank with that
source. Ties within a source: the most recently updated candidate wins. A start that no
source gives is the window's start, or 42 days before the end when the end comes before the
window; an end that no source gives is the window's end, or 42 days from a start after the
window. Every resolved date says its source and whether it is estimated.

**Waterfall** (:func:`phases`): discover, build, beta, launch. The item's milestone and
validation gates that name a phase (``phase``, else ``name``) and carry a ``date`` end that
phase on that date, wherever the bar is moved; every other phase keeps the 15/55/20/10
split of the bar, estimated, ending before the next dated gate (they may bunch up).

**Suggestion** (:func:`suggest`), for an undated item (both dates estimated): start = the
later of its window's start and the day after its dependencies' latest resolved end;
duration = the median duration (whole days, both ends included) of the dated items with
the same confidence, else 42 days; the end is clipped to the window's end when the start
lies inside the window; the basis says why in one sentence.
"""

import statistics
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Literal

from oracle.tenant_settings_api import horizon_windows

Source = Literal["typed", "accepted", "engineering", "tracker", "estimated"]
PHASES = ("discover", "build", "beta", "launch")
SPLIT = (0.15, 0.55, 0.20, 0.10)
# The planning horizon each roadmap horizon is estimated across.
HORIZON_WINDOW = {"now": "short", "next": "medium", "later": "long"}
HORIZON_WORD = {"now": "Now", "next": "Next", "later": "Later"}
FALLBACK_DAYS = 42
# Lower is stronger.
TIER = {"typed": 0, "accepted": 0, "engineering": 1, "tracker": 2}
DAY = timedelta(days=1)


@dataclass(frozen=True)
class Dated:
    date: date
    source: Source
    estimated: bool


@dataclass(frozen=True)
class Candidate:
    """Dates one source gives the item (either may be None), and when it last changed."""

    start: date | None
    end: date | None
    source: Source
    updated_at: datetime | None = None


@dataclass(frozen=True)
class Resolved:
    start: Dated
    end: Dated

    @property
    def estimated(self) -> bool:
        """The bar is an estimate (hatched): neither date comes from a source."""
        return self.start.estimated and self.end.estimated

    @property
    def undated(self) -> bool:
        return self.estimated

    @property
    def source(self) -> Source:
        """The bar's source: its end's, else its start's (``estimated`` when neither)."""
        if not self.end.estimated:
            return self.end.source
        return self.start.source

    @property
    def days(self) -> int:
        return (self.end.date - self.start.date).days + 1


@dataclass(frozen=True)
class Phase:
    key: str
    start: date
    end: date
    estimated: bool


@dataclass(frozen=True)
class Suggestion:
    start: date
    end: date
    basis: str


def windows(horizons: dict[str, int], today: date) -> dict[str, tuple[date, date]]:
    """Each roadmap horizon's window on the company's day ``today``. Later starts the day
    after Next ends (no gap between them, no "today plus a year" start) and ends where the
    long horizon ends (``today`` plus ``long_to_months``, always after Next ends)."""
    spans = horizon_windows(horizons, today)
    out = {h: spans[w] for h, w in HORIZON_WINDOW.items()}
    out["later"] = (out["next"][1] + DAY, out["later"][1])
    return out


def _stamp(c: Candidate) -> float:
    return c.updated_at.timestamp() if c.updated_at is not None else float("-inf")


def _best(candidates: Iterable[Candidate], field: str) -> Candidate | None:
    out: Candidate | None = None
    for c in candidates:
        if getattr(c, field) is None or c.source not in TIER:
            continue
        if out is None:
            out = c
            continue
        stronger = TIER[c.source] < TIER[out.source]
        newer = TIER[c.source] == TIER[out.source] and _stamp(c) > _stamp(out)
        if stronger or newer:
            out = c
    return out


def resolve(candidates: list[Candidate], window: tuple[date, date]) -> Resolved:
    """The item's start and end by precedence, falling back to ``window``."""
    s, e = _best(candidates, "start"), _best(candidates, "end")
    end = Dated(e.end, e.source, False) if e is not None and e.end else None
    start = Dated(s.start, s.source, False) if s is not None and s.start else None
    lead = timedelta(days=FALLBACK_DAYS - 1)
    if start is None:
        day = window[0]
        if end is not None and end.date < day:
            day = end.date - lead
        start = Dated(day, "estimated", True)
    if end is None:
        day = window[1]
        if start.date > day:
            day = start.date + lead
        end = Dated(day, "estimated", True)
    return Resolved(start, end)


def as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _phase_of(entry: Any) -> str | None:
    if not isinstance(entry, dict):
        return None
    for key in ("phase", "name"):
        word = str(entry.get(key) or "").strip().casefold()
        if word in PHASES:
            return word
    return None


def named_phases(milestone: dict | None, gates: list | None) -> dict[str, date]:
    """The phase end dates the milestone and validation gates carry."""
    out: dict[str, date] = {}
    for entry in [milestone, *(gates or [])]:
        phase = _phase_of(entry)
        day = as_date(entry.get("date")) if phase else None
        if phase and day:
            out[phase] = day
    return out


def phases(start: Dated, end: Dated, milestone: dict | None, gates: list | None) -> list[Phase]:
    """The four phases over the bar. A phase a dated gate ends stays on the gate's day
    wherever the bar moves; an estimated phase keeps its share of the bar but ends before
    the next dated gate, so phases between gates may bunch up (roadmap-plus)."""
    named = named_phases(milestone, gates)
    total = (end.date - start.date).days + 1
    out: list[Phase] = []
    cursor, share = start.date, 0.0
    for i, (key, part) in enumerate(zip(PHASES, SPLIT, strict=True)):
        share += part
        last = i == len(PHASES) - 1
        if key in named:
            day, estimated = named[key], False
        else:
            day = end.date if last else start.date + timedelta(days=round(total * share) - 1)
            gate = min((named[k] for k in PHASES[i + 1 :] if k in named), default=None)
            if gate is not None and day >= gate:
                day = gate - DAY
            day, estimated = max(day, cursor), True
        out.append(Phase(key, min(cursor, day), day, estimated))
        cursor = max(cursor, day + DAY)
    return out


def median_days(durations: list[int]) -> int:
    if not durations:
        return FALLBACK_DAYS
    return int(statistics.median(durations) + 0.5)


def _day(d: date) -> str:
    return f"{d:%b} {d.day}"


def suggest(
    window: tuple[date, date],
    deps: list[tuple[str, date]],
    durations: list[int],
    confidence: str | None,
    horizon: str,
) -> Suggestion:
    """Oracle's dates for an undated item (``deps``: its dependencies' titles and resolved
    ends; ``durations``: the dated items' with the same confidence)."""
    word = HORIZON_WORD.get(horizon, horizon)
    start, why = window[0], f"starts with the {word} window"
    if deps:
        title, latest = max(deps, key=lambda d: d[1])
        if latest + DAY > start:
            start, why = latest + DAY, f"starts the day after ‘{title[:60]}’ ends"
    days = median_days(durations)
    conf = f"{confidence}-confidence" if confidence else "unrated"
    # finding 30: plain words, not statistics jargon ("median").
    how = (
        f"{days} days, about the same as {len(durations)} similar {conf} "
        f"item{'' if len(durations) == 1 else 's'}"
        if durations
        else f"{days} days, typical with no dated {conf} items yet"
    )
    end = start + timedelta(days=days - 1)
    tail = ""
    if start <= window[1] < end:
        end, tail = window[1], f", cut at the window's end ({_day(window[1])})"
    return Suggestion(start, end, f"It {why} ({_day(start)}) and runs {how}{tail}.")
