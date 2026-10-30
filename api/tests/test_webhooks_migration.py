"""Migration 0065_webhooks (I1 lane 1): the webhooks, webhook_events and webhook_deliveries
tables, and the two Inbox row kinds webhooks add to ``notifications.kind``.

Card: protects=the three tables and the wider kind check come and go with the revision,
chained on 0054_reply_opened as the single head; fails_when=the upgrade misses a table or
still refuses a webhook Inbox row, or the downgrade leaves a table or a webhook row's kind;
no_claim=the routes (tests/test_webhooks_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0065_webhooks"
PREVIOUS = "0064_feedback_withheld"
# #642 review: webhooks.resumed_at, chained after #637 review's delivery log (train R).
RESUMED = "0067_webhook_resumed_at"
TABLES = {"webhooks", "webhook_events", "webhook_deliveries"}
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_webhooks")
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


def _tables() -> set[str]:
    rows = _run("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
    return {name for (name,) in rows} & TABLES


def _kinds() -> str:
    rows = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'ck_notifications_kind'"
    )
    return rows[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_revision(RESUMED).down_revision == "0066_webhook_delivery_sent"
    assert script.get_heads() == ["0094_generation_checks"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), REVISION)
    assert _tables() == TABLES
    assert "webhook_paused" in _kinds() and "webhook_url_changed" in _kinds()

    command.downgrade(_cfg(), PREVIOUS)
    assert _tables() == set()
    assert "webhook" not in _kinds() and "published" in _kinds()

    command.upgrade(_cfg(), REVISION)
    assert _tables() == TABLES
    assert "webhook_paused" in _kinds()


def _columns() -> set[str]:
    rows = _run("SELECT column_name FROM information_schema.columns WHERE table_name = 'webhooks'")
    return {name for (name,) in rows}


def test_resumed_at_comes_and_goes(scratch_db):
    # protects=webhooks.resumed_at comes and goes with 0067_webhook_resumed_at and the
    # webhooks table stays; fails_when=the upgrade misses the column or the downgrade
    # leaves it.
    command.upgrade(_cfg(), RESUMED)
    assert "resumed_at" in _columns()
    command.downgrade(_cfg(), REVISION)
    assert "resumed_at" not in _columns() and "status" in _columns()
    command.upgrade(_cfg(), RESUMED)
    assert "resumed_at" in _columns()
