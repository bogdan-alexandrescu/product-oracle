"""#1722: a broad catch in the app says why. Ruff accepts a bare ``# noqa: BLE001``, and a
broad ``except`` that neither logs nor re-raises passes once marked, so this scan holds
the line ruff does not: every ``noqa: BLE001`` states its reason, and every broad catch
logs, re-raises or states its reason on the ``except`` line.

Card: protects=no silent broad catch in api/oracle; fails_when=a bare noqa BLE001, or an
``except Exception`` / ``except BaseException`` / bare ``except`` with no log call, no
raise and no stated reason; no_claim=whether a stated reason is a good one (review)."""

import ast
import re

from tests.conftest import API_DIR

ORACLE = API_DIR / "oracle"
BROAD = {"Exception", "BaseException"}
LOG_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "log"}
# "noqa: BLE001" and any other codes beside it, then the reason (at least three words).
NOQA = re.compile(r"noqa:\s*(?:[A-Z]+[0-9]+[\s,]*)*BLE001(?:[\s,]+[A-Z]+[0-9]+)*(?P<rest>.*)")
REASON_WORDS = 3


def _reason(line: str) -> str | None:
    """The reason a line's ``noqa: BLE001`` states, "" when it states none, None without one."""
    m = NOQA.search(line)
    if not m:
        return None
    return m.group("rest").strip(" -:;,.–—")


def _is_broad(node: ast.expr | None) -> bool:
    if node is None:
        return True
    if isinstance(node, ast.Name):
        return node.id in BROAD
    if isinstance(node, ast.Attribute):
        return node.attr in BROAD
    if isinstance(node, ast.Tuple):
        return any(_is_broad(e) for e in node.elts)
    return False


def _own_nodes(body: list[ast.stmt]):
    """The handler's own nodes, not those of a function or class defined inside it."""
    stack: list[ast.AST] = list(body)
    while stack:
        node = stack.pop()
        yield node
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda | ast.ClassDef):
            stack.extend(ast.iter_child_nodes(node))


def _is_log_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
        return False
    if node.func.attr not in LOG_METHODS:
        return False
    receiver = ast.unparse(node.func.value)
    last = receiver.rsplit(".", 1)[-1]
    return last in {"log", "logger", "_log", "_logger", "logging"} or receiver.startswith(
        "logging.getLogger("
    )


def problems(source: str, name: str) -> list[str]:
    """Every bare noqa BLE001 and every silent broad catch in one module's source."""
    lines = source.splitlines()
    found = [
        f"{name}:{n}: noqa BLE001 with no reason"
        for n, line in enumerate(lines, 1)
        if (r := _reason(line)) is not None and len(r.split()) < REASON_WORDS
    ]
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.ExceptHandler) or not _is_broad(node.type):
            continue
        own = list(_own_nodes(node.body))
        if any(isinstance(n, ast.Raise) for n in own) or any(_is_log_call(n) for n in own):
            continue
        if _reason(lines[node.lineno - 1]):
            continue
        found.append(f"{name}:{node.lineno}: broad catch that neither logs nor re-raises")
    return found


def test_every_broad_catch_in_the_app_logs_re_raises_or_says_why():
    """No broad catch in api/oracle swallows an error silently or carries a bare noqa."""
    found = []
    for path in sorted(ORACLE.rglob("*.py")):
        found += problems(path.read_text(), str(path.relative_to(API_DIR)))
    assert found == []


PLANTED = """
import logging

log = logging.getLogger(__name__)


def bare_noqa():
    try:
        pass
    except Exception:  # noqa: BLE001
        pass


def silent():
    try:
        pass
    except:
        pass


def logs():
    try:
        pass
    except Exception:
        log.exception("could not run")


def re_raises():
    try:
        pass
    except BaseException:
        raise


def says_why():
    try:
        pass
    except Exception:  # noqa: BLE001 - any failure here means no preview
        return None


def logs_only_in_an_inner_function():
    try:
        pass
    except (ValueError, Exception):
        def later():
            log.warning("too late")
        return later
"""


def test_the_scan_sees_a_planted_bare_noqa_and_silent_catches():
    """A bare noqa, a bare except and a catch that logs only in a nested def are all seen."""
    assert problems(PLANTED, "planted.py") == [
        "planted.py:10: noqa BLE001 with no reason",
        "planted.py:10: broad catch that neither logs nor re-raises",
        "planted.py:17: broad catch that neither logs nor re-raises",
        "planted.py:45: broad catch that neither logs nor re-raises",
    ]
