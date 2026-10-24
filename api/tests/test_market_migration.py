"""Migration 0052_market (H7 Competitive digest): up, down and up again.

Card: protects=the eight tables, the ``competitive_digest`` flow value and the
``read:web`` scope come and go with the revision, the downgrade refuses while a live run
token holds read:web, and it deletes the digest runs and the setting; fails_when=the
upgrade misses a table or a check value, the downgrade leaves one behind or strands a live
token, or a second upgrade fails; no_claim=the application's use of the tables
(tests/test_market*.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0052_market"
PREVIOUS = "0051_pricing"
TABLES = {
    "competitors",
    "competitor_pages",
    "competitor_page_snapshots",
    "web_results",
    "competitor_web_findings",
    "competitor_changes",
    "positioning",
    "positioning_suggestions",
}
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_market")
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


def _check(name: str) -> str:
    return _run("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :n", n=name)[
        0
    ][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_market_up_down_up(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    assert not TABLES & _tables()
    assert "competitive_digest" not in _check("ck_runs_flow")
    assert "read:web" not in _check("ck_run_tokens_scopes")

    command.upgrade(_cfg(), REVISION)
    assert TABLES <= _tables()
    assert "'competitive_digest'" in _check("ck_runs_flow")
    assert "'baseline'" in _check("ck_runs_flow")
    assert "'read:web'" in _check("ck_run_tokens_scopes")
    tenant, run = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (:r, :t, 'competitive_digest', 'running')",
        r=run,
        t=tenant,
    )
    _run(
        "INSERT INTO run_tokens (id, tenant_id, run_id, token_hash, scopes, expires_at) "
        "VALUES (gen_random_uuid(), :t, :r, :h, ARRAY['read:web', 'read:baseline'], "
        "now() + interval '1 hour')",
        t=tenant,
        r=run,
        h=uuid.uuid4().hex,
    )
    _run(
        "INSERT INTO competitors (id, tenant_id, name, kind) "
        "VALUES (gen_random_uuid(), :t, 'Competitor A', 'direct')",
        t=tenant,
    )
    _run(
        "INSERT INTO tenant_settings (id, tenant_id, key, value) "
        "VALUES (gen_random_uuid(), :t, 'web_searches_per_month', '50')",
        t=tenant,
    )

    # A live token holding read:web blocks the downgrade; nothing is dropped.
    with pytest.raises(RuntimeError, match="read:web"):
        command.downgrade(_cfg(), PREVIOUS)
    assert TABLES <= _tables()
    _run("UPDATE run_tokens SET expires_at = now() - interval '1 second'")
    command.downgrade(_cfg(), PREVIOUS)
    assert not TABLES & _tables()
    assert "competitive_digest" not in _check("ck_runs_flow")
    assert "'baseline'" in _check("ck_runs_flow")
    assert "read:web" not in _check("ck_run_tokens_scopes")
    assert _run("SELECT count(*) FROM runs WHERE flow = 'competitive_digest'") == [(0,)]
    assert _run("SELECT count(*) FROM run_tokens") == [(0,)]
    assert _run("SELECT count(*) FROM tenant_settings WHERE key = 'web_searches_per_month'") == [
        (0,)
    ]

    command.upgrade(_cfg(), REVISION)
    assert TABLES <= _tables()
    assert "'competitive_digest'" in _check("ck_runs_flow")
    assert "'read:web'" in _check("ck_run_tokens_scopes")
