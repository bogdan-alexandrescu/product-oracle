"""Migration 0087_simple_chat_reads (Simple chat-reader, #723).

Card: protects=simple_chat_reads comes and goes with the revision, chained on
0086_simple_meetings as the single head, and a chat_reader job (no document) is allowed
only while it is applied; fails_when=the table or the job kind is missing, or the
downgrade leaves them; no_claim=the routes' use (tests/test_simple_chat_reader.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0087_simple_chat_reads"
PREVIOUS = "0086_simple_meetings"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_simple_chat_reads")
    .render_as_string(hide_password=False)
)
TABLES = {"simple_chat_reads"}


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
    assert script.get_heads() == ["0095_chat_read_answered_at"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _tables() == TABLES
    command.downgrade(cfg, PREVIOUS)
    assert _tables() == set()
    command.upgrade(cfg, REVISION)
    assert _tables() == TABLES


def _checks() -> str:
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                return (
                    await conn.execute(
                        text(
                            "SELECT string_agg(pg_get_constraintdef(oid), ' ') FROM pg_constraint"
                            " WHERE conname IN ('ck_llm_jobs_kind', 'ck_llm_jobs_subject')"
                        )
                    )
                ).scalar()
        finally:
            await engine.dispose()

    return asyncio.run(go()) or ""


def test_chat_reader_job_kind_comes_and_goes(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _checks().count("chat_reader") == 2
    command.downgrade(cfg, PREVIOUS)
    assert "chat_reader" not in _checks()
