"""Migration 0055_deal_competitor (H9 x H7): ``deal_outcomes.competitor_id`` gains its
foreign key to ``competitors`` (ON DELETE SET NULL) and an index, once both tables exist.

Test card: protects=the upgrade clears a competitor_id that names no alternative (none
could be written before: the API refused it) and keeps a real one, then refuses an unknown
id; deleting an alternative clears the link; the downgrade drops the key and index and
keeps the ids; fails_when=the upgrade fails on a dangling id, a real link is lost, an
unknown id is accepted, or the chain has two heads; no_claim=the application's checks
(tests/test_deal_outcomes.py).

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

REVISION = "0055_deal_competitor"
PREVIOUS = "0054_reply_opened"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_deal_competitor")
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


DEAL = (
    "INSERT INTO deal_outcomes (id, tenant_id, result, account, decided_on, reason, "
    "competitor_id, recorded_by) VALUES (:id, :t, 'lost', :account, '2026-09-30', "
    "'alternative', :c, :u)"
)


def _key_exists() -> bool:
    return bool(
        _run(
            "SELECT 1 FROM pg_constraint WHERE conname = "
            "'fk_deal_outcomes_competitor_id_competitors'"
        )
    )


def test_chains_on_mains_head_and_is_the_only_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0079_simple_one_pagers"]


def test_upgrade_adds_the_key_and_downgrade_drops_it(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t, u, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO competitors (id, tenant_id, name, kind) "
        "VALUES (:c, :t, 'Competitor A', 'direct')",
        c=c,
        t=t,
    )
    _run(DEAL, id=uuid.uuid4(), t=t, account="Account 1", c=c, u=u)
    _run(DEAL, id=uuid.uuid4(), t=t, account="Account 2", c=uuid.uuid4(), u=u)

    command.upgrade(cfg, REVISION)
    assert _key_exists()
    rows = dict(_run("SELECT account, competitor_id FROM deal_outcomes"))
    assert rows == {"Account 1": c, "Account 2": None}
    with pytest.raises(IntegrityError):
        _run(DEAL, id=uuid.uuid4(), t=t, account="Account 3", c=uuid.uuid4(), u=u)
    _run("DELETE FROM competitors WHERE id = :c", c=c)
    assert _run("SELECT competitor_id FROM deal_outcomes WHERE account = 'Account 1'") == [(None,)]
    _run(
        "INSERT INTO competitors (id, tenant_id, name, kind) "
        "VALUES (:c, :t, 'Competitor A', 'direct')",
        c=c,
        t=t,
    )
    _run("UPDATE deal_outcomes SET competitor_id = :c WHERE account = 'Account 1'", c=c)

    command.downgrade(cfg, PREVIOUS)
    assert not _key_exists()
    assert not _run("SELECT 1 FROM pg_indexes WHERE indexname = 'ix_deal_outcomes_competitor_id'")
    assert _run("SELECT competitor_id FROM deal_outcomes WHERE account = 'Account 1'") == [(c,)]
