"""Migration 0058_fireflies_endpoint (#602): ``connections.endpoint_url``.

An owner-set GraphQL endpoint on a Fireflies connection; a connection without one reads
the default endpoint, as before.

Card: protects=endpoint_url comes and goes with the revision, chained on
0054_reply_opened as the single head, nullable with no backfill; fails_when=the upgrade
misses the column or fills it, or the downgrade leaves it; no_claim=the routes that set
it and the guarded transport (tests/test_fireflies_endpoint.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0058_fireflies_endpoint"
PREVIOUS = "0057_release_archived_briefs"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_fireflies_endpoint")
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
        "WHERE table_name = 'connections'"
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
    assert script.get_heads() == ["0080_simple_one_pagers"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), REVISION)
    assert _columns()["endpoint_url"] == "YES"
    assert _run("SELECT count(*) FROM connections WHERE endpoint_url IS NOT NULL") == [(0,)]

    command.downgrade(_cfg(), PREVIOUS)
    assert "endpoint_url" not in _columns()

    command.upgrade(_cfg(), REVISION)
    assert _columns()["endpoint_url"] == "YES"
