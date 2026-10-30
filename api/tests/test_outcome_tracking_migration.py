"""Migration 0038_outcome_tracking (H3 Predicted versus actual): the outcome record's
item, track, prediction state, ship signal, due date, proposal and decision columns, the
``predicted`` status, and the three settings. Existing rows keep ``tracking`` and get
``assess_due_on`` from their prediction's ``by``; the downgrade deletes ``predicted`` rows
and drops the columns and settings.

Card: protects=old rows survive and surface once; the downgrade leaves no column, value
or setting behind; fails_when=the upgrade loses a row or misses the due date, or the
downgrade keeps a predicted row; no_claim=the application's use (tests/test_outcome_*.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

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

REVISION = "0038_outcome_tracking"
PREVIOUS = "0037_rituals"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_outcome_tracking")
    .render_as_string(hide_password=False)
)
COLUMNS = {
    "roadmap_item_id", "track_id", "needs_prediction", "confidence_at_prediction",
    "shipped_at", "ship_signal", "assess_due_on", "proposed_assessment", "decision_id",
}  # fmt: skip


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


def _columns() -> set[str]:
    rows = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'outcome_records'"
    )
    return {r[0] for r in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    # 0039_company_timezone chains on it; one head.
    assert script.get_heads() == ["0094_generation_checks"]
    assert script.get_revision("0039_company_timezone").down_revision == REVISION


def _record(t: uuid.UUID, goal: uuid.UUID, prediction: dict) -> uuid.UUID:
    rid = uuid.uuid4()
    _run(
        "INSERT INTO outcome_records (id, tenant_id, title, goal_id, prediction, status) "
        "VALUES (:r, :t, 'Saved cards', :g, CAST(:p AS jsonb), 'tracking')",
        r=rid, t=t, g=goal, p=json.dumps(prediction),
    )  # fmt: skip
    return rid


def test_upgrade_keeps_old_rows_and_sets_their_due_date(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    t, goal = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, status, origin) "
        "VALUES (:g, :t, 'goal', 'activation', 'Raise activation', 'confirmed', 'user')",
        g=goal, t=t,
    )  # fmt: skip
    dated = _record(t, goal, {"metric": "m", "predicted": "42%", "by": "2026-12-31"})
    undated = _record(t, goal, {"metric": "m", "predicted": "42%"})
    command.upgrade(_cfg(), REVISION)
    assert COLUMNS <= _columns()
    rows = dict(_run("SELECT id, assess_due_on::text FROM outcome_records"))
    assert rows == {dated: "2026-12-31", undated: None}
    statuses = {r[0] for r in _run("SELECT status FROM outcome_records")}
    assert statuses == {"tracking"}
    check = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'ck_outcome_records_status'"
    )[0][0]
    assert "predicted" in check and "inconclusive" in check

    _run(
        "INSERT INTO outcome_records (id, tenant_id, title, goal_id, prediction, status) "
        "VALUES (:r, :t, 'New', :g, '{}'::jsonb, 'predicted')",
        r=uuid.uuid4(), t=t, g=goal,
    )  # fmt: skip
    _run(
        "INSERT INTO tenant_settings (id, tenant_id, key, value) "
        "VALUES (gen_random_uuid(), :t, 'outcome_measure_days', '45'::jsonb)",
        t=t,
    )
    command.downgrade(_cfg(), PREVIOUS)
    assert not COLUMNS & _columns()
    assert {r[0] for r in _run("SELECT id FROM outcome_records")} == {dated, undated}
    assert _run("SELECT key FROM tenant_settings WHERE key = 'outcome_measure_days'") == []
