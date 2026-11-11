"""board-quarters (owner, Nov 10): Now is this calendar quarter, Next the next one, Later
the quarters after; an item's column comes from its dates, never a stored horizon.

Test card (protects / fails_when / no_claim):

- test_quarter_windows_on_the_company_day: protects=Now, Next and Later are calendar
  quarters on the company's day, across a year end; fails_when=the windows read the
  company's short/medium horizons (a two-quarter Next); no_claim=Later's end (the long
  horizon's, only an undated bar's estimate).
- test_horizon_of_reads_dates: protects=an item touching this quarter (started earlier and
  still running, or ending on its first day) is Now, one starting next quarter Next, one
  starting after that Later, an undated one Later, an end-only (engineering) one by its
  estimated start; fails_when=a stored horizon or only the start decides.
- test_shift_to_moves_whole_quarters: protects=a move to another column shifts the dates
  by whole quarters, keeping their length, so the item lands in that quarter (a year end
  crossed, a month-end clamped, a spanning item, an undated item gets the quarter);
  fails_when=dates shift by days between windows or stay put.
"""

from datetime import date

from oracle.simple import dates
from oracle.simple.dates import Candidate, Dated, Resolved

HORIZONS = {"short_quarters": 1, "medium_quarters": 2, "long_from_months": 12,
            "long_to_months": 24}  # fmt: skip


def test_quarter_windows_on_the_company_day():
    nov = dates.windows(HORIZONS, date(2026, 11, 10))
    assert nov["now"] == (date(2026, 10, 1), date(2026, 12, 31))
    assert nov["next"] == (date(2027, 1, 1), date(2027, 3, 31))
    assert nov["later"][0] == date(2027, 4, 1)
    assert nov["later"][1] > date(2027, 6, 30)
    dec31 = dates.windows(HORIZONS, date(2026, 12, 31))
    assert dec31["now"] == (date(2026, 10, 1), date(2026, 12, 31))
    jan1 = dates.windows(HORIZONS, date(2027, 1, 1))
    assert jan1["now"] == (date(2027, 1, 1), date(2027, 3, 31))
    assert jan1["next"] == (date(2027, 4, 1), date(2027, 6, 30))
    assert jan1["later"][0] == date(2027, 7, 1)


def _typed(start: date, end: date) -> Resolved:
    return Resolved(Dated(start, "typed", False), Dated(end, "typed", False))


def test_horizon_of_reads_dates():
    w = dates.windows(HORIZONS, date(2026, 11, 10))
    assert dates.horizon_of(_typed(date(2026, 8, 15), date(2026, 11, 20)), w) == "now"
    assert dates.horizon_of(_typed(date(2026, 12, 31), date(2027, 1, 20)), w) == "now"
    assert dates.horizon_of(_typed(date(2026, 7, 1), date(2026, 10, 1)), w) == "now"
    assert dates.horizon_of(_typed(date(2027, 1, 1), date(2027, 5, 1)), w) == "next"
    assert dates.horizon_of(_typed(date(2027, 3, 31), date(2027, 4, 2)), w) == "next"
    assert dates.horizon_of(_typed(date(2027, 4, 1), date(2027, 4, 2)), w) == "later"
    undated = dates.resolve([], w["later"])
    assert dates.horizon_of(undated, w) == "later"
    # An engineering end only: the estimated start (the effort before it) decides.
    eng = dates.resolve([Candidate(None, date(2027, 2, 20), "engineering")], w["later"], 2)
    assert eng.start.estimated and not eng.end.estimated
    assert dates.horizon_of(eng, w) == "next"


def test_shift_to_moves_whole_quarters():
    w = dates.windows(HORIZONS, date(2026, 11, 10))
    # Now -> Next across the year end, length kept (46 days).
    assert dates.shift_to(date(2026, 10, 1), date(2026, 11, 15), "next", w) == (
        date(2027, 1, 1), date(2027, 2, 15))  # fmt: skip
    # Later -> Next.
    assert dates.shift_to(date(2027, 4, 10), date(2027, 5, 20), "next", w) == (
        date(2027, 1, 10), date(2027, 2, 19))  # fmt: skip
    # Next -> Now, a month end clamped (Mar 31 - 3 months: Dec 31).
    assert dates.shift_to(date(2027, 3, 31), date(2027, 4, 9), "now", w) == (
        date(2026, 12, 31), date(2027, 1, 9))  # fmt: skip
    # Started last quarter, running into this one: Next is two quarters on.
    assert dates.shift_to(date(2026, 8, 15), date(2026, 11, 20), "next", w) == (
        date(2027, 2, 15), date(2027, 5, 23))  # fmt: skip
    # Far in Later, moved to Later: stays.
    assert dates.shift_to(date(2027, 10, 1), date(2027, 11, 1), "later", w) == (
        date(2027, 10, 1), date(2027, 11, 1))  # fmt: skip
    # Undated: the quarter itself.
    assert dates.shift_to(None, None, "next", w) == w["next"]
    spans = [(date(2026, 10, 1), date(2026, 11, 15)), (date(2027, 4, 10), date(2027, 5, 20))]
    for start, end in spans:
        for h in ("now", "next", "later"):
            s, e = dates.shift_to(start, end, h, w)
            assert (e - s) == (end - start)
            assert dates.horizon_of(_typed(s, e), w) == h
