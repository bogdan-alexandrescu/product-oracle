"""Migration 0061_discussion_decision_change (G3 + H1, #187, #193): a discussion change of
kind ``decision``.

Card: protects=the kind CHECK allows ``decision`` with the revision and only then, chained on
0056_slack_pings as the single head; fails_when=the upgrade still refuses a decision
change, the downgrade keeps one or loses another kind's row; no_claim=the routes
(tests/test_discussion_change_kinds.py).

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

REVISION = "0061_discussion_decision_change"
PREVIOUS = "0060_discussion_research"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_decision_change")
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


def _change(tenant: uuid.UUID, d: uuid.UUID, kind: str) -> None:
    _run(
        "INSERT INTO discussion_changes (id, tenant_id, discussion_id, kind, target, payload, "
        "proposed_by_kind) VALUES (:c, :t, :d, :k, '{}', '{}', 'oracle')",
        c=uuid.uuid4(), t=tenant, d=d, k=kind,
    )  # fmt: skip


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0070_brand_assets"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant, d = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run(
        "INSERT INTO discussions (id, tenant_id, subject_kind, subject, subject_key, title, "
        "started_by) VALUES (:d, :t, 'priorities', '{}', 'priorities', 'Order', :u)",
        d=d, t=tenant, u=uuid.uuid4(),
    )  # fmt: skip
    _change(tenant, d, "priority_pin")
    with pytest.raises(IntegrityError):
        _change(tenant, d, "decision")

    command.upgrade(_cfg(), REVISION)
    _change(tenant, d, "decision")
    with pytest.raises(IntegrityError):
        _change(tenant, d, "warp")

    command.downgrade(_cfg(), PREVIOUS)
    assert _run("SELECT kind FROM discussion_changes") == [("priority_pin",)]
    command.upgrade(_cfg(), REVISION)
