"""#1575: a migration replays as it was written. It imports no live app code (only the
oracle.migration_checks helpers), so changing the app never changes history; the logic
0039_company_timezone and 0093_meeting_comments_as_notes needed is frozen in each file.

Card: protects=no migration imports oracle.* outside oracle.migration_checks; 0039's frozen
next date matches a hard-coded table of the dates it gave when written (#1720: never the
live app's, so a change to the app never asks for an edit to history); fails_when=a
migration reaches into live app code or 0039's dates change; no_claim=the migrations'
data effects (test_company_timezone_migration, test_simple_meetings_api)."""

import ast
import importlib.util
from datetime import UTC, datetime

import pytest

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
    """No migration file imports live application code, so old migrations replay unchanged."""
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


# The next occurrence (UTC) of each rule after each moment, as 0039 computed it when it
# was written (#1720: frozen values, so a change to the live scheduler never reaches here).
EXPECTED = [
    ["2026-03-09 16:00", "2026-11-02 17:00", "2027-01-04 17:00", "2027-02-01 17:00"],
    ["2026-03-08 14:30", "2026-11-01 14:30", "2027-01-03 14:30", "2027-02-07 14:30"],
    ["2026-03-11 10:15", "2026-11-18 10:15", "2027-01-20 10:15", "2027-02-10 10:15"],
    ["2026-03-27 08:00", "2026-11-27 08:00", "2027-01-29 08:00", "2027-02-26 08:00"],
    ["2026-03-10 07:00", "2026-11-10 08:00", "2027-01-12 08:00", "2027-02-09 08:00"],
    ["2026-05-07 09:00", "2026-11-05 09:00", "2027-02-04 09:00", "2027-02-04 09:00"],
    ["2026-11-24 01:45", "2026-11-24 01:45", "2027-11-23 01:45", "2027-11-23 01:45"],
]


@pytest.mark.parametrize(("rule", "expected"), list(zip(RULES, EXPECTED, strict=True)))
def test_0039_frozen_next_date_matches_its_written_values(rule, expected):
    """A frozen migration's next-occurrence rule still gives the dates it gave when written."""
    frozen = _migration("0039_company_timezone")
    got = [frozen._next_occurrence(rule, after) for after in MOMENTS]
    assert [d.astimezone(UTC).strftime("%Y-%m-%d %H:%M") for d in got] == expected
