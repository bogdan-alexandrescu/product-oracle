"""Migration 0049_web_tools (H7 lane 1): the web_searches and web_results tables and the
``read:web`` run-token scope.

Card: protects=the two tables and the scope come and go with the revision, scopes other
lanes add to the run_tokens check survive both ways, and the downgrade refuses while a
live run token holds read:web; fails_when=the upgrade misses a table or the scope, the
downgrade leaves one behind, drops another lane's scope, or strands a live token;
no_claim=the routes' use of the tables (tests/test_web_tools.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0049_web_tools"
PREVIOUS = "0048_scope_review"
TABLES = {"web_searches", "web_results"}
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
    assert script.get_heads() == [REVISION]


def _token(tenant: uuid.UUID, scopes: str, expires: str = "now() + interval '1 hour'") -> None:
    run = uuid.uuid4()
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (:r, :t, 'baseline_to_prd', 'draft')",
        r=run,
        t=tenant,
    )
    _run(
        "INSERT INTO run_tokens (id, tenant_id, run_id, token_hash, scopes, expires_at) "
        f"VALUES (gen_random_uuid(), :t, :r, :h, CAST(:s AS text[]), {expires})",
        t=tenant,
        r=run,
        h=uuid.uuid4().hex,
        s=scopes,
    )


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    assert not TABLES & _tables()
    assert "read:web" not in _check()
    # Another lane's scope, added to the check before this revision, survives both ways.
    _run("ALTER TABLE run_tokens DROP CONSTRAINT ck_run_tokens_scopes")
    _run(
        "ALTER TABLE run_tokens ADD CONSTRAINT ck_run_tokens_scopes CHECK "
        "(cardinality(scopes) > 0 AND scopes <@ ARRAY['read:sources', 'read:baseline', "
        "'read:documents', 'write:proposals', 'write:drafts', 'read:other_lane']::text[])"
    )

    command.upgrade(_cfg(), REVISION)
    assert TABLES <= _tables()
    assert "'read:web'" in _check() and "'read:other_lane'" in _check()
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    _token(tenant, "{read:web,read:baseline}")
    with pytest.raises(IntegrityError):
        _token(tenant, "{read:everything}")
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO web_results (id, tenant_id, run_id, ref, kind, url, host, text) "
            "SELECT gen_random_uuid(), :t, id, 'w-1', 'video', 'https://a.example/', "
            "'a.example', 'x' FROM runs LIMIT 1",
            t=tenant,
        )

    # A live token holding read:web blocks the downgrade.
    with pytest.raises(RuntimeError, match="read:web"):
        command.downgrade(_cfg(), PREVIOUS)
    assert TABLES <= _tables()
    _run("UPDATE run_tokens SET expires_at = now() - interval '1 second'")
    command.downgrade(_cfg(), PREVIOUS)
    assert not TABLES & _tables()
    assert "read:web" not in _check() and "'read:other_lane'" in _check()
    # Expired tokens that held it are gone with it; nothing else is.
    assert _run("SELECT count(*) FROM run_tokens") == [(0,)]
    assert _run("SELECT count(*) FROM runs") == [(1,)]

    command.upgrade(_cfg(), REVISION)
    assert TABLES <= _tables()
