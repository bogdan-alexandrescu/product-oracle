"""Migration 0071_live_reads (#710 lane 1): the live_reads table and browse_calls.kind.

Card: protects=live_reads comes and goes with the revision, chained on 0070_brand_assets
as the single head, tenant-scoped (tenant FK, cascade), its status limited to
ok/cached/error, a deleted connection leaving its reads (connection_id null), and
browse_calls gaining ``kind`` ('browse' for existing rows, 'live' allowed, nothing else);
fails_when=the upgrade misses the table, a column, the check or the default, or the
downgrade leaves the table or the column behind or loses browse rows;
no_claim=the routes' use of the table (tests/test_live_fireflies.py), live_tokens (lane 2).

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

REVISION = "0071_live_reads"
PREVIOUS = "0070_brand_assets"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_live_reads")
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


def _columns(table: str) -> set[str]:
    rows = _run("SELECT column_name FROM information_schema.columns WHERE table_name = :t", t=table)
    return {r[0] for r in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == [REVISION]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    assert "live_reads" not in _tables()
    tenant, user, conn = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'ada@example.com', 'x', 'member')",
        u=user,
        t=tenant,
    )
    _run(
        "INSERT INTO connections (id, tenant_id, user_id, provider, auth_mode, account_id, "
        "ciphertext, key_version) VALUES (:c, :t, :u, 'fireflies', 'token', 'a', '\\x00', 1)",
        c=conn,
        t=tenant,
        u=user,
    )
    _run(
        "INSERT INTO browse_calls (id, tenant_id, connection_id, at, calls) "
        "VALUES (gen_random_uuid(), :t, :c, now(), 2)",
        t=tenant,
        c=conn,
    )

    command.upgrade(_cfg(), REVISION)
    assert "live_reads" in _tables()
    assert _columns("live_reads") == {
        "id", "tenant_id", "user_id", "message_id", "connection_id", "tool", "ref_n",
        "item_id", "status", "read_at",
    }  # fmt: skip
    assert _run("SELECT kind, calls FROM browse_calls") == [("browse", 2)]
    _run(
        "INSERT INTO browse_calls (id, tenant_id, connection_id, at, calls, kind) "
        "VALUES (gen_random_uuid(), :t, :c, now(), 1, 'live')",
        t=tenant,
        c=conn,
    )
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO browse_calls (id, tenant_id, connection_id, at, calls, kind) "
            "VALUES (gen_random_uuid(), :t, :c, now(), 1, 'other')",
            t=tenant,
            c=conn,
        )
    insert = (
        "INSERT INTO live_reads (id, tenant_id, user_id, connection_id, tool, ref_n, item_id, "
        "status) VALUES (gen_random_uuid(), :t, :u, :c, 'get_meeting', 1, 'm-1', :s)"
    )
    for status in ("ok", "cached", "error"):
        _run(insert, t=tenant, u=user, c=conn, s=status)
    with pytest.raises(IntegrityError):
        _run(insert, t=tenant, u=user, c=conn, s="fine")
    _run("DELETE FROM browse_calls")
    _run("DELETE FROM connections")
    assert _run("SELECT count(*) FROM live_reads WHERE connection_id IS NULL") == [(3,)]
    assert _run("SELECT count(*) FROM live_reads WHERE read_at IS NOT NULL") == [(3,)]

    command.downgrade(_cfg(), PREVIOUS)
    assert "live_reads" not in _tables()
    assert "kind" not in _columns("browse_calls")

    command.upgrade(_cfg(), REVISION)
    assert "live_reads" in _tables()
    _run("DELETE FROM tenants")
