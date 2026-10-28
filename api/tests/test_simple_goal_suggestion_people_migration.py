"""Migration 0090_goal_suggestion_people (0090_simple_goal_suggestion_people.py).

Card: protects=simple_goal_suggestions.proposed_by and the widened origin check ("person")
come and go with the revision, chained on 0089_ritual_attendees_edited_at as the single
head; fails_when=the column or the origin is missing, or the downgrade leaves them;
no_claim=their use (tests/test_simple_additions_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0090_goal_suggestion_people"
PREVIOUS = "0089_ritual_attendees_edited_at"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_goal_suggestion_people")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _state() -> tuple[bool, bool]:
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                col = await conn.scalar(
                    text(
                        "SELECT count(*) FROM information_schema.columns WHERE table_name ="
                        " 'simple_goal_suggestions' AND column_name = 'proposed_by'"
                    )
                )
                check = await conn.scalar(
                    text(
                        "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                        " WHERE conname = 'ck_simple_goal_suggestions_origin'"
                    )
                )
                return col == 1, "person" in (check or "")
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0091_prd_questions"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _state() == (True, True)
    command.downgrade(cfg, PREVIOUS)
    assert _state() == (False, False)
    command.upgrade(cfg, REVISION)
    assert _state() == (True, True)
