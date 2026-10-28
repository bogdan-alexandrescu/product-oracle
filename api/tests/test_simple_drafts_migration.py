"""Migration 0079_simple_drafts (Simple S3b, #723).

Card: protects=simple_drafts (one working draft per document), simple_session_drafts,
roadmap_item_tasks, simple_action_items and simple_changes.draft_ids ('{}') come and go
with the revision, chained on 0078_simple_changes as the single head; fails_when=a table,
the column or the one-working-draft index is missing, or the downgrade leaves any of them;
no_claim=the routes' use (tests/test_simple_drafts_api.py, tests/test_simple_targets_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0079_simple_drafts"
PREVIOUS = "0078_simple_changes"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_simple_drafts")
    .render_as_string(hide_password=False)
)
TABLES = {"simple_drafts", "simple_session_drafts", "roadmap_item_tasks", "simple_action_items"}


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _run(sql: str):
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                return (await conn.execute(text(sql))).all()
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _state() -> tuple[set[str], bool, bool]:
    tables = {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}
    column = bool(
        _run(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'simple_changes' AND column_name = 'draft_ids'"
        )
    )
    index = bool(_run("SELECT 1 FROM pg_indexes WHERE indexname = 'uq_simple_drafts_working'"))
    return tables & TABLES, column, index


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
    assert _state() == (TABLES, True, True)
    command.downgrade(cfg, PREVIOUS)
    assert _state() == (set(), False, False)
    command.upgrade(cfg, REVISION)
    assert _state() == (TABLES, True, True)
