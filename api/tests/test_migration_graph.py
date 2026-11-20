"""The migration graph as a whole: one head, every revision on the walk from it, and the
chain upgrades, downgrades to empty and upgrades again on a scratch database.

The per-migration tests check their own revision's data (tests/migration_db.py clones a
database at the revision they start from); this is the one place for the graph.

Sync on purpose (Alembic runs its own event loop)."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_graph")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _tables() -> set[str]:
    async def go():
        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.connect() as conn:
                rows = await conn.execute(
                    text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                )
                return {r[0] for r in rows}
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_one_head_and_one_base():
    script = ScriptDirectory.from_config(_cfg())
    assert len(script.get_heads()) == 1
    assert len(script.get_bases()) == 1


def test_every_revision_is_reached_from_the_head():
    """No revision file is left off the chain from the one head down to the one base."""
    script = ScriptDirectory.from_config(_cfg())
    walked = [r.revision for r in script.walk_revisions("base", "heads")]
    assert len(walked) == len(set(walked))
    assert len(walked) == len(list((API_DIR / "migrations" / "versions").glob("*.py")))


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "head")
    assert len(_tables()) > 100
    command.downgrade(cfg, "base")
    assert _tables() == {"alembic_version"}
    command.upgrade(cfg, "head")
    assert len(_tables()) > 100
