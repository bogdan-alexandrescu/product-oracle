"""Migration 0084_simple_visuals (Simple S10, #723).

Card: protects=simple_visuals, its versions and comments, llm_jobs.visual_id (a job's
subject) and the simple_visual kind come and go with the revision, chained on
0083_simple_additions as the single head; fails_when=a table, the column or the kind is
missing, or the downgrade leaves any; no_claim=the routes' use
(tests/test_simple_visuals_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0084_simple_visuals"
PREVIOUS = "0083_simple_additions"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_simple_visuals")
    .render_as_string(hide_password=False)
)
TABLES = {"simple_visuals", "simple_visual_versions", "simple_visual_comments"}


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


def _state() -> tuple[set[str], bool]:
    tables = {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}
    kind = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_llm_jobs_kind'"
    )
    col = _run(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'llm_jobs' "
        "AND column_name = 'visual_id'"
    )
    return tables & TABLES, "simple_visual" in kind[0][0] and bool(col)


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0090_interview_new_link"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _state() == (TABLES, True)
    command.downgrade(cfg, PREVIOUS)
    assert _state() == (set(), False)
    command.upgrade(cfg, REVISION)
    assert _state() == (TABLES, True)
