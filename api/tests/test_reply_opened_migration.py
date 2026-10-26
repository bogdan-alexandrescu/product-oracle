"""Migration 0054_reply_opened (H10 Reasoned no, #515): ``request_replies.opened_at``.

The member who asked keeps the Inbox row "Answer to your request" until they open it
(owner 2026-10-24, Train N item 3), not for 14 days.

Card: protects=opened_at comes and goes with the revision, chained on 0053_web_tools as
the single head, nullable so every reply told before it stays unopened; fails_when=the
upgrade misses the column or fills it, or the downgrade leaves it or loses the reply;
no_claim=the route that sets it (tests/test_request_replies.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0054_reply_opened"
PREVIOUS = "0053_web_tools"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_reply_opened")
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
        "WHERE table_name = 'request_replies'"
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
    assert script.get_heads() == ["0072_simple_changes"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), REVISION)
    assert _columns()["opened_at"] == "YES"

    command.downgrade(_cfg(), PREVIOUS)
    assert "opened_at" not in _columns()

    command.upgrade(_cfg(), REVISION)
    assert _columns()["opened_at"] == "YES"
