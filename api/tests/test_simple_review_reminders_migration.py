"""Migration 0081_simple_review_reminders (Simple, Remind on a one-pager, #723).

Card: protects=simple_drafts.reminders and the notifications kind review_reminder come and
go with the revision, chained on 0080_simple_one_pagers as the single head; fails_when=the
column or the kind is missing, or the downgrade leaves either; no_claim=the route's use
(tests/test_simple_one_pager_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0081_simple_review_reminders"
PREVIOUS = "0080_simple_one_pagers"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_simple_review_reminders")
    .render_as_string(hide_password=False)
)
COLUMN = "reminders"


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


def _state() -> tuple[bool, bool]:
    cols = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'simple_drafts'"
    )
    kind = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'ck_notifications_kind'"
    )
    return COLUMN in {r[0] for r in cols}, "review_reminder" in kind[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0092_rituals_wait_for_goal"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _state() == (True, True)
    command.downgrade(cfg, PREVIOUS)
    assert _state() == (False, False)
    command.upgrade(cfg, REVISION)
    assert _state() == (True, True)
