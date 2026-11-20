"""The API's tests read only their own tree (#1570).

A value that crosses trees is published by its owner as JSON under ``docs/contracts/``
and read in that form (``contract(name)``); opening any other file of the checkout outside
``api/`` while a test runs raises ``ForeignRead``. The guard is an audit hook on ``open``
(Python's own and ``io.open_code``), armed from each test's setup to its teardown.

A test whose code under test lives in another tree names the files it may open:
``@pytest.mark.foreign_read("path/from/the/repo/root", reason="...")``.

The guard is armed only in a checkout (the API's parent holds ``web/``); in the API image
there is no other tree to read.
"""

import json
import os
import sys
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[1]
ROOT = API.parent
CONTRACTS = ROOT / "docs" / "contracts"
# Where the dev environment keeps its interpreter and packages, and git's own files.
OWN = (API, CONTRACTS, ROOT / ".venv", ROOT / ".git")


class ForeignRead(PermissionError):
    """A test opened a file of another tree instead of its published contract."""


_state: dict = {"armed": False, "allowed": ()}


def foreign(path: str | Path) -> Path | None:
    """``path`` resolved, when it is a file of the checkout outside the API's own tree."""
    try:
        resolved = Path(path).resolve()
    except (OSError, ValueError):
        return None
    if not resolved.is_relative_to(ROOT):
        return None
    if any(resolved.is_relative_to(own) for own in OWN):
        return None
    return resolved


def _hook(event: str, args: tuple) -> None:
    if event != "open" or not _state["armed"]:
        return
    path = args[0]
    if not isinstance(path, (str, os.PathLike)):
        return  # a file descriptor, or a bytes path no repo file uses
    found = foreign(path)
    if found is None or found in _state["allowed"]:
        return
    _state["armed"] = False  # building the error must not trip the hook again
    try:
        rel = found.relative_to(ROOT)
        raise ForeignRead(
            f"{rel} is outside api/: read its published copy in docs/contracts "
            "(tests._own_tree_only.contract), or mark the test foreign_read"
        )
    finally:
        _state["armed"] = True


def contract(name: str):
    """docs/contracts/<name>.json, a value another tree publishes for the API's tests."""
    if not CONTRACTS.is_dir():
        pytest.skip("docs/contracts is not available (the API image)")
    return json.loads((CONTRACTS / f"{name}.json").read_text(encoding="utf-8"))


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "foreign_read(*paths, reason): files outside api/ (from the repo root) the test "
        "may open, its code under test living there",
    )
    if (ROOT / "web").is_dir() and not getattr(sys, "_oracle_own_tree_hook", False):
        sys.addaudithook(_hook)  # an audit hook cannot be removed: add it once
        sys._oracle_own_tree_hook = True  # type: ignore[attr-defined]


@pytest.hookimpl(wrapper=True)
def pytest_runtest_protocol(item: pytest.Item, nextitem):
    marks = list(item.iter_markers("foreign_read"))
    _state["allowed"] = tuple((ROOT / p).resolve() for m in marks for p in m.args)
    _state["armed"] = True
    try:
        return (yield)
    finally:
        _state["armed"] = False
        _state["allowed"] = ()
