"""walk b, roadmap: an item dated only by its end never gets a made-up start that raises a
broken link. Pure functions, no database.

Test cards (protects / fails_when / no_claim):

- test_an_invented_start_is_no_broken_link: protects=an end-only item whose window start
  comes before its dependency's end is not flagged "starts ..., but ... ends"; a real end
  before the dependency's end still is, in words of its end; fails_when=the invented start
  raises the flag; no_claim=blockers.
- test_estimated_starts_follow_dependencies: protects=an end-only item starts the day after
  its dependency ends; a typed start and a fully estimated bar stay; fails_when=the
  end-only item starts at its window's start; no_claim=cycles' order.
"""

from datetime import date

from oracle.simple import constraints, dates
from oracle.simple.constraints import Node
from oracle.simple.dates import Dated, Resolved


def d(y: int, m: int, day: int, estimated: bool = False) -> Dated:
    return Dated(date(y, m, day), "estimated" if estimated else "typed", estimated)


def test_an_invented_start_is_no_broken_link():
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
    # A fully estimated bar stays its window's estimate (suggest() offers dates after "a").
    assert (got["c"].start.date, got["c"].end.date) == (date(2026, 10, 1), date(2026, 10, 31))
    assert got["e"].start == d(2026, 10, 2)
