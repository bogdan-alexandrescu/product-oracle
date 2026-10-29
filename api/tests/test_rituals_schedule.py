"""H2 Cadence engine: the schedule maths (``oracle.rituals.schedule``) and the goals
block's distance to go, which reads like Home (``web/app/home/_goals.ts``). No database.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from oracle.rituals.blocks import distance_text
from oracle.rituals.schedule import Schedule, next_occurrence

LA = "America/Los_Angeles"


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def test_weekly_keeps_the_local_time_across_the_dst_change():
    """protects=criterion 1: every Monday 09:00 Los Angeles is 16:00Z before 2026-11-01 and
    17:00Z after; fails_when=the UTC hour is fixed, or the same instant comes back;
    no_claim=zones other than Los Angeles."""
    s = Schedule(freq="weekly", weekday=0, time="09:00", timezone=LA)
    first = next_occurrence(s, utc(2026, 10, 20))
    assert first == utc(2026, 10, 26, 16)
    second = next_occurrence(s, first)
    assert second == utc(2026, 11, 2, 17)


def test_every_two_and_every_seven_weeks_skip_the_weeks_between():
    """protects=criterion 1: every_n_weeks returns dates exactly N weeks apart on the
    weekday; fails_when=it fires weekly or drifts off the weekday; no_claim=which week
    the series starts in (anchored to a fixed epoch)."""
    for n in (2, 7):
        s = Schedule(freq="every_n_weeks", interval=n, weekday=3, time="10:00", timezone="UTC")
        a = next_occurrence(s, utc(2026, 10, 1))
        b = next_occurrence(s, a)
        assert a.weekday() == 3 and a.hour == 10
        assert (b - a).days == 7 * n


def test_first_tuesday_and_last_friday_monthly():
    """protects=criterion 1: monthly on the first Tuesday and on the last Friday, in local
    time across the DST change; fails_when=the wrong week of the month or a fixed UTC
    hour; no_claim=week_of_month 2-4 (same code path)."""
    s = Schedule(freq="monthly", week_of_month=1, weekday=1, time="10:00", timezone=LA)
    assert next_occurrence(s, utc(2026, 10, 7)) == utc(2026, 11, 3, 18)
    assert next_occurrence(s, utc(2026, 9, 1)) == utc(2026, 9, 1, 17)
    last = Schedule(freq="monthly", week_of_month=-1, weekday=4, time="16:00", timezone=LA)
    assert next_occurrence(last, utc(2026, 10, 1)) == utc(2026, 10, 30, 23)
    assert next_occurrence(last, utc(2026, 10, 31)) == utc(2026, 11, 28, 0)


def test_quarterly_first_wednesday_of_jan_apr_jul_oct():
    """protects=criterion 1: quarterly from month 1 lands on the first Wednesday of
    January, April, July and October; fails_when=another month or weekday; no_claim=a
    quarter starting in February or March (same arithmetic)."""
    s = Schedule(freq="quarterly", month=1, week_of_month=1, weekday=2, time="10:00",
                 timezone="UTC")  # fmt: skip
    got = []
    at = utc(2026, 1, 1)
    for _ in range(4):
        at = next_occurrence(s, at)
        got.append(at)
    assert got == [utc(2026, 1, 7, 10), utc(2026, 4, 1, 10), utc(2026, 7, 1, 10),
                   utc(2026, 10, 7, 10)]  # fmt: skip


def test_yearly_in_its_month():
    """protects=criterion 1: yearly lands once a year in its month; fails_when=it repeats
    within the year; no_claim=leap-year edge cases."""
    s = Schedule(freq="yearly", month=3, week_of_month=2, weekday=0, time="09:30", timezone="UTC")
    a = next_occurrence(s, utc(2026, 4, 1))
    assert a == utc(2027, 3, 8, 9, 30)
    assert next_occurrence(s, a) == utc(2028, 3, 13, 9, 30)


@pytest.mark.parametrize(
    "bad",
    [
        {"timezone": "Mars/Olympus"},
        {"week_of_month": 5},
        {"freq": "every_n_weeks", "interval": 13},
        {"time": "9am"},
    ],
)
def test_invalid_schedules_are_refused(bad):
    """protects=the schedule's checks (criterion 8's 422s come from them); fails_when=an
    unknown zone, week 5, interval 13 or a non-HH:MM time is accepted; no_claim=the HTTP
    shape (tests/test_rituals.py)."""
    body = {"freq": "monthly", "weekday": 0, "week_of_month": 1, "time": "09:00",
            "timezone": "UTC", **bad}  # fmt: skip
    with pytest.raises(ValidationError):
        Schedule(**body)


@pytest.mark.parametrize(
    ("attrs", "text"),
    [
        ({"target": "45%", "current": "38%"}, "7 pts to go"),
        ({"target_text": "45%", "current": 38, "unit": "%"}, "7 pts to go"),
        ({"target": 45, "unit": "%", "comparison": "at_least", "current": 46}, "Target met"),
        ({"target": "below 200ms", "current": "260 ms"}, "60 ms to go"),
        ({"target": "45%"}, "No current value yet"),
        ({"target": "$4M", "current": "$3.1M"}, "$900k to go"),
    ],
)
def test_distance_to_go_reads_like_home(attrs, text):
    """protects=criterion 5: the goals block's distance is Home's text for the same goal
    (text and B5 typed values); fails_when=a different number or wording than
    _goals.ts's assess(); no_claim=goals with a history-derived direction."""
    assert distance_text(attrs) == text
