"""Simple S2 (#723): each roadmap item's dates, its estimated window, its waterfall phases
and Oracle's date suggestion (oracle.simple.dates). Pure functions, no database.

Test cards (protects / fails_when / no_claim):

- test_precedence_own_over_engineering_over_tracker_over_window: protects=typed or
  accepted dates > engineering > tracker > the horizon's window, each date naming its
  source and whether it is estimated; fails_when=a lower source wins, or an estimated date
  says it is not; no_claim=where the candidates come from (the API tests seed them).
- test_ties_within_a_source_take_the_latest_update: protects=two tracker dates (two
  engineering dates) -> the most recently updated wins; fails_when=the first or the
  earliest wins; no_claim=none.
- test_an_end_only_item_starts_its_effort_before_its_end (and the tests after it):
  protects=a start no source gives makes a span of the feature's effort (weeks x 7
  days, the end minus N-1, as a suggestion's span), else of 28 days, before the window's
  start if need be, never after the end; a typed start is never changed; an estimated
  end keeps its rule;
  fails_when=the bar starts at the window's start (a 1-week feature read as a 10-week
  bar); no_claim=where the effort comes from (tests/test_simple_roadmap_api.py).
- test_horizon_windows_at_a_quarter_boundary: protects=now/next/later are the company's
  short/medium/long windows on the company's day; Dec 31 and Jan 1 give different
  quarters; fails_when=the server's (UTC) day anchors them; no_claim=the API's clock
  (tests/test_simple_roadmap_api.py reads it through the route).
- test_waterfall_split_when_no_named_phases: protects=15/55/20/10 of the bar, contiguous,
  all estimated; fails_when=a phase overlaps, leaves a gap, or says it is dated;
  no_claim=how S4 draws it.
- test_waterfall_from_named_dated_gates: protects=a gate or milestone naming a phase with
  a date ends that phase on that date, not estimated; the others keep the split,
  estimated; fails_when=a named date is ignored; no_claim=gates without a phase name.
- test_suggestion_* (dependencies, median, fallback, clipping, no clip past the window):
  protects=start = the later of the window start and the day after the dependencies'
  latest end; duration = the median of same-confidence dated items, else 28 days, put in
  plain words ("about the same as N similar items"), not "median"; end clipped to the
  window's end when the start is inside it; one-sentence basis; fails_when=any of these
  rules is not the one applied; no_claim=the daily regeneration (API tests).
"""

from datetime import UTC, date, datetime

from oracle.simple import dates
from oracle.simple.dates import Candidate, Dated

HORIZONS = {"short_quarters": 1, "medium_quarters": 2, "long_from_months": 12,
            "long_to_months": 24}  # fmt: skip
WINDOW = (date(2026, 10, 1), date(2026, 12, 31))
OLD = datetime(2026, 9, 1, tzinfo=UTC)
NEW = datetime(2026, 10, 1, tzinfo=UTC)


def test_precedence_own_over_engineering_over_tracker_over_window():
    """Dates resolve by precedence: typed or accepted, then engineering, then tracker."""
    tracker = Candidate(None, date(2026, 12, 1), "tracker", NEW)
    engineering = Candidate(None, date(2026, 11, 20), "engineering", OLD)
    typed = Candidate(date(2026, 10, 5), date(2026, 11, 1), "typed", OLD)
    accepted = Candidate(date(2026, 10, 7), date(2026, 11, 3), "accepted", OLD)

    r = dates.resolve([tracker, engineering, typed], WINDOW)
    assert r.start == Dated(date(2026, 10, 5), "typed", False)
    assert r.end == Dated(date(2026, 11, 1), "typed", False)

    r = dates.resolve([tracker, accepted], WINDOW)
    assert (r.start.source, r.end.source) == ("accepted", "accepted")

    r = dates.resolve([tracker, engineering], WINDOW)
    assert r.end == Dated(date(2026, 11, 20), "engineering", False)
    assert r.start == Dated(date(2026, 10, 24), "estimated", True)
    assert (r.source, r.estimated) == ("engineering", False)

    r = dates.resolve([tracker], WINDOW)
    assert r.end == Dated(date(2026, 12, 1), "tracker", False)

    r = dates.resolve([], WINDOW)
    assert r.start == Dated(WINDOW[0], "estimated", True)
    assert r.end == Dated(WINDOW[1], "estimated", True)
    assert (r.source, r.estimated, r.undated) == ("estimated", True, True)


