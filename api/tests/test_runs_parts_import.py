"""#1576: every module split out of runs/service.py imports first, in a fresh interpreter."""

import ast
import subprocess
import sys
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[1]
PARTS = sorted(
    path.stem
    for path in (API / "oracle" / "runs").glob("*.py")
    if "from oracle.runs import" in path.read_text() and "service" in path.read_text()
)


def test_the_parts_are_found():
    """The expected parts split out of the runs service module are all found."""
    assert {"advance", "inbox", "reads", "tick", "submission"} <= set(PARTS)


@pytest.mark.parametrize("part", PARTS)
def test_a_part_imports_before_service(part):
    """Each split-out runs module imports cleanly before the service module does."""
    probe = (
        f"import oracle.runs.{part}\n"
        "from oracle.runs import service\n"
        "assert service.tick and service._advance and service._Refs\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", probe], cwd=API, capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stderr[-2000:]


def _imports(node: ast.AST) -> list[tuple[str | None, str]]:
    return [
        (stmt.module, alias.name)
        for stmt in ast.walk(node)
        if isinstance(stmt, ast.ImportFrom)
        for alias in stmt.names
    ]


def test_type_checkers_read_the_names_the_parts_give():
    """The service module's type-checking imports match what the split parts give."""
    tree = ast.parse((API / "oracle" / "runs" / "service.py").read_text())
    typed = [
        n for n in tree.body if isinstance(n, ast.If) and ast.unparse(n.test) == "TYPE_CHECKING"
    ][-1]
    load = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_load_parts")
    assert _imports(load) and _imports(typed) == _imports(load)
