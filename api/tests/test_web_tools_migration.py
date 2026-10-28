"""Migration 0053_web_tools (H7 lane 1): the web_searches table.

``web_results`` and the ``read:web`` scope are 0052_market's (owner decision
h7-web-results-owner); tests/test_market_migration.py covers them.

Card: protects=web_searches comes and goes with the revision, chained on 0052_market as
the single head, and its downgrade leaves 0052_market's web_results and read:web in
place; fails_when=the upgrade misses the table, the downgrade leaves it or the setting
behind, or takes 0052_market's table or scope with it; no_claim=the routes' use of the
tables (tests/test_web_tools.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0053_web_tools"
PREVIOUS = "0052_market"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_web_tools")
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
    return {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


def _check() -> str:
    return _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_run_tokens_scopes'"
    )[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0089_ritual_attendees_edited_at"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    assert "web_searches" not in _tables()
    assert "web_results" in _tables() and "'read:web'" in _check()

    command.upgrade(_cfg(), REVISION)
    assert "web_searches" in _tables()
    tenant, run = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (:r, :t, 'competitive_digest', 'running')",
        r=run,
        t=tenant,
    )
    _run(
        "INSERT INTO web_searches (id, tenant_id, run_id, query, results) "
        "VALUES (gen_random_uuid(), :t, :r, 'Competitor A news', 3)",
        t=tenant,
        r=run,
    )
    _run(
        "INSERT INTO tenant_settings (id, tenant_id, key, value) "
        "VALUES (gen_random_uuid(), :t, 'web_searches_per_month', '50')",
        t=tenant,
    )

    command.downgrade(_cfg(), PREVIOUS)
    assert "web_searches" not in _tables()
    assert "web_results" in _tables() and "'read:web'" in _check()
    assert _run("SELECT count(*) FROM tenant_settings") == [(0,)]
    assert _run("SELECT count(*) FROM runs") == [(1,)]

    command.upgrade(_cfg(), REVISION)
    assert "web_searches" in _tables()
