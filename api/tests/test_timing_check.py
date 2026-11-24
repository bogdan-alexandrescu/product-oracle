"""#1719: the collection check (tests.timing_check) sees a test that asserts on a
difference of perf_counter / monotonic reads, and no other.

Card: protects=an unmarked wall-clock assert fails collection; fails_when=the check misses
a direct, named or chained elapsed time, or flags a deadline or a wall date;
no_claim=a test that times inside a helper it calls."""

import ast
import textwrap

import pytest

from tests.timing_check import asserts_wall_clock

TIMED = {
    "direct": """
        start = time.perf_counter()
        run()
        assert time.perf_counter() - start < 0.1
    """,
    "named": """
        began = time.monotonic()
        run()
        elapsed = time.monotonic() - began
        assert elapsed < 3, elapsed
    """,
    "chained": """
        t0 = perf_counter_ns()
        run()
        took = perf_counter_ns() - t0
        ms = took / 1e6
        assert ms < 50
    """,
    "in_a_compound_assert": """
        started = time.monotonic()
        resp = run()
        assert resp.status_code == 200 and time.monotonic() - started < 3
    """,
}
UNTIMED = {
    "a_deadline": """
        out = call_by(time.monotonic() + 30)
        assert out.ok
    """,
    "a_wall_date": """
        old = signed(body, at=time.time() - 301)
        assert abs(int(stamp) - time.time()) < 60
        assert post(old) == 401
    """,
    "a_clock_never_asserted": """
        start = time.perf_counter()
        run()
        log(time.perf_counter() - start)
        assert done()
    """,
}


def _tree(body: str) -> ast.AST:
    return ast.parse("def test():\n" + textwrap.indent(textwrap.dedent(body), "    "))


@pytest.mark.parametrize("body", TIMED.values(), ids=TIMED.keys())
def test_a_wall_clock_assert_is_seen(body):
    """Each shape of elapsed-time assert is seen, so collection fails it unless marked."""
    assert asserts_wall_clock(_tree(body))


@pytest.mark.parametrize("body", UNTIMED.values(), ids=UNTIMED.keys())
def test_a_deadline_or_wall_date_is_not_a_timing_assert(body):
    """A deadline handed to code, a wall date or an unasserted duration is not flagged."""
    assert not asserts_wall_clock(_tree(body))
