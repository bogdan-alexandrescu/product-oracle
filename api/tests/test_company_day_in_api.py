"""The API dates "today" by the company's day, never the server's.

The server runs in UTC, a day ahead of the company's (Pacific, by default) day from 5 PM
Pacific. Code that takes "today" from ``date.today()`` or ``datetime.now(UTC).date()``
reads the server's day, so a review, a due outcome or a year-less date can land a day
early. The API reads the company's day through :func:`oracle.company_time.today` /
:func:`oracle.company_time.company_today`, in the Company time zone.

Test card (every test below): protects=the API's day logic uses the Company time zone's
day; fails_when=a module under ``api/oracle`` calls ``date.today()``,
``datetime.today()``, a bare ``datetime.now()`` or ``.date()`` of any ``now(...)`` /
``utcnow(...)`` call (bare ``now()`` too) outside
the helper, or a converted caller reads the UTC day after 5 PM Pacific; no_claim=machine
timestamps (stored UTC), how days are worded (test_company_day_text).
"""

import ast
from datetime import UTC, date, datetime
from pathlib import Path
from types import SimpleNamespace

import oracle
from oracle import company_time
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant

ORACLE = Path(oracle.__file__).parent
# The helper reads the clock; everything else asks it for the company's day.
HELPERS = {"company_time.py"}
# Modules that must keep the server's day, with the reason. None today.
ALLOWED: dict[str, str] = {}
# 2026-10-24T02:00Z: Oct 24 in UTC, still Oct 23 in Pacific.
EVENING = datetime(2026, 10, 24, 2, 0, tzinfo=UTC)
PACIFIC_DAY = date(2026, 10, 23)


def _server_day_calls(tree: ast.AST) -> list[int]:
    """Lines reading the server's day: ``date.today()``, ``datetime.today()``, a bare
    ``datetime.now()``, or ``.date()`` of a ``now(...)`` call (UTC's day)."""
    lines = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        owner = node.func.value
        name = owner.id if isinstance(owner, ast.Name) else getattr(owner, "attr", None)
        bare_now = node.func.attr == "now" and not node.args and not node.keywords
        if name in ("date", "datetime") and (
            node.func.attr == "today" or (name == "datetime" and bare_now)
        ):
            lines.append(node.lineno)
        elif node.func.attr == "date" and not node.args and _reads_the_clock(owner):
            lines.append(node.lineno)
    return lines


def _reads_the_clock(node: ast.AST) -> bool:
    """A ``now(...)`` / ``utcnow(...)`` call, bare (a module's own ``now`` helper,
    ``_now``) or on an owner (``datetime.now``, ``service.now``)."""
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
    return isinstance(name, str) and name.lstrip("_") in ("now", "utcnow")


def test_no_api_code_dates_by_the_servers_day():
    found = []
    for path in sorted(ORACLE.rglob("*.py")):
        rel = path.relative_to(ORACLE).as_posix()
        if rel in HELPERS or rel in ALLOWED:
            continue
        found += [f"{rel}:{n}" for n in _server_day_calls(ast.parse(path.read_text()))]
    assert found == [], "read the company's day through oracle.company_time.today()"


def test_the_scan_finds_each_way_of_reading_the_servers_day():
    src = (
        "a = date.today()\n"
        "b = datetime.today()\n"
        "c = datetime.now()\n"
        "d = datetime.now(UTC).date()\n"
        "e = service.now().date()\n"
        "f = company_time.today(zone)\n"
        "g = datetime.now(UTC)\n"
        "h = created.date()\n"
        "i = now().date()\n"
        "j = _now().date()\n"
        "k = datetime.now().date()\n"
        "m = utcnow().date()\n"
        "n = datetime.utcnow().date()\n"
        "o = now().astimezone(zone).date()\n"
        "p = snow().date()\n"
    )
    assert sorted(_server_day_calls(ast.parse(src))) == [1, 2, 3, 4, 5, 9, 10, 11, 11, 12, 13]


def test_the_helper_is_the_company_day(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: EVENING)
    assert company_time.today() == PACIFIC_DAY
    assert company_time.today("Pacific/Auckland") == date(2026, 10, 24)
    assert company_time.day_start(PACIFIC_DAY, "America/Los_Angeles") == datetime(
        2026, 10, 23, 7, 0, tzinfo=UTC
    )


async def test_company_today_reads_the_company_time_zone(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: EVENING)
    tenant_id = await make_tenant("Day Co")
    async with tenant_session(tenant_id) as s:
        assert await company_time.company_today(s) == PACIFIC_DAY


async def test_the_roadmap_views_today_is_the_company_day(monkeypatch):
    from oracle.roadmap import views

    monkeypatch.setattr(company_time, "now", lambda: EVENING)
    tenant_id = await make_tenant("Roadmap Day Co")
    async with tenant_session(tenant_id) as s:
        assert await views.today(s) == PACIFIC_DAY


def test_a_roadmaps_year_less_dates_read_against_the_company_day(monkeypatch):
    """A version's day (year-less dates take its year) is its company day: one created on
    New Year's Day in UTC was still made on Dec 31 in Pacific."""
    from oracle.roadmap import doc_dates

    monkeypatch.setattr(company_time, "now", lambda: EVENING)
    zone = "America/Los_Angeles"
    made = SimpleNamespace(created_at=datetime(2026, 1, 1, 2, 0, tzinfo=UTC))
    assert doc_dates.version_day(made, zone) == date(2025, 12, 31)
    assert doc_dates.version_day(SimpleNamespace(), zone) == PACIFIC_DAY
    assert doc_dates.import_day(zone) == PACIFIC_DAY


def test_a_goals_fallback_day_is_the_company_day(monkeypatch):
    """Goal checks without a day of their own (``on``) read Pacific's day, not UTC's."""
    from oracle.baseline import goals

    monkeypatch.setattr(goals, "now", lambda: EVENING)
    assert goals.today() == PACIFIC_DAY
    # Measured on Oct 24 (UTC's day, Pacific's tomorrow): in the future.
    found = goals.field_problems({"current": 5, "current_as_of": "2026-10-24"})
    assert ("current_date_future", "attrs.current_as_of") in {
        (p["code"], p["where"]) for p in found
    }, found
