"""Migration 0066_webhook_delivery_sent (I1, review of #637): ``webhook_deliveries.host``
and ``webhook_deliveries.headers``, where each delivery went and the headers it sent.

Card: protects=both columns come and go with the revision, chained on 0065_webhooks as
the single head, nullable so every earlier delivery stays as it was; fails_when=the
upgrade misses a column, or the downgrade leaves one; no_claim=what is written to them
(tests/test_webhooks_delivery.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0066_webhook_delivery_sent"
PREVIOUS = "0065_webhooks"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_webhook_delivery_sent")
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
        "WHERE table_name = 'webhook_deliveries'"
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
    assert script.get_heads() == ["0093_meeting_comments_as_notes"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), REVISION)
    assert _columns()["host"] == _columns()["headers"] == "YES"

    command.downgrade(_cfg(), PREVIOUS)
    assert {"host", "headers"}.isdisjoint(_columns()) and "body" in _columns()

    command.upgrade(_cfg(), REVISION)
    assert _columns()["host"] == _columns()["headers"] == "YES"