def test_ties_within_a_source_take_the_latest_update():
    """When two candidates share a source, the most recently updated one wins."""
    older = Candidate(None, date(2026, 11, 1), "tracker", OLD)
    newer = Candidate(None, date(2026, 12, 15), "tracker", NEW)
    assert dates.resolve([newer, older], WINDOW).end.date == date(2026, 12, 15)
    assert dates.resolve([older, newer], WINDOW).end.date == date(2026, 12, 15)
    e_old = Candidate(None, date(2026, 11, 2), "engineering", OLD)
    e_new = Candidate(None, date(2026, 11, 9), "engineering", NEW)
    assert dates.resolve([e_new, e_old, newer], WINDOW).end.date == date(2026, 11, 9)


def test_an_end_only_item_starts_its_effort_before_its_end():
    """An end-only item's start sits its effort's length of days before that end."""
    end = Candidate(None, date(2026, 11, 30), "tracker", NEW)
    week = dates.resolve([end], WINDOW, effort_weeks=1)
    assert week.start == Dated(date(2026, 11, 24), "estimated", True)
    assert week.end == Dated(date(2026, 11, 30), "tracker", False)
    assert dates.resolve([end], WINDOW, effort_weeks=0.5).start.date == date(2026, 11, 27)
    assert dates.resolve([end], WINDOW, effort_weeks=4).start.date == date(2026, 11, 3)


def test_an_end_only_item_without_effort_starts_28_days_before_its_end():
    """Without an effort estimate, an end-only item starts 28 days before its end."""
    end = Candidate(None, date(2026, 11, 30), "tracker", NEW)
    assert dates.resolve([end], WINDOW).start == Dated(date(2026, 11, 3), "estimated", True)
    assert dates.resolve([end], WINDOW, effort_weeks=None).start.date == date(2026, 11, 3)


def test_an_estimated_span_is_the_effort_s_days_as_a_suggestion_s():
    """An estimated span covers exactly the effort's days, or 28 with none given."""
    # A 1-week item spans 7 days and a 3-week item 21, end included, as suggest() spans
    # its days (start + days - 1); without an effort, 28 days as suggest()'s fallback.
    end = Candidate(None, date(2026, 11, 30), "tracker", NEW)
    for weeks, days in ((1, 7), (3, 21), (None, dates.FALLBACK_DAYS)):
        r = dates.resolve([end], WINDOW, effort_weeks=weeks)
        assert (r.end.date - r.start.date).days + 1 == days
        s = dates.suggest(WINDOW, [], [days] if weeks else [], None, "now")
        assert (s.end - s.start).days + 1 == days
    assert dates.resolve([end], WINDOW, effort_weeks=3).start.date == date(2026, 11, 10)


def test_an_estimated_start_may_lie_before_the_window_never_after_the_end():
    """An estimated start may lie before the window, but never after its own end."""
    early = Candidate(None, date(2026, 10, 10), "engineering", NEW)
    r = dates.resolve([early], WINDOW, effort_weeks=2)
    assert r.start == Dated(date(2026, 9, 27), "estimated", True)
    # An end before its window keeps working: its effort back from the end.
    before = dates.resolve([Candidate(None, date(2026, 9, 30), "tracker", NEW)], WINDOW)
    assert before.start == Dated(date(2026, 9, 3), "estimated", True)
    assert before.start.date <= before.end.date
    tiny = dates.resolve([early], WINDOW, effort_weeks=0.01)
    assert tiny.start.date <= tiny.end.date


