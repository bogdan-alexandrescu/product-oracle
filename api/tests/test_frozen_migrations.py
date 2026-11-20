"""#1575: a migration replays as it was written. It imports no live app code (only the
oracle.migration_checks helpers), so changing the app never changes history; the logic
0039_company_timezone and 0093_meeting_comments_as_notes needed is frozen in each file.

Card: protects=no migration imports oracle.* outside oracle.migration_checks; 0039's frozen
next date matches the app's for every kind of rule today; fails_when=a migration reaches
into live app code; no_claim=the migrations' data effects (test_company_timezone_migration,
test_fix4_simple_decide_review_api)."""

import ast
import importlib.util
from datetime import UTC, datetime

import pytest

from oracle.rituals.schedule import next_occurrence
from tests.conftest import API_DIR

VERSIONS = API_DIR / "migrations" / "versions"
ALLOWED = {"oracle.migration_checks"}


def _oracle_imports(path) -> list[str]:
    found = []
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names = [node.module]
        else:
            continue
        found += [n for n in names if n.split(".")[0] == "oracle" and n not in ALLOWED]
    return found


def test_no_migration_imports_live_app_code():
    bad = {p.name: i for p in sorted(VERSIONS.glob("*.py")) if (i := _oracle_imports(p))}
    assert bad == {}


def _migration(revision: str):
    path = VERSIONS / f"{revision}.py"
    spec = importlib.util.spec_from_file_location(revision, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RULES = [
    {"freq": "weekly", "weekday": 0, "time": "09:00", "timezone": "America/Los_Angeles"},
    {"freq": "weekly", "weekday": 6, "time": "23:30", "timezone": "Asia/Tokyo"},
    {"freq": "every_n_weeks", "interval": 3, "weekday": 2, "time": "10:15", "timezone": "UTC"},
    {"freq": "monthly", "weekday": 4, "week_of_month": -1, "timezone": "Europe/Berlin"},
    {"freq": "monthly", "weekday": 1, "week_of_month": 2, "time": "00:00"},
    {"freq": "quarterly", "weekday": 3, "week_of_month": 1, "month": 2, "timezone": "UTC"},
    {"freq": "yearly", "weekday": 0, "week_of_month": 4, "month": 11, "time": "17:45"},
]
MOMENTS = [
    datetime(2026, 3, 8, 9, 59, tzinfo=UTC),  # a US daylight saving switch
    datetime(2026, 10, 31, 23, 59, tzinfo=UTC),
    datetime(2026, 12, 31, 12, 0, tzinfo=UTC),
    datetime(2027, 2, 1, 0, 0, tzinfo=UTC),
]


@pytest.mark.parametrize("rule", RULES)
def test_0039_frozen_next_date_matches_the_app_today(rule):
    frozen = _migration("0039_company_timezone")
    for after in MOMENTS:
        assert frozen._next_occurrence(rule, after) == next_occurrence(rule, after)
