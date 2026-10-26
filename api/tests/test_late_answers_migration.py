"""Migration 0063_late_answers (C5 late answers): ``feedback_items.intake_question_id`` and
``feedback_items.intake_answer_id``.

Card: protects=both link columns come and go with the revision, chained on
0056_slack_pings as the single head, nullable so every other item has none, the answer
unique (one item per answer); fails_when=the upgrade misses a column or the unique
constraint, or the downgrade leaves them; no_claim=the items it links
(tests/test_late_answers_feedback.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0063_late_answers"
PREVIOUS = "0062_source_sync"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_late_answers")
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
        "WHERE table_name = 'feedback_items'"
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
    assert script.get_heads() == ["0072_live_tokens"]


def _unique() -> list[str]:
    rows = _run(
        "SELECT conname FROM pg_constraint WHERE conrelid = 'feedback_items'::regclass "
        "AND contype = 'u'"
    )
    return [name for (name,) in rows]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), REVISION)
    columns = _columns()
    assert (columns["intake_question_id"], columns["intake_answer_id"]) == ("YES", "YES")
    assert "uq_feedback_items_intake_answer_id" in _unique()

    command.downgrade(_cfg(), PREVIOUS)
    assert not {"intake_question_id", "intake_answer_id"} & set(_columns())
    assert "uq_feedback_items_intake_answer_id" not in _unique()

    command.upgrade(_cfg(), REVISION)
    assert "intake_answer_id" in _columns()
