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


def _timed_positions(tree: ast.AST) -> set[int] | None:
    """The positions of a helper's returned tuple that hold a difference of clock reads
    (position 0 for a single value); None when it returns none."""
    clocks: set[str] = set()
    elapsed: set[str] = set()
    _collect(tree, clocks, elapsed, {})
    found: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Return) and node.value is not None:
            parts = node.value.elts if isinstance(node.value, ast.Tuple) else [node.value]
            for i, part in enumerate(parts):
                if _differs(part, clocks) or _names(part, elapsed):
                    found.add(i)
    return found or None


def helper_positions(module: ast.AST) -> dict[str, set[int]]:
    """Same-module helpers (by name) that return a difference of clock reads, and where."""
    out: dict[str, set[int]] = {}
    for node in ast.walk(module):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and not node.name.startswith(
            "test_"
        ):
            if (found := _timed_positions(node)) is not None:
                out[node.name] = found
    return out


def _call_name(value: ast.AST) -> str | None:
    if isinstance(value, ast.Await):
        value = value.value
    if isinstance(value, ast.Call) and isinstance(value.func, ast.Name):
        return value.func.id
    return None


def _collect(
    tree: ast.AST, clocks: set[str], elapsed: set[str], helpers: dict[str, set[int]]
) -> None:
    for _ in range(3):  # assignments may chain (start, then elapsed, then ms)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign | ast.AnnAssign | ast.NamedExpr):
                value = node.value
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names = {n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)}
                if value is None:
                    continue
                if (helper := _call_name(value)) in helpers:
                    # ``statements, seconds, body = await read(...)``: the names at the
                    # positions the helper returns a clock difference in.
                    for t in targets:
                        if isinstance(t, ast.Tuple):
                            for i, el in enumerate(t.elts):
                                if i in helpers[helper] and isinstance(el, ast.Name):
                                    elapsed.add(el.id)
                        elif 0 in helpers[helper]:
                            elapsed |= names
                elif _is_clock_call(value):
                    clocks |= names
                elif _differs(value, clocks) or _names(value, elapsed):
                    elapsed |= names


def asserts_wall_clock(tree: ast.AST, helpers: dict[str, set[int]] | None = None) -> bool:
    """Whether a function's tree asserts on a difference of wall-clock reads (``helpers``:
    same-module functions that return one, see ``helper_positions``)."""
    clocks: set[str] = set()  # names holding a clock read
    elapsed: set[str] = set()  # names holding a difference of clock reads
    _collect(tree, clocks, elapsed, helpers or {})
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
def _module_helpers(path: str) -> dict[str, set[int]]:
    try:
        with open(path) as f:
            return helper_positions(ast.parse(f.read()))
    except (OSError, SyntaxError):
        return {}


@cache
def _function_asserts_wall_clock(function) -> bool:
    try:
        source = textwrap.dedent(inspect.getsource(function))
        path = inspect.getsourcefile(function)
    except (OSError, TypeError):
        return False
    return asserts_wall_clock(ast.parse(source), _module_helpers(path) if path else None)


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
