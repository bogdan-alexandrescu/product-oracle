"""Migration 0074_live_reads (#710 lane 1): the live_reads table and browse_calls.kind.

Each test carries its own card.

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

REVISION = "0074_live_reads"
PREVIOUS = "0073_share_links"
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


# protects=0074_live_reads chains on 0073_share_links, and the live stack's head
# (0081_simple_review_reminders) is the single head; fails_when=the revision is re-parented
# or a second head appears; no_claim=what the revision creates (test_upgrade_and_downgrade).
def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0090_goal_suggestion_people"]


# protects=live_reads and browse_calls.kind come and go with the revision: an existing
# browse_calls row reads as the picker's ('browse'), status and kind take only their
# values, a deleted connection leaves its read without the id, and the downgrade drops the
# table and the column; fails_when=the upgrade misses a column or check, an existing row
# gets another kind, or the downgrade leaves anything behind; no_claim=the routes' use of
# the tables (tests/test_live_fireflies.py), live_tokens (lane 2).
def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant, user, conn = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'ada@example.com', 'x', 'owner')",
        u=user,
        t=tenant,
    )
    _run(
        "INSERT INTO connections (id, tenant_id, user_id, provider, auth_mode, account_id, "
        "ciphertext, key_version, status) "
        "VALUES (:c, :t, :u, 'fireflies', 'token', 'a', '\\x00', 1, 'active')",
        c=conn,
        t=tenant,
        u=user,
    )
    _run(
        "INSERT INTO browse_calls (id, tenant_id, connection_id, at, calls) "
        "VALUES (gen_random_uuid(), :t, :c, now(), 3)",
        t=tenant,
        c=conn,
    )
    assert "live_reads" not in _tables()

    command.upgrade(_cfg(), REVISION)
    assert "live_reads" in _tables()
    assert _columns("live_reads") >= {
        "id",
        "tenant_id",
        "user_id",
        "message_id",
        "connection_id",
        "tool",
        "source_label",
        "ref_n",
        "item_id",
        "status",
        "read_at",
    }
    assert _run("SELECT kind, calls FROM browse_calls") == [("browse", 3)]
    insert = (
        "INSERT INTO live_reads (id, tenant_id, user_id, connection_id, tool, source_label, "
        "ref_n, status) VALUES (gen_random_uuid(), :t, :u, :c, 'list_meetings', 'Archive', 1, :s)"
    )
    _run(insert, t=tenant, u=user, c=conn, s="ok")
    with pytest.raises(IntegrityError):
        _run(insert, t=tenant, u=user, c=conn, s="done")
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO browse_calls (id, tenant_id, connection_id, at, calls, kind) "
            "VALUES (gen_random_uuid(), :t, :c, now(), 1, 'other')",
            t=tenant,
            c=conn,
        )
    # A deleted connection leaves the read, without its id.
    _run("DELETE FROM connections WHERE id = :c", c=conn)
    assert _run("SELECT connection_id, source_label FROM live_reads") == [(None, "Archive")]

    command.downgrade(_cfg(), PREVIOUS)
    assert "live_reads" not in _tables()
    assert "kind" not in _columns("browse_calls")

    command.upgrade(_cfg(), REVISION)
    assert "live_reads" in _tables()
