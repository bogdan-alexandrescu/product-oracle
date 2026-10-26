"""Migration 0060_discussion_research (G2 §4 Research this): ``discussion_messages.run_id``
and the ``discussion_research`` flow on ``runs.flow``.

Card: protects=the column and the flow value come and go with the revision, chained on
0054_reply_opened as the single head, the column nullable; fails_when=the upgrade misses
the column or the flow, or the downgrade leaves either; no_claim=the routes
(tests/test_discussion_research.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0060_discussion_research"
PREVIOUS = "0059_metric_errors_fixed"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_discussion_research")
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


def _column() -> list:
    return _run(
        "SELECT is_nullable FROM information_schema.columns "
        "WHERE table_name = 'discussion_messages' AND column_name = 'run_id'"
    )


def _flow_check() -> str:
    [(definition,)] = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_runs_flow'"
    )
    return definition


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0073_share_links"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), REVISION)
    assert _column() == [("YES",)]
    assert "discussion_research" in _flow_check()
    assert "competitive_digest" in _flow_check()

    command.downgrade(_cfg(), PREVIOUS)
    assert _column() == []
    assert "discussion_research" not in _flow_check()
    assert "competitive_digest" in _flow_check()
