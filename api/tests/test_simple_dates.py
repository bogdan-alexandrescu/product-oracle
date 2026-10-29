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
- test_an_end_only_source_keeps_the_window_start_or_backs_off: protects=an engineering
  end inside the window keeps the window's start (estimated); one before the window
  starts 42 days back; fails_when=a bar starts after it ends; no_claim=none.
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
  latest end; duration = the median of same-confidence dated items, else 42 days; end
  clipped to the window's end when the start is inside it; one-sentence basis;
  fails_when=any of these rules is not the one applied; no_claim=the daily regeneration
  (API tests).
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
    assert r.start == Dated(WINDOW[0], "estimated", True)
    assert (r.source, r.estimated) == ("engineering", False)

    r = dates.resolve([tracker], WINDOW)
    assert r.end == Dated(date(2026, 12, 1), "tracker", False)

    r = dates.resolve([], WINDOW)
    assert r.start == Dated(WINDOW[0], "estimated", True)
    assert r.end == Dated(WINDOW[1], "estimated", True)
    assert (r.source, r.estimated, r.undated) == ("estimated", True, True)


def test_ties_within_a_source_take_the_latest_update():
    older = Candidate(None, date(2026, 11, 1), "tracker", OLD)
    newer = Candidate(None, date(2026, 12, 15), "tracker", NEW)
    assert dates.resolve([newer, older], WINDOW).end.date == date(2026, 12, 15)
    assert dates.resolve([older, newer], WINDOW).end.date == date(2026, 12, 15)
    e_old = Candidate(None, date(2026, 11, 2), "engineering", OLD)
    e_new = Candidate(None, date(2026, 11, 9), "engineering", NEW)
    assert dates.resolve([e_new, e_old, newer], WINDOW).end.date == date(2026, 11, 9)


def test_an_end_only_source_keeps_the_window_start_or_backs_off():
    inside = dates.resolve([Candidate(None, date(2026, 11, 30), "tracker", NEW)], WINDOW)
    assert inside.start == Dated(WINDOW[0], "estimated", True)
    before = dates.resolve([Candidate(None, date(2026, 9, 30), "tracker", NEW)], WINDOW)
    assert before.start == Dated(date(2026, 8, 20), "estimated", True)
    assert before.start.date <= before.end.date
    # A typed start after the window's end: the end follows it (estimated).
    late = dates.resolve([Candidate(date(2027, 2, 1), None, "typed", NEW)], WINDOW)
    assert late.end == Dated(date(2027, 3, 14), "estimated", True)


def test_horizon_windows_at_a_quarter_boundary():
    dec31 = dates.windows(HORIZONS, date(2026, 12, 31))
    assert dec31["now"] == (date(2026, 10, 1), date(2026, 12, 31))
    assert dec31["next"] == (date(2027, 1, 1), date(2027, 6, 30))
    assert dec31["later"] == (date(2027, 7, 1), date(2028, 12, 31))
    jan1 = dates.windows(HORIZONS, date(2027, 1, 1))
    assert jan1["now"] == (date(2027, 1, 1), date(2027, 3, 31))
    assert jan1["next"] == (date(2027, 4, 1), date(2027, 9, 30))


def test_waterfall_split_when_no_named_phases():
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
    s = dates.suggest(WINDOW, [("Ledger", date(2026, 10, 20)), ("Import", date(2026, 11, 1))],
                      [30], "high", "now")  # fmt: skip
    assert s.start == date(2026, 11, 2)
    assert s.end == date(2026, 12, 1)
    assert "Import" in s.basis and s.basis.count(".") == 1


def test_suggestion_without_dependencies_starts_with_the_window():
    s = dates.suggest(WINDOW, [], [10, 20, 60], "medium", "now")
    assert (s.start, s.end) == (date(2026, 10, 1), date(2026, 10, 20))
    assert "median" in s.basis


def test_suggestion_falls_back_to_42_days():
    s = dates.suggest(WINDOW, [], [], None, "now")
    assert (s.start, s.end) == (date(2026, 10, 1), date(2026, 11, 11))
    assert "42 days" in s.basis


def test_suggestion_end_is_clipped_to_the_window():
    s = dates.suggest(WINDOW, [("Ledger", date(2026, 12, 1))], [], None, "now")
    assert (s.start, s.end) == (date(2026, 12, 2), date(2026, 12, 31))
    assert "window" in s.basis


def test_suggestion_past_the_window_is_not_clipped():
    s = dates.suggest(WINDOW, [("Ledger", date(2027, 1, 10))], [], None, "now")
    assert (s.start, s.end) == (date(2027, 1, 11), date(2027, 2, 21))


def test_median_is_of_whole_days():
    assert dates.median_days([10, 11]) == 11
    assert dates.median_days([10, 20, 60]) == 20
    assert dates.median_days([]) == dates.FALLBACK_DAYS
