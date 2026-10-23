"""Migration 0040_claude_account_identity: which Claude account a pool account is (#405).

Adds ``claude_accounts.claude_email`` and ``claude_organization``, nullable; the
downgrade drops them and keeps the rows.

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

REVISION = "0040_claude_account_identity"
PREVIOUS = "0039_company_timezone"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_claude_identity")
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


def _columns() -> list[str]:
    return [
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns WHERE table_name = "
            "'claude_accounts' AND column_name LIKE 'claude_%' ORDER BY column_name"
        )
    ]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_the_chain_ends_here_after_discussion_replies():
    # Subgoals' 0041_subgoals (#345) chains on it; one head.
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0041_subgoals"]
    assert script.get_revision("0041_subgoals").down_revision == REVISION
    assert script.get_revision(REVISION).down_revision == PREVIOUS


def test_upgrade_downgrade_upgrade_keeps_the_accounts(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run(
        "INSERT INTO claude_accounts (id, tenant_id, label, provider, state, reason, "
        "windows, holds, assigned, last_refresh_reason) VALUES (:a, :t, 'personal', "
        "'anthropic', 'AVAILABLE', '', '{}', '[]', 0, '')",
        a=uuid.uuid4(),
        t=tenant,
    )
    command.upgrade(cfg, REVISION)
    assert _columns() == ["claude_email", "claude_organization"]
    # Existing rows: not reported.
    assert _run("SELECT label, claude_email, claude_organization FROM claude_accounts") == [
        ("personal", None, None)
    ]
    command.downgrade(cfg, PREVIOUS)
    assert _columns() == []
    assert _run("SELECT label FROM claude_accounts") == [("personal",)]
    command.upgrade(cfg, REVISION)
    assert _columns() == ["claude_email", "claude_organization"]
