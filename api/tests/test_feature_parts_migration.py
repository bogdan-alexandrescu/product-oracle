"""Migration 0115_feature_parts (feature-parts).

Card: protects=roadmap_items.parent_key (nullable text, the key of the item a feature is
part of) comes with the revision and goes with its downgrade, chained on
0114_trash_agenda_requests as the single head; fails_when=the column is missing after the
upgrade, survives the downgrade, or the chain has two heads; no_claim=the change engine's
use (tests/test_simple_feature_parts.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0115_feature_parts"
PREVIOUS = "0114_trash_agenda_requests"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_feature_parts")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _columns() -> list[tuple]:
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                sql = (
                    "SELECT data_type, is_nullable FROM information_schema.columns "
                    "WHERE table_name = 'roadmap_items' AND column_name = 'parent_key'"
                )
                return [tuple(r) for r in (await conn.execute(text(sql))).all()]
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == [REVISION]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _columns() == [("text", "YES")]
    command.downgrade(cfg, PREVIOUS)
    assert _columns() == []
    command.upgrade(cfg, REVISION)
    assert _columns() == [("text", "YES")]
