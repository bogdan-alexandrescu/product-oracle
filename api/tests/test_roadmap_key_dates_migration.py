"""Migration 0082_roadmap_key_dates (Simple roadmap-plus, #723).

Card: protects=roadmap_key_dates (a roadmap's published key dates: name, day, optional note)
comes and goes with the revision, chained on 0081_simple_review_reminders as the single head;
fails_when=the table or a column is missing, or the downgrade leaves it; no_claim=the
change engine's use (tests/test_simple_key_dates_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0082_roadmap_key_dates"
PREVIOUS = "0081_simple_review_reminders"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_key_dates")
    .render_as_string(hide_password=False)
)
COLUMNS = {
    "id",
    "tenant_id",
    "created_at",
    "roadmap_document_id",
    "name",
    "on_date",
    "note",
    "created_by",
}


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


def _columns() -> set[str]:
    return {
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'roadmap_key_dates'"
        )
    }


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0093_dont_know_open"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _columns() == COLUMNS
    command.downgrade(cfg, PREVIOUS)
    assert _columns() == set()
    command.upgrade(cfg, REVISION)
    assert _columns() == COLUMNS
