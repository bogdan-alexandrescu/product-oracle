"""Migration 0056_slack_pings: the Slack outbox also carries a ping to one member.

Card: protects=recipient_id and the ``ping`` op come and go with the revision, chained on
0055_deal_competitor as the single head; a ping needs a recipient and no thread, every other
op still needs its thread; the downgrade deletes the pings and keeps the mirror's items;
fails_when=a ping without a recipient or a post without a link is accepted, or the
downgrade fails on pings or loses another item; no_claim=delivery
(tests/test_slack_pings.py).

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

REVISION = "0056_slack_pings"
PREVIOUS = "0055_deal_competitor"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_slack_pings")
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


def _columns() -> dict[str, str]:
    rows = _run(
        "SELECT column_name, is_nullable FROM information_schema.columns "
        "WHERE table_name = 'slack_outbox'"
    )
    return {name: nullable for name, nullable in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0091_prd_questions"]


def _item(op: str, link, recipient) -> None:
    _run(
        "INSERT INTO slack_outbox (id, tenant_id, link_id, recipient_id, op, payload) "
        "VALUES (gen_random_uuid(), :t, :l, :r, :op, '{}')",
        t=TENANT, l=link, r=recipient, op=op,
    )  # fmt: skip


TENANT = uuid.UUID("00000000-0000-4000-8000-0000000000aa")
USER = uuid.UUID("00000000-0000-4000-8000-0000000000bb")


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), REVISION)
    assert _columns()["recipient_id"] == "YES"
    assert _columns()["link_id"] == "YES"
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=TENANT)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:id, :t, 'ada@example.com', 'x', 'commenter')",
        id=USER, t=TENANT,
    )  # fmt: skip
    _item("ping", None, USER)
    with pytest.raises(IntegrityError):
        _item("ping", None, None)
    with pytest.raises(IntegrityError):
        _item("post", None, None)

    command.downgrade(_cfg(), PREVIOUS)
    assert "recipient_id" not in _columns()
    assert _columns()["link_id"] == "NO"
    assert _run("SELECT count(*) FROM slack_outbox") == [(0,)]

    command.upgrade(_cfg(), REVISION)
    assert _columns()["recipient_id"] == "YES"
