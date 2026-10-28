"""Migration 0089_ritual_attendees_edited_at (the walk-fixes review 2).

Card: protects=rituals.attendees_edited_at comes and goes with the revision, chained on
0086_simple_meetings as the single head; fails_when=the column is missing or the
downgrade leaves it; no_claim=its use (tests/test_simple_walk_fixes_review2_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0089_ritual_attendees_edited_at"
PREVIOUS = "0088_simple_chat_actions"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_ritual_attendees_edited")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _has_column() -> bool:
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                return await conn.scalar(
                    text(
                        "SELECT count(*) FROM information_schema.columns WHERE"
                        " table_name = 'rituals' AND column_name = 'attendees_edited_at'"
                    )
                )
        finally:
            await engine.dispose()

    return asyncio.run(go()) == 1


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0090_simple_goal_suggestion_people"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _has_column()
    command.downgrade(cfg, PREVIOUS)
    assert not _has_column()
    command.upgrade(cfg, REVISION)
    assert _has_column()
