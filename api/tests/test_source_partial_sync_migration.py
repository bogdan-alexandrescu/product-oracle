"""Migration 0023_source_partial_sync: when a sync that has not finished last stored
something (#249).

Adds the nullable ``sources.partly_synced_at``; existing sources read null (their row
shows the last finished sync, or never synced). The downgrade drops it.

Sync tests on purpose (Alembic runs its own event loop); own scratch database.
"""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0023_source_partial_sync"
PREVIOUS = "0022_updates"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_source_partial_sync")
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


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def _columns() -> list[str]:
    return [
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'sources' "
            "AND column_name = 'partly_synced_at'"
        )
    ]


def test_the_chain_after_updates():
    script = ScriptDirectory.from_config(_cfg())
    # 0023_intake_brief_fields (C4) chains on it, then 0024_segment_skipped; one head.
    assert script.get_heads() == ["0081_simple_visuals"]
    assert script.get_revision("0023_intake_brief_fields").down_revision == REVISION
    assert script.get_revision(REVISION).down_revision == PREVIOUS


def test_upgrade_adds_partly_synced_at_and_downgrade_drops_it(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant, user = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'sam@example.com', 'x', 'owner')",
        u=user,
        t=tenant,
    )
    _run(
        "INSERT INTO sources (id, tenant_id, owner_user_id, kind, name, status) "
        "VALUES (:i, :t, :u, 'upload', 'Notes', 'active')",
        i=uuid.uuid4(),
        t=tenant,
        u=user,
    )

    command.upgrade(cfg, REVISION)

    assert _columns() == ["partly_synced_at"]
    assert _run("SELECT partly_synced_at FROM sources") == [(None,)]
    _run("UPDATE sources SET partly_synced_at = now()")

    command.downgrade(cfg, PREVIOUS)
    assert _columns() == []
    assert _run("SELECT count(*) FROM sources") == [(1,)]
