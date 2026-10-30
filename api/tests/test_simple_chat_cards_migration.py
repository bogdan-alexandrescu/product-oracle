"""Migration 0085_simple_chat_cards (Simple S9, #723).

Card: protects=simple_chat_cards comes and goes with the revision, chained on
0084_simple_visuals as the single head; fails_when=the table is missing or the
downgrade leaves it; no_claim=the routes' use (tests/test_simple_chat_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0085_simple_chat_cards"
PREVIOUS = "0084_simple_visuals"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_simple_chat_cards")
    .render_as_string(hide_password=False)
)
TABLES = {"simple_chat_cards"}


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _tables() -> set[str]:
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                return (
                    await conn.execute(
                        text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                    )
                ).all()
        finally:
            await engine.dispose()

    return {r[0] for r in asyncio.run(go())} & TABLES


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0092_bet_flow_line_key"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _tables() == TABLES
    command.downgrade(cfg, PREVIOUS)
    assert _tables() == set()
    command.upgrade(cfg, REVISION)
    assert _tables() == TABLES
