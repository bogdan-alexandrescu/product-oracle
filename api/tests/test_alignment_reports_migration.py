"""Migration 0020_alignment_reports (F6 Weekly alignment report): three new tables,
additive and reversible, and one weekly report per company and week at the database.

Sync tests on purpose: Alembic's env.py runs its own event loop. Own scratch database.

protects=the F6 schema and the single migration head; fails_when=the migration does not
chain on main's head, a second weekly report for a week is accepted, or the downgrade
leaves a table behind; no_claim=the models matching the migration (test_migrations).
"""

import asyncio
import uuid
from datetime import date

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_reports")
    .render_as_string(hide_password=False)
)
REVISION = "0020_alignment_reports"
BEFORE = "0015_specs"
TABLES = {"alignment_reports", "alignment_report_reads", "company_integrations"}


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


def _tables() -> set[str]:
    return {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_0020_chains_on_mains_head_and_is_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == BEFORE
    assert script.get_heads() == ["0023_source_partial_sync"]


def _report(tenant: uuid.UUID, kind: str, week: date = date(2026, 10, 19)) -> None:
    _run(
        "INSERT INTO alignment_reports (id, tenant_id, kind, week_start, period_start, "
        "period_end, timezone, content, markdown, slack_status) VALUES (:id, :t, :k, :w, "
        "'2026-10-19T07:00:00Z', '2026-10-26T07:00:00Z', 'America/Los_Angeles', '{}', '', "
        "'not_configured')",
        id=uuid.uuid4(), t=tenant, k=kind, w=week,
    )  # fmt: skip


def test_upgrade_adds_the_tables_and_downgrade_drops_them(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, BEFORE)
    assert not TABLES & _tables()
    command.upgrade(cfg, REVISION)
    assert TABLES <= _tables()

    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _report(tenant, "weekly")
    # On-demand reports for the same week are fine; a second weekly one is not.
    _report(tenant, "on_demand")
    _report(tenant, "on_demand")
    with pytest.raises(IntegrityError):
        _report(tenant, "weekly")
    _report(tenant, "weekly", week=date(2026, 10, 26))
    with pytest.raises(IntegrityError):
        _report(tenant, "monthly")
    # One Oracle Slack install per company.
    insert = (
        "INSERT INTO company_integrations (id, tenant_id, provider, purpose, account_id, "
        "ciphertext, key_version, installed_by) VALUES (:id, :t, 'slack', 'notifications', "
        "'T1', 'x', 1, :u)"
    )
    _run(insert, id=uuid.uuid4(), t=tenant, u=uuid.uuid4())
    with pytest.raises(IntegrityError):
        _run(insert, id=uuid.uuid4(), t=tenant, u=uuid.uuid4())

    # Dropping a stored install would leave the bot token valid at Slack: refused.
    with pytest.raises(RuntimeError, match="disconnect Slack"):
        command.downgrade(cfg, BEFORE)
    assert TABLES <= _tables()
    _run("DELETE FROM company_integrations")
    command.downgrade(cfg, BEFORE)
    assert not TABLES & _tables()
    command.upgrade(cfg, REVISION)
    assert TABLES <= _tables()
