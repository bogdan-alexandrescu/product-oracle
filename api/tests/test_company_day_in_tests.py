"""#519 item 7: tests date by the company's day, never the machine's.

CI runs in UTC, a day ahead of the company's (Pacific) day from 5 PM Pacific, and a
developer's machine may sit in any zone. A test that builds "today" from ``date.today()``
reads the machine's day, so it can disagree with the day the API dates by. Tests read the
company's day through :func:`tests.day_helpers.company_today`.

Test card (every test below): protects=tests take "today" from the company's day;
fails_when=a test file calls ``date.today()`` / ``datetime.today()`` / a bare
``datetime.now()`` (the machine's day), or the helper returns the UTC day after 5 PM
Pacific; no_claim=which day each API dates by (the API's own tests).
"""

import ast
from datetime import UTC, date, datetime
from pathlib import Path

TESTS = Path(__file__).resolve().parent

# Test files that must keep the machine's day, with the reason. None today.
ALLOWED: dict[str, str] = {}


def _machine_day_calls(tree: ast.AST) -> list[int]:
    """Lines calling ``date.today()``, ``datetime.today()`` or ``datetime.now()`` with no
    zone: each reads the machine's local day."""
    lines = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        owner = node.func.value
        name = owner.id if isinstance(owner, ast.Name) else getattr(owner, "attr", None)
        if name not in ("date", "datetime"):
            continue
        bare_now = node.func.attr == "now" and not node.args and not node.keywords
        if node.func.attr == "today" or (name == "datetime" and bare_now):
            lines.append(node.lineno)
    return lines


def test_no_test_dates_by_the_machines_day():
    found = []
    for path in sorted(TESTS.rglob("*.py")):
        rel = path.relative_to(TESTS).as_posix()
        if rel in ALLOWED:
            continue
        found += [f"{rel}:{n}" for n in _machine_day_calls(ast.parse(path.read_text()))]
    assert found == [], "use tests.day_helpers.company_today(), not the machine's day"


def test_the_company_day_is_pacifics_after_5_pm_pacific():
    from tests.day_helpers import company_today

    # 02:00 UTC on Oct 24 is 7 PM PDT on Oct 23: the company's day is still the 23rd.
    at = datetime(2026, 10, 24, 2, tzinfo=UTC)
    assert company_today(at=at) == date(2026, 10, 23)
    assert company_today("Pacific/Auckland", at=at) == date(2026, 10, 24)
    assert company_today(at=datetime(2026, 10, 23, 23, tzinfo=UTC)) == date(2026, 10, 23)
