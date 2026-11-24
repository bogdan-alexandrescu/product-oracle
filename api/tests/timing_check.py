"""#1719: a test that asserts on wall-clock time carries the ``timing`` mark, so CI runs it
alone after the parallel shards (other workers' load never counts against its budget).
The api's counterpart of web/scripts/check-timing-tags.mjs, run at collection by conftest.

A test asserts on wall-clock time when an ``assert`` reads a difference of clock reads
(``time.perf_counter``, ``time.monotonic`` or their ``_ns`` forms, minus another), directly
or through a name assigned from one. ``time.time`` is the wall date (a token's expiry, a
signature's age), not a duration, so it is not read."""

import ast
import inspect
import textwrap
from functools import cache

CLOCKS = {"perf_counter", "perf_counter_ns", "monotonic", "monotonic_ns"}


def _is_clock_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    f = node.func
    if isinstance(f, ast.Attribute):
        return f.attr in CLOCKS
    return isinstance(f, ast.Name) and f.id in CLOCKS


def _reads(node: ast.AST, names: set[str]) -> bool:
    return any(
        _is_clock_call(n) or (isinstance(n, ast.Name) and n.id in names) for n in ast.walk(node)
    )


def _names(node: ast.AST, names: set[str]) -> bool:
    return any(isinstance(n, ast.Name) and n.id in names for n in ast.walk(node))


def asserts_wall_clock(tree: ast.AST) -> bool:
    """Whether a function's tree asserts on a difference of wall-clock reads."""
    clocks: set[str] = set()  # names holding a clock read
    elapsed: set[str] = set()  # names holding a difference of clock reads
    for _ in range(3):  # assignments may chain (start, then elapsed, then ms)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign | ast.AnnAssign | ast.NamedExpr):
                value = node.value
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names = {n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)}
                if value is None:
                    continue
                if _is_clock_call(value):
                    clocks |= names
                elif _differs(value, clocks) or _names(value, elapsed):
                    elapsed |= names
    return any(
        isinstance(node, ast.Assert) and (_differs(node.test, clocks) or _names(node.test, elapsed))
        for node in ast.walk(tree)
    )


def _differs(node: ast.AST, clocks: set[str]) -> bool:
    return any(
        isinstance(n, ast.BinOp)
        and isinstance(n.op, ast.Sub)
        and _reads(n.left, clocks)
        and _reads(n.right, clocks)
        for n in ast.walk(node)
    )


@cache
def _function_asserts_wall_clock(function) -> bool:
    try:
        source = textwrap.dedent(inspect.getsource(function))
    except (OSError, TypeError):
        return False
    return asserts_wall_clock(ast.parse(source))


def unmarked(items) -> list[str]:
    """The node ids (without parameters) of unmarked tests that assert on wall-clock time."""
    return sorted(
        {
            item.nodeid.split("[")[0]
            for item in items
            if getattr(item, "function", None) is not None
            and item.get_closest_marker("timing") is None
            and _function_asserts_wall_clock(item.function)
        }
    )
