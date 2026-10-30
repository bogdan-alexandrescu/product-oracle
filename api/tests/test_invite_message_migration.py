"""Migration 0043_invite_message: ``invites.message`` (#203 AC10), the owner's optional
note to the invitee, at most 500 characters. Sync on purpose (Alembic runs its own event
loop); its own scratch database. Made-up company.

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

REVISION = "0043_invite_message"
PREVIOUS = "0042_members_access"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_invite_message")
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
        "WHERE table_name = 'invites' AND column_name = 'message'"
    )
    return [r[0] for r in rows]


def _invite(tenant: uuid.UUID, address: str, **message) -> uuid.UUID:
    i = uuid.uuid4()
    cols = ", message" if message else ""
    vals = ", :message" if message else ""
    _run(
        f"INSERT INTO invites (id, tenant_id, email, role{cols}) "
        f"VALUES (:i, :t, :e, 'viewer'{vals})",
        i=i,
        t=tenant,
        e=address,
        **message,
    )
    return i


# protects=one head, this one, right after subgoals; fails_when=a second head or a gap in
# the chain; no_claim=what the column does.
def test_the_chain_ends_here():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0093_meeting_comments_as_notes"]
    assert script.get_revision(REVISION).down_revision == PREVIOUS


# protects=the message column comes and goes, old invites keep no message, and 501
# characters is refused by the database too; fails_when=the column is missing, not
# nullable, unbounded, or left behind by the downgrade; no_claim=the API's trimming.
def test_message_column_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    assert _columns() == []
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    old = _invite(tenant, "old@example.com")

    command.upgrade(cfg, REVISION)
    assert _columns() == ["message"]
    assert _run("SELECT message FROM invites WHERE id = :i", i=old) == [(None,)]
    _invite(tenant, "new@example.com", message="x" * 500)
    with pytest.raises(Exception, match="message_length"):
        _invite(tenant, "long@example.com", message="x" * 501)

    command.downgrade(cfg, PREVIOUS)
    assert _columns() == []
    command.upgrade(cfg, REVISION)
    assert _columns() == ["message"]
