"""walk b, roadmap: an item dated only by its end never gets a made-up start that raises a
broken link. Pure functions, no database.

Test cards (protects / fails_when / no_claim):

- test_an_invented_start_is_no_broken_link: protects=an end-only item whose window start
  comes before its dependency's end is not flagged "starts ..., but ... ends"; a real end
  before the dependency's end still is, in words of its end; fails_when=the invented start
  raises the flag; no_claim=blockers.
- test_estimated_starts_follow_dependencies: protects=an end-only item starts the day after
  its dependency ends; a fully estimated bar moves after it, keeping its length; a typed
  start stays; fails_when=the end-only item starts at its window's start, or the fully
  estimated bar stays wholly before its dependency's end; no_claim=cycles' order.
- test_accepted_suggestion_moved_by_a_dependency_reads_its_dependencies: protects=a bar
  estimated from Oracle's suggestion (accepted into a draft) that a dependency moves is
  estimated after what it depends on (basis "dependencies"); one it leaves keeps its
  suggestion's basis, a moved quarter's keeps the quarter's; fails_when=the moved bar still
  reads the suggestion's basis; no_claim=the open suggestion's clearing (service.load).
"""

from datetime import date

from oracle.simple import constraints, dates
from oracle.simple.constraints import Node
from oracle.simple.dates import Dated, Resolved


def d(y: int, m: int, day: int, estimated: bool = False) -> Dated:
    return Dated(date(y, m, day), "estimated" if estimated else "typed", estimated)


def test_an_invented_start_is_no_broken_link():
    """An invented start date is never the dependency link that is actually broken."""
    dep = Node("a", "Search index", d(2026, 10, 1), d(2026, 11, 10))
    item = Node("b", "Search page", d(2026, 10, 1, True), d(2026, 12, 15), depends_on=["a"])
    assert constraints.check([dep, item])["b"] == []
    late = Node("c", "Search filters", d(2026, 10, 1, True), d(2026, 11, 5), depends_on=["a"])
    (flag,) = constraints.check([dep, late])["c"]
    assert flag.kind == "dependency_order"
    assert (
        flag.reason
        == "‘Search filters’ ends Nov 5, but ‘Search index’, which it depends on, ends Nov 10"
    )


def test_estimated_starts_follow_dependencies():
    """An estimated start moves to begin right after the dependency it follows ends."""
    got = dates.after_dependencies(
        {
            "a": Resolved(d(2026, 10, 1), d(2026, 11, 10)),
            "b": Resolved(d(2026, 10, 1, True), d(2026, 12, 15)),
            "c": Resolved(d(2026, 10, 1, True), d(2026, 10, 31, True)),
            "e": Resolved(d(2026, 10, 2), d(2026, 12, 15)),
        },
        {"b": ["a"], "c": ["a"], "e": ["a"]},
    )
    assert got["b"].start == Dated(date(2026, 11, 11), "estimated", True)
    assert got["b"].end == d(2026, 12, 15)
    # walkb-roadmap review: a fully estimated bar moves after "a", keeping its 30 days.
    assert got["c"].start == Dated(date(2026, 11, 11), "estimated", True)
    assert got["c"].end == Dated(date(2026, 12, 11), "estimated", True)
    assert got["e"].start == d(2026, 10, 2)


def test_accepted_suggestion_moved_by_a_dependency_reads_its_dependencies():
    """A suggestion moved by a dependency still reads its basis as dependencies."""
    est = lambda y, m, day: d(y, m, day, True)  # noqa: E731
    got = dates.after_dependencies(
        {
            "a": Resolved(d(2026, 10, 1), d(2026, 11, 10)),
            "b": Resolved(est(2026, 10, 1), est(2026, 10, 31), "suggestion"),
            "c": Resolved(est(2026, 12, 1), est(2026, 12, 20), "suggestion"),
            "q": Resolved(est(2026, 10, 1), est(2026, 10, 31), "quarter"),
        },
        {"b": ["a"], "c": ["a"], "q": ["a"]},
    )
    assert got["b"].start == est(2026, 11, 11)
    assert got["b"].basis == "dependencies"
    assert got["c"].basis == "suggestion"
    assert got["q"].basis == "quarter"
