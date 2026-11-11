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
4. else estimated: its column's window on the company's day (board-quarters: Now this
   calendar quarter, Next the next, Later from the quarter after; an item's column comes
   from its dates, :func:`horizon_of`, an undated one Later's).

An item's own dates stored with ``date_source`` ``engineering`` or ``tracker`` rank with that
source. Ties within a source: the most recently updated candidate wins. A start that no
source gives is the window's start when no source gives an end either; else (hotfix-effort-
start) a span of the feature's effort (``effort_weeks`` x 7 calendar days, as
Priorities reads it; the end minus N-1, as :func:`suggest` spans its days), or of 28 days
without one, even before the window's start, never
after the end. An end that no source gives is the window's end, or 42 days from a start
after the window. Every resolved date says its source and whether it is estimated.

**Waterfall** (:func:`phases`): discover, build, beta, launch. The item's milestone and
validation gates that name a phase (``phase``, else ``name``) and carry a ``date`` end that
phase on that date, wherever the bar is moved; every other phase keeps the 15/55/20/10
split of the bar, estimated, ending before the next dated gate (they may bunch up).

**Suggestion** (:func:`suggest`), for an undated item (both dates estimated): start = the
later of its window's start and the day after its dependencies' latest resolved end;
duration = the median duration (whole days, both ends included) of the dated items with
the same confidence, else 28 days; the end is clipped to the window's end when the start
lies inside the window; the basis says why in one sentence.
"""

import statistics
from calendar import monthrange
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
FALLBACK_DAYS = 28
# An end no source gives, after a start past the window: 42 days from it.
END_LEAD_DAYS = 42
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
    """Each roadmap horizon's window on the company's day ``today`` (board-quarters, the
    owner's Nov 10 pick): Now is this calendar quarter, Next the next one, Later from the
    quarter after that on. Later's end (only an undated bar's estimate) is where the long
    horizon ends, at least that quarter's end."""
    q0 = date(today.year, 3 * ((today.month - 1) // 3) + 1, 1)
    q1, q2 = add_months(q0, 3), add_months(q0, 6)
    long_end = horizon_windows(horizons, today)["long"][1]
    return {
        "now": (q0, q1 - DAY),
        "next": (q1, q2 - DAY),
        "later": (q2, max(add_months(q2, 3) - DAY, long_end)),
    }


def board(wins: dict[str, tuple[date, date]]) -> dict[str, tuple[date, date]]:
    """board-quarters: the three columns' windows, Next and Later derived from Now's quarter
    when ``wins`` lacks them (a caller that holds only Now's); given ones are kept."""
    q0 = wins["now"][0]
    q1, q2 = add_months(q0, 3), add_months(q0, 6)
    later = (q2, add_months(q2, 3) - DAY)
    return {"now": (q0, q1 - DAY), "next": (q1, q2 - DAY), "later": later, **wins}


def add_months(day: date, months: int) -> date:
    """``day`` moved ``months`` calendar months, clamped to the month's last day."""
    year, month = divmod(day.month - 1 + months, 12)
    year += day.year
    return date(year, month + 1, min(day.day, monthrange(year, month + 1)[1]))


def horizon_of(r: Resolved, wins: dict[str, tuple[date, date]]) -> str:
    """The column an item's dates put it in: Now when they touch this quarter (work
    started earlier and still running, or overdue), Next when it starts next quarter,
    Later when it starts after that; an undated item (both dates Oracle's estimate) Later."""
    if r.undated:
        return "later"
    if r.start.date <= wins["now"][1]:
        return "now"
    return "next" if r.start.date <= wins["next"][1] else "later"


def _quarter(day: date, wins: dict[str, tuple[date, date]]) -> int:
    """The quarter ``day`` is in, counted from this one (0; last quarter -1)."""
    q0 = wins["now"][0]
    return ((day.year - q0.year) * 12 + day.month - q0.month) // 3


def shift_to(
    start: date | None, end: date | None, horizon: str, wins: dict[str, tuple[date, date]]
) -> tuple[date, date]:
    """board-quarters: the dates a move to ``horizon``'s column gives, shifted by whole
    quarters (length kept) so the start lands in it (Now: this quarter, unless they touch it
    already; Later: the first quarter of Later, unless they start later still). Undated:
    the quarter itself (Later: its first quarter)."""
    if start is None or end is None:
        q = wins[horizon][0]
        return q, add_months(q, 3) - DAY
    at = _quarter(start, wins)
    to = {"now": 0, "next": 1, "later": 2}[horizon]
    if horizon == "now" and start <= wins["now"][1]:
        to = at
    if horizon == "later" and at >= 2:
        to = at
    moved = add_months(start, 3 * (to - at))
    return moved, moved + (end - start)


def resolve_by_dates(
    candidates: list[Candidate],
    wins: dict[str, tuple[date, date]],
    effort_weeks: float | None = None,
) -> tuple[Resolved, str]:
    """board-quarters: an item's dates and the column they put it in; a bar no source dates
    is Later's estimate, a part no source gives is estimated in its own column's window."""
    wins = board(wins)
    r = resolve(candidates, wins["later"], effort_weeks)
    if r.undated:
        return r, "later"
    h = horizon_of(r, wins)
    r = resolve(candidates, wins[h], effort_weeks)
    return r, horizon_of(r, wins)


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


def lead_days(effort_weeks: float | None) -> int:
    """The calendar days an estimated span takes, its end included: the effort's weeks x 7
    (whole days, at least 1), else 28 days, as suggest() spans its days."""
    if effort_weeks is None or effort_weeks <= 0:
        return FALLBACK_DAYS
    return max(1, int(effort_weeks * 7 + 0.5))


def resolve(
    candidates: list[Candidate], window: tuple[date, date], effort_weeks: float | None = None
) -> Resolved:
    """The item's start and end by precedence, falling back to ``window``; a start no
    source gives lies the feature's effort (``effort_weeks``) before a given end."""
    s, e = _best(candidates, "start"), _best(candidates, "end")
    end = Dated(e.end, e.source, False) if e is not None and e.end else None
    start = Dated(s.start, s.source, False) if s is not None and s.start else None
    if start is None:
        day = window[0]
        if end is not None:
            day = end.date - timedelta(days=lead_days(effort_weeks) - 1)
        start = Dated(day, "estimated", True)
    if end is None:
        day = window[1]
        if start.date > day:
            day = start.date + timedelta(days=END_LEAD_DAYS - 1)
        end = Dated(day, "estimated", True)
    return Resolved(start, end)


def after_dependencies[K](
    resolved: dict[K, Resolved], depends_on: dict[K, list[K]]
) -> dict[K, Resolved]:
    """walkb-roadmap: an item dated only by its end gets no made-up start before what it
    depends on: its estimated start is the day after the latest end of its dependencies
    (the end itself when that is later). A fully estimated bar (walkb-roadmap review)
    moves to start the day after that latest end, keeping its length. Dependencies first;
    a cycle is cut where it is met."""
    out: dict[K, Resolved] = {}
    seen: set[K] = set()

    def visit(key: K) -> None:
        if key in out or key in seen or key not in resolved:
            return
        seen.add(key)
        for dep in depends_on.get(key, []):
            visit(dep)
        r = resolved[key]
        ends = [
            out.get(dep, resolved[dep]).end.date
            for dep in depends_on.get(key, [])
            if dep in resolved and dep != key
        ]
        if r.start.estimated and ends and max(ends) >= r.start.date:
            day = max(ends) + DAY
            if r.end.estimated:
                r = Resolved(
                    Dated(day, "estimated", True),
                    Dated(day + (r.end.date - r.start.date), "estimated", True),
                )
            else:
                r = Resolved(Dated(min(day, r.end.date), "estimated", True), r.end)
        out[key] = r

    for key in resolved:
        visit(key)
    return out


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
