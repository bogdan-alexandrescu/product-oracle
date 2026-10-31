"""Migration 0094_generation_checks (oracle.simple.quality).

Card: protects=simple_one_pagers.checks and .held and simple_goal_suggestions.checks come
and go with the revision, chained on 0093_dont_know_open as the single head;
fails_when=a column is missing after the upgrade or left after the downgrade;
no_claim=the checks themselves (tests/test_simple_generation_quality.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0094_generation_checks"
PREVIOUS = "0093_dont_know_open"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_generation_checks")
    .render_as_string(hide_password=False)
)
COLUMNS = {
    ("simple_one_pagers", "checks"),
    ("simple_one_pagers", "held"),
    ("simple_goal_suggestions", "checks"),
}


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _columns() -> set[tuple[str, str]]:
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                rows = await conn.execute(
                    text(
                        "SELECT table_name, column_name FROM information_schema.columns "
                        "WHERE table_schema = 'public' AND column_name IN ('checks', 'held')"
                    )
                )
                return {(r[0], r[1]) for r in rows}
        finally:
            await engine.dispose()

    return asyncio.run(go()) & COLUMNS


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert len(script.get_heads()) == 1


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _columns() == COLUMNS
    command.downgrade(cfg, PREVIOUS)
    assert _columns() == set()
    command.upgrade(cfg, REVISION)
    assert _columns() == COLUMNS
