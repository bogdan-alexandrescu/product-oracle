"""Migration 0039_company_timezone: an alignment report's own time zone becomes the
Company time zone (unless one is already set) and leaves the report's setting; the
downgrade gives the report the company's zone back. Sync on purpose (Alembic runs its
own event loop); its own scratch database. Made-up company.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import asyncio
import json
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0039_company_timezone"
PREVIOUS = "0038_outcome_tracking"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_company_tz")
    .render_as_string(hide_password=False)
)
REPORT = {"enabled": True, "weekday": "fri", "time": "16:30", "slack_channel": None}


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _run(sql: str, **params):
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                result = await conn.execute(text(sql), params)
                return result.all() if result.returns_rows else None
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _settings(tenant: uuid.UUID) -> dict:
    rows = _run("SELECT key, value FROM tenant_settings WHERE tenant_id = :t", t=tenant)
    return {k: v for k, v in rows}


def _set(tenant: uuid.UUID, key: str, value) -> None:
    _run(
        "INSERT INTO tenant_settings (id, tenant_id, key, value) "
        "VALUES (gen_random_uuid(), :t, :k, CAST(:v AS jsonb))",
        t=tenant, k=key, v=json.dumps(value),
    )  # fmt: skip


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0090_simple_goal_suggestion_people"]


def test_the_report_zone_becomes_the_company_time_zone(scratch_db):
    """protects=a report's stored zone moves into company_timezone and out of the
    report's value; a company that already set its zone keeps it; one with no report
    row gets none; the downgrade puts the company's zone back on the report;
    fails_when=a zone is lost, overwrites a set company zone, or stays on the report;
    no_claim=the API's reading of it (test_company_timezone)."""
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    moved, kept, bare = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    for t in (moved, kept, bare):
        _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=t)
    _set(moved, "alignment_report", {**REPORT, "timezone": "Europe/Berlin"})
    _set(kept, "alignment_report", {**REPORT, "timezone": "Europe/Berlin"})
    _set(kept, "company_timezone", "Asia/Tokyo")
    command.upgrade(cfg, REVISION)
    assert _settings(moved) == {"alignment_report": REPORT, "company_timezone": "Europe/Berlin"}
    assert _settings(kept) == {"alignment_report": REPORT, "company_timezone": "Asia/Tokyo"}
    assert _settings(bare) == {}
    command.downgrade(cfg, PREVIOUS)
    assert _settings(moved)["alignment_report"] == {**REPORT, "timezone": "Europe/Berlin"}
    assert _settings(kept)["alignment_report"] == {**REPORT, "timezone": "Asia/Tokyo"}
    assert _settings(bare) == {}


def _ritual(tenant: uuid.UUID, zone: str, status: str = "active") -> uuid.UUID:
    rid = uuid.uuid4()
    schedule = {"freq": "weekly", "interval": 1, "weekday": 2, "week_of_month": 1, "month": 1,
                "time": "11:00", "timezone": zone}  # fmt: skip
    _run(
        "INSERT INTO rituals (id, tenant_id, kind, title, schedule, duration_min, prep_hours, "
        "owner_id, status, next_due_at) VALUES (:id, :t, 'custom', 'Pricing sync', "
        "CAST(:s AS jsonb), 30, 12, :o, :st, "
        "CASE WHEN :st = 'active' THEN now() + interval '1 day' END)",
        id=rid, t=tenant, s=json.dumps(schedule), o=uuid.uuid4(), st=status,
    )  # fmt: skip
    return rid


def _ritual_row(rid: uuid.UUID):
    ((schedule, next_due_at),) = _run(
        "SELECT schedule, next_due_at FROM rituals WHERE id = :id", id=rid
    )
    return schedule, next_due_at


def test_a_ritual_zone_of_its_own_moves_to_the_company_time_zone(scratch_db):
    """protects=owner decision 2026-10-22, one zone: a ritual stored in a zone of its own
    moves to the Company time zone (America/Los_Angeles when none is set), with its next
    date recomputed there; a paused one keeps no next date; fails_when=a ritual keeps
    Berlin or UTC, or its next date stays in the old zone; no_claim=occurrences already
    prepared (they keep their dates)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tokyo, unset = uuid.uuid4(), uuid.uuid4()
    for t in (tokyo, unset):
        _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=t)
    _set(tokyo, "company_timezone", "Asia/Tokyo")
    berlin = _ritual(tokyo, "Europe/Berlin")
    utc = _ritual(unset, "UTC")
    paused = _ritual(unset, "Europe/Berlin", status="paused")
    command.upgrade(cfg, REVISION)
    for rid, zone in ((berlin, "Asia/Tokyo"), (utc, "America/Los_Angeles")):
        schedule, next_due_at = _ritual_row(rid)
        assert schedule["timezone"] == zone
        local = next_due_at.astimezone(ZoneInfo(zone))
        assert (local.weekday(), local.strftime("%H:%M")) == (2, "11:00")
        assert next_due_at > datetime.now(ZoneInfo("UTC"))
    schedule, next_due_at = _ritual_row(paused)
    assert schedule["timezone"] == "America/Los_Angeles" and next_due_at is None
