"""Migration 0020_autonomy (H11): the table of what Oracle did on its own
(``oracle_actions``). Upgrade creates it with its recent index; the downgrade drops it.

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0020_autonomy"
PREVIOUS = "0020_launches"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_autonomy")
    .render_as_string(hide_password=False)
)


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


def _exists() -> bool:
    return _run("SELECT to_regclass('public.oracle_actions') IS NOT NULL")[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_mains_head_with_one_head():
    """protects=the chain stays linear with 0020_autonomy last;
    fails_when=the revision forks the chain or names another parent;
    no_claim=that the integrator's merge order keeps it last."""
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0058_feedback_withheld"]


def test_upgrade_creates_oracle_actions_and_downgrade_drops_it(scratch_db):
    """protects=0020 creates oracle_actions (defaults, index, tenant cascade) and its
    downgrade drops it; fails_when=the table, a default or the index is missing, or the
    downgrade leaves it; no_claim=behaviour of the rows (tests/test_autonomy.py)."""
    command.upgrade(_cfg(), PREVIOUS)
    assert not _exists()
    command.upgrade(_cfg(), REVISION)
    assert _exists()
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    _run(
        "INSERT INTO oracle_actions (id, tenant_id, responsibility, summary) "
        "VALUES (:i, :t, 'priorities', 'Moved one item')",
        i=uuid.uuid4(),
        t=tenant,
    )
    [row] = _run("SELECT subject, notify_ids, opened_by, undo, undone_by FROM oracle_actions")
    assert row == ({}, [], [], None, None)
    indexes = {
        r[0] for r in _run("SELECT indexname FROM pg_indexes WHERE tablename = 'oracle_actions'")
    }
    assert "ix_oracle_actions_recent" in indexes
    _run("DELETE FROM tenants WHERE id = :t", t=tenant)
    assert _run("SELECT count(*) FROM oracle_actions")[0][0] == 0

    command.downgrade(_cfg(), PREVIOUS)
    assert not _exists()
    command.upgrade(_cfg(), "head")
    assert _exists()