def test_a_typed_start_is_never_changed_and_an_estimated_end_keeps_its_rule():
    """A typed start date is never changed, even when it falls outside the window."""
    typed = Candidate(date(2026, 10, 2), date(2026, 11, 30), "typed", NEW)
    r = dates.resolve([typed], WINDOW, effort_weeks=1)
    assert r.start == Dated(date(2026, 10, 2), "typed", False)
    start_only = dates.resolve([Candidate(date(2026, 10, 2), None, "typed", NEW)], WINDOW, 1)
    assert start_only.start == Dated(date(2026, 10, 2), "typed", False)
    assert start_only.end == Dated(WINDOW[1], "estimated", True)
    # A typed start after the window's end: the end follows it (estimated), as before.
    late = dates.resolve([Candidate(date(2027, 2, 1), None, "typed", NEW)], WINDOW, 1)
    assert late.end == Dated(date(2027, 3, 14), "estimated", True)
    # An undated item keeps its window.
    none = dates.resolve([], WINDOW, effort_weeks=1)
    assert (none.start.date, none.end.date) == WINDOW


def test_horizon_windows_at_a_quarter_boundary():
    """Now, Next and Later horizons track calendar quarters, shifting at the boundary."""
    # board-quarters: Now this calendar quarter, Next the next one, Later from the one after.
    dec31 = dates.windows(HORIZONS, date(2026, 12, 31))
    assert dec31["now"] == (date(2026, 10, 1), date(2026, 12, 31))
    assert dec31["next"] == (date(2027, 1, 1), date(2027, 3, 31))
    assert dec31["later"] == (date(2027, 4, 1), date(2028, 12, 31))
    jan1 = dates.windows(HORIZONS, date(2027, 1, 1))
    assert jan1["now"] == (date(2027, 1, 1), date(2027, 3, 31))
    assert jan1["next"] == (date(2027, 4, 1), date(2027, 6, 30))


def test_waterfall_split_when_no_named_phases():
    """With no named phases, a span splits into four waterfall phases by proportion."""
    start = Dated(date(2026, 1, 1), "typed", False)
    end = Dated(date(2026, 4, 10), "typed", False)  # 100 days
    out = dates.phases(start, end, None, [])
    assert [p.key for p in out] == ["discover", "build", "beta", "launch"]
    assert [(p.start, p.end) for p in out] == [
        (date(2026, 1, 1), date(2026, 1, 15)),
        (date(2026, 1, 16), date(2026, 3, 11)),
        (date(2026, 3, 12), date(2026, 3, 31)),
        (date(2026, 4, 1), date(2026, 4, 10)),
    ]
    assert all(p.estimated for p in out)


def test_waterfall_from_named_dated_gates():
    """Named, dated gates fix their own phase boundaries; the rest stay estimated."""
    start = Dated(date(2026, 1, 1), "typed", False)
    end = Dated(date(2026, 4, 10), "typed", False)
    gates = [{"name": "Beta", "criterion": "3 pilots", "date": "2026-03-20"}, {"name": "Pilot"}]
    milestone = {"name": "Build done", "phase": "build", "date": "2026-02-28"}
    out = {p.key: p for p in dates.phases(start, end, milestone, gates)}
    assert (out["build"].end, out["build"].estimated) == (date(2026, 2, 28), False)
    assert (out["beta"].start, out["beta"].end) == (date(2026, 3, 1), date(2026, 3, 20))
    assert out["beta"].estimated is False
    assert out["discover"].estimated and out["launch"].estimated
    assert out["launch"].start == date(2026, 3, 21) and out["launch"].end == date(2026, 4, 10)


def test_suggestion_dependencies_push_the_start():
    """A suggested start is pushed past the latest dependency's own end date."""
    s = dates.suggest(WINDOW, [("Ledger", date(2026, 10, 20)), ("Import", date(2026, 11, 1))],
                      [30], "high", "now")  # fmt: skip
    assert s.start == date(2026, 11, 2)
    assert s.end == date(2026, 12, 1)
    assert "Import" in s.basis and s.basis.count(".") == 1


def test_suggestion_without_dependencies_starts_with_the_window():
    """With no dependencies, a suggestion starts at the window in plain words."""
    s = dates.suggest(WINDOW, [], [10, 20, 60], "medium", "now")
    assert (s.start, s.end) == (date(2026, 10, 1), date(2026, 10, 20))
    # fix2-simple-roadmap-gantt finding 30: plain words, not "median".
    assert "similar" in s.basis and "median" not in s.basis


