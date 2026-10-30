"""Migration 0088_simple_chat_actions (Simple chat-actions, #723).

Card: protects=roadmap_items.owner_id / decider_id and simple_meetings.notes / agenda come
and go with the revision, chained on 0087_simple_chat_reads as the single head;
fails_when=a column is missing or the downgrade leaves it; no_claim=the routes' use
(tests/test_simple_chat_actions.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0088_simple_chat_actions"
PREVIOUS = "0087_simple_chat_reads"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_simple_chat_actions")
    .render_as_string(hide_password=False)
)
COLUMNS = {
    ("roadmap_items", "owner_id"),
    ("roadmap_items", "decider_id"),
    ("simple_meetings", "notes"),
    ("simple_meetings", "agenda"),
}


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _columns() -> set[tuple[str, str]]:
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                return (
                    await conn.execute(
                        text(
                            "SELECT table_name, column_name FROM information_schema.columns "
                            "WHERE table_schema = 'public'"
                        )
                    )
                ).all()
        finally:
            await engine.dispose()

    return {(r[0], r[1]) for r in asyncio.run(go())} & COLUMNS


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0093_meeting_comments_as_notes"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _columns() == COLUMNS
    command.downgrade(cfg, PREVIOUS)
    assert _columns() == set()
    command.upgrade(cfg, REVISION)
    assert _columns() == COLUMNS
