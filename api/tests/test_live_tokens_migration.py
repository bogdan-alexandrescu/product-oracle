"""Migration 0075_live_tokens (#710 lane 2): the live_tokens table.

Card: protects=live_tokens comes and goes with the revision, chained on 0074_live_reads
as the single head; a token hash is unique; deleting its reply deletes its tokens; the
downgrade drops only the table; fails_when=a column, the unique hash or the cascade is
missing, or the downgrade leaves the table or drops live_reads; no_claim=the tokens' use
(tests/test_live_ask_tokens.py).

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

REVISION = "0075_live_tokens"
PREVIOUS = "0074_live_reads"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_live_tokens")
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
    assert script.get_heads() == ["0092_feedback_discussion"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant, user, d, m = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    assert "live_tokens" not in _tables()
    command.upgrade(_cfg(), REVISION)
    assert _columns("live_tokens") == {
        "id",
        "tenant_id",
        "created_at",
        "user_id",
        "message_id",
        "token_hash",
        "expires_at",
        "revoked_at",
        "last_used_at",
    }
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'ada@example.com', 'x', 'owner')",
        u=user,
        t=tenant,
    )
    _run(
        "INSERT INTO discussions (id, tenant_id, subject_kind, subject, subject_key, title, "
        "visibility, started_by) VALUES (:d, :t, 'section', '{}', 'k', 'T', 'private', :u)",
        d=d,
        t=tenant,
        u=user,
    )
    _run(
        "INSERT INTO discussion_messages (id, tenant_id, discussion_id, author_kind, body, "
        "status) VALUES (:m, :t, :d, 'oracle', '', 'streaming')",
        m=m,
        t=tenant,
        d=d,
    )
    insert = (
        "INSERT INTO live_tokens (id, tenant_id, user_id, message_id, token_hash, expires_at) "
        "VALUES (gen_random_uuid(), :t, :u, :m, 'h1', now() + interval '10 minutes')"
    )
    _run(insert, t=tenant, u=user, m=m)
    with pytest.raises(IntegrityError):
        _run(insert, t=tenant, u=user, m=m)
    _run("DELETE FROM discussion_messages WHERE id = :m", m=m)
    assert _run("SELECT count(*) FROM live_tokens") == [(0,)]

    command.downgrade(_cfg(), PREVIOUS)
    assert "live_tokens" not in _tables()
    assert "live_reads" in _tables()