def test_suggestion_falls_back_to_28_days():
    """With nothing to go on, a suggestion falls back to a 28-day span."""
    s = dates.suggest(WINDOW, [], [], None, "now")
    assert (s.start, s.end) == (date(2026, 10, 1), date(2026, 10, 28))
    assert "28 days" in s.basis
    assert dates.FALLBACK_DAYS == 28


def test_suggestion_end_is_clipped_to_the_window():
    """A suggestion's end is clipped to the window when a dependency pushes past it."""
    s = dates.suggest(WINDOW, [("Ledger", date(2026, 12, 10))], [], None, "now")
    assert (s.start, s.end) == (date(2026, 12, 11), date(2026, 12, 31))
    assert "window" in s.basis


def test_suggestion_past_the_window_is_not_clipped():
    """A suggestion is not clipped once a dependency pushes it past the window."""
    s = dates.suggest(WINDOW, [("Ledger", date(2027, 1, 10))], [], None, "now")
    assert (s.start, s.end) == (date(2027, 1, 11), date(2027, 2, 7))


def test_median_is_of_whole_days():
    """The median of a list of day counts is itself always a whole day count."""
    assert dates.median_days([10, 11]) == 11
    assert dates.median_days([10, 20, 60]) == 20
    assert dates.median_days([]) == dates.FALLBACK_DAYS


# roadmap-dates (QA Nov 14): an undated item's estimate is Oracle's suggestion, else the
# quarter it was added to, else the horizon window; the estimate may put it in any column.
HZ = {"short_quarters": 1, "medium_quarters": 2, "long_from_months": 12, "long_to_months": 24}


def test_undated_estimate_is_the_suggestion_then_the_quarter_then_the_window():
    """An undated item's estimate falls back: suggestion, then quarter, then window."""
    w = dates.windows(HZ, date(2026, 11, 10))
    sug = (date(2027, 1, 4), date(2027, 2, 14))
    q4 = date(2026, 10, 1)
    r, h = dates.resolve_by_dates([], w, None, suggested=sug, quarter=q4)
    assert (r.start.date, r.end.date) == sug and r.estimated and r.source == "estimated"
    assert h == "next" and dates.horizon_of(r, w) == "next"
    r, h = dates.resolve_by_dates([], w, None, quarter=q4)
    assert (r.start.date, r.end.date) == (q4, date(2026, 12, 31)) and r.estimated
    assert h == "now" and dates.horizon_of(r, w) == "now"
    r, h = dates.resolve_by_dates([], w, None)
    assert (r.start.date, r.end.date) == w["later"] and h == "later"
    # Accepted dates win over all of them.
    own = [Candidate(date(2027, 5, 1), date(2027, 5, 20), "accepted")]
    r, h = dates.resolve_by_dates(own, w, None, suggested=sug, quarter=q4)
    assert (r.start.date, r.end.date) == (date(2027, 5, 1), date(2027, 5, 20))
    assert not r.estimated and h == "later"
    # A dependency's move keeps where the estimate came from (its column follows it).
    r, _ = dates.resolve_by_dates([], w, None, suggested=sug)
    moved = dates.after_dependencies({"a": r, "b": _typed_r(date(2026, 11, 1), date(2027, 4, 9))},
                                     {"a": ["b"]})  # fmt: skip
    assert moved["a"].start.date == date(2027, 4, 10)
    assert dates.horizon_of(moved["a"], w) == "later"


def _typed_r(start: date, end: date) -> dates.Resolved:
    return dates.Resolved(Dated(start, "typed", False), Dated(end, "typed", False))


def test_quarter_window_and_its_word():
    """A quarter's date window and its Q# year label describe the same quarter."""
    assert dates.quarter_window(date(2026, 10, 1)) == (date(2026, 10, 1), date(2026, 12, 31))
    assert dates.quarter_word(date(2027, 4, 1)) == "Q2 2027"
