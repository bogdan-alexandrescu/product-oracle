"""Migration 0041_subgoals: ``entities.parent_id`` (#345), a goal's parent goal. Sync on
purpose (Alembic runs its own event loop); its own scratch database. Made-up company.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
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

REVISION = "0041_subgoals"
PREVIOUS = "0040_claude_account_identity"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_subgoals")
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
    rows = _run(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'entities' AND column_name = 'parent_id'"
    )
    return [r[0] for r in rows]


def _goal(tenant: uuid.UUID, key: str) -> uuid.UUID:
    g = uuid.uuid4()
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, attrs, status, origin, locked) "
        "VALUES (:g, :t, 'goal', :k, :k, '{}'::jsonb, 'confirmed', 'user', false)",
        g=g,
        t=tenant,
        k=key,
    )
    return g


# protects=one head, Members and access (A5) right after this one; fails_when=a second head
# or a gap in the chain; no_claim=what the column does.
def test_the_chain_ends_here():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0081_simple_review_reminders"]
    assert script.get_revision("0042_members_access").down_revision == REVISION
    assert script.get_revision(REVISION).down_revision == PREVIOUS


# protects=the parent column comes and goes, a deleted parent leaves its subgoal a goal,
# and a goal cannot be its own parent; fails_when=the column is missing, a delete takes
# the subgoal with it, or the downgrade leaves the column; no_claim=the API's rules.
def test_parent_column_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    assert _columns() == []
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    parent, child = _goal(tenant, "activation"), _goal(tenant, "activation-setup")

    command.upgrade(cfg, REVISION)
    assert _columns() == ["parent_id"]
    _run("UPDATE entities SET parent_id = :p WHERE id = :c", p=parent, c=child)
    with pytest.raises(Exception, match="not_own_parent"):
        _run("UPDATE entities SET parent_id = id WHERE id = :p", p=parent)
    _run("DELETE FROM entities WHERE id = :p", p=parent)
    assert _run("SELECT parent_id FROM entities WHERE id = :c", c=child) == [(None,)]

    command.downgrade(cfg, PREVIOUS)
    assert _columns() == []
    command.upgrade(cfg, REVISION)
