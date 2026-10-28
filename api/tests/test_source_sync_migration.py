"""Migration 0062_source_sync (S4 Freshness, A2 §8): the background sync's backoff on
``sources``: ``sync_failures`` (0 by default) and ``next_sync_at`` (nullable).

Card: protects=both columns come and go with the revision, chained on 0056_slack_pings
as the single head, existing sources start with no failures and nothing holding them
back; fails_when=the upgrade misses a column or the downgrade leaves one;
no_claim=the ticker's use of them (tests/test_source_background_sync.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0062_source_sync"
PREVIOUS = "0061_discussion_decision_change"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_source_sync")
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


def _columns() -> dict[str, str]:
    rows = _run(
        "SELECT column_name, is_nullable FROM information_schema.columns "
        "WHERE table_name = 'sources'"
    )
    return {name: nullable for name, nullable in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0090_goal_suggestion_people"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), REVISION)
    columns = _columns()
    assert columns["next_sync_at"] == "YES" and columns["sync_failures"] == "NO"

    command.downgrade(_cfg(), PREVIOUS)
    assert "next_sync_at" not in _columns() and "sync_failures" not in _columns()

    command.upgrade(_cfg(), REVISION)
    assert _columns()["sync_failures"] == "NO"
