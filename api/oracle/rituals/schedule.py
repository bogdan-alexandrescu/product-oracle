"""A ritual's schedule: a small typed rule plus an IANA time zone (no new dependency).

One zone (owner decision 2026-10-22): every ritual is in the Company time zone. People
send the rule (:class:`RitualSchedule`, the API's input, which has no zone); Oracle
stores it with the company's zone (:class:`Schedule`) and moves it when the zone changes.

``next_occurrence(schedule, after)`` is the first due time strictly after ``after``, in
UTC. Times are wall-clock times in the schedule's zone (``zoneinfo``), so a daylight
saving shift keeps "Mondays 09:00" at 09:00 local.

- ``weekly``: every week on ``weekday`` (0 = Monday);
- ``every_n_weeks``: every ``interval`` (2-12) weeks on ``weekday``, counted from the
  week of :data:`EPOCH` so the series never depends on when it was saved;
- ``monthly``: the ``week_of_month``-th (1-4, or -1 for the last) ``weekday`` of each
  month;
- ``quarterly``: the same, in ``month`` (1-3: the quarter's first, second or third
  month) of each quarter;
- ``yearly``: the same, once a year in ``month`` (1-12).
"""

import re
from calendar import monthrange
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

Freq = Literal["weekly", "monthly", "quarterly", "yearly", "every_n_weeks"]
# The Company time zone of a company that never set one (owner decision 2026-10-22).
DEFAULT_ZONE = "America/Los_Angeles"
# A Monday: week 0 of every every_n_weeks series.
EPOCH = date(2024, 1, 1)
TIME = re.compile(r"([01]\d|2[0-3]):[0-5]\d")


def zone(name: str) -> ZoneInfo:
    """The IANA zone ``name``; ValueError when there is none."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ValueError(f"unknown time zone {name!r}") from None


class RitualSchedule(BaseModel):
    """The rule people set: the API's input. A ``timezone`` sent with it is not read: the
    ritual is in the Company time zone."""

    freq: Freq
    interval: int = Field(1, ge=1, le=12)
    weekday: int = Field(0, ge=0, le=6)
    week_of_month: int = 1
    month: int = Field(1, ge=1, le=12)
    time: str = "09:00"

    @field_validator("time")
    @classmethod
    def _time(cls, v: str) -> str:
        if not TIME.fullmatch(v):
            raise ValueError("time must be HH:MM (00:00 to 23:59)")
        return v

    @field_validator("week_of_month")
    @classmethod
    def _week(cls, v: int) -> int:
        if v not in (-1, 1, 2, 3, 4):
            raise ValueError("week_of_month must be 1 to 4, or -1 for the last")
        return v

    @model_validator(mode="after")
    def _shape(self) -> "Schedule":
        if self.freq == "every_n_weeks" and not 2 <= self.interval <= 12:
            raise ValueError("interval: every_n_weeks repeats every 2 to 12 weeks")
        if self.freq == "quarterly" and self.month > 3:
            raise ValueError("month: a quarter starts in its month 1, 2 or 3")
        return self

    def in_zone(self, timezone: str) -> "Schedule":
        """The rule in ``timezone`` (the Company time zone), as Oracle stores it."""
        return Schedule(**self.model_dump(), timezone=timezone)


class Schedule(RitualSchedule):
    """A stored schedule: the rule in the Company time zone."""

    timezone: str = DEFAULT_ZONE

    @field_validator("timezone")
    @classmethod
    def _zone(cls, v: str) -> str:
        zone(v)
        return v


def _clock(s: Schedule) -> time:
    h, m = s.time.split(":")
    return time(int(h), int(m))


def _at(day: date, s: Schedule) -> datetime:
    return datetime.combine(day, _clock(s), tzinfo=zone(s.timezone)).astimezone(UTC)


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    days = monthrange(year, month)[1]
    if nth == -1:
        last = date(year, month, days)
        return last - timedelta(days=(last.weekday() - weekday) % 7)
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (nth - 1))


def _months(s: Schedule) -> set[int]:
    if s.freq == "monthly":
        return set(range(1, 13))
    if s.freq == "quarterly":
        return {s.month + 3 * q for q in range(4)}
    return {s.month}


def next_occurrence(schedule: Schedule | dict[str, Any], after: datetime) -> datetime:
    """The first due time of ``schedule`` strictly after ``after`` (UTC)."""
    s = schedule if isinstance(schedule, Schedule) else Schedule(**schedule)
    local = after.astimezone(zone(s.timezone)).date()
    if s.freq in ("weekly", "every_n_weeks"):
        step = s.interval if s.freq == "every_n_weeks" else 1
        day = local - timedelta(days=1)
        for _ in range(7 * step + 8):
            if day.weekday() == s.weekday and ((day - EPOCH).days // 7) % step == 0:
                at = _at(day, s)
                if at > after:
                    return at
            day += timedelta(days=1)
    else:
        months = _months(s)
        year, month = local.year, local.month - 1
        if month == 0:
            year, month = year - 1, 12
        for _ in range(26):
            if month in months:
                at = _at(_nth_weekday(year, month, s.weekday, s.week_of_month), s)
                if at > after:
                    return at
            year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    raise ValueError("no next occurrence")  # pragma: no cover - every rule repeats


def runs_per_month(s: Schedule | dict[str, Any]) -> float:
    """How often the schedule fires in a month: weekly 4.33, every N weeks 4.33 / N,
    monthly 1, quarterly 0.33, yearly 0.08."""
    s = s if isinstance(s, Schedule) else Schedule(**s)
    return {
        "weekly": 4.33,
        "every_n_weeks": round(4.33 / s.interval, 2),
        "monthly": 1.0,
        "quarterly": 0.33,
        "yearly": 0.08,
    }[s.freq]


def lookback_days(s: Schedule | dict[str, Any]) -> int:
    """The first occurrence's "since last" window: 7, 31 or 92 days."""
    s = s if isinstance(s, Schedule) else Schedule(**s)
    if s.freq == "weekly":
        return 7
    if s.freq == "every_n_weeks":
        return 7 * s.interval
    return 31 if s.freq == "monthly" else 92
