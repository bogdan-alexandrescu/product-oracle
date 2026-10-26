"""Migration 0051_pricing (H9 Pricing input): the pricing kind, origin, flow and
checkpoint, the deal_outcomes table and interviews.preset. The downgrade refuses while a
pricing document exists.

Sync on purpose (Alembic runs its own event loop); its own scratch database.

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
from sqlalchemy.exc import IntegrityError

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0051_pricing"
PREVIOUS = "0050_metrics"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_pricing")
    .render_as_string(hide_password=False)
)
CHECKS = {
    "ck_documents_kind": ("pricing",),
    "ck_templates_kind": ("pricing",),
    "ck_themes_kind": ("pricing",),
    "ck_decisions_origin": ("pricing",),
    "ck_runs_flow": ("pricing_memo",),
    "ck_checkpoints_kind": ("pricing_review",),
}


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


def _definition(name: str) -> str:
    rows = _run("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :n", n=name)
    return rows[0][0]


def _table(name: str) -> bool:
    return bool(_run("SELECT 1 FROM information_schema.tables WHERE table_name = :n", n=name))


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_mains_head():
    """protects=one head, on main's head at build time; fails_when=a second head or another
    parent; no_claim=later lanes' re-chaining."""
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0071_simple_roadmap_dates"]


def test_upgrade_adds_the_table_and_values_and_downgrade_refuses_while_memos_exist(scratch_db):
    """protects=the six checks gain only this lane's values (others kept), deal_outcomes
    refuses Other without a note and a value without its currency, interviews.preset takes
    pricing only; the downgrade refuses while a pricing document exists, and once it is
    gone drops the table and the column and restores the checks; fails_when=a value is
    missing, another value is dropped, a bad row is accepted, or the downgrade deletes a
    memo; no_claim=data written by the app."""
    command.upgrade(_cfg(), PREVIOUS)
    before = {name: _definition(name) for name in CHECKS}
    command.upgrade(_cfg(), REVISION)
    for name, values in CHECKS.items():
        after = _definition(name)
        for v in values:
            assert f"'{v}'" in after, (name, v)
        for kept in ("prd", "update", "manual", "checkpoint", "update_draft", "update_review"):
            if f"'{kept}'" in before[name]:
                assert f"'{kept}'" in after, (name, kept)
    tenant, user = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    row = (
        "INSERT INTO deal_outcomes (id, tenant_id, result, account, decided_on, reason, "
        "reason_note, annual_value, currency, recorded_by) VALUES (:id, :t, 'lost', "
        "'Account 14', '2026-09-30', :reason, :note, :value, :currency, :u)"
    )
    _run(row, id=uuid.uuid4(), t=tenant, reason="price", note=None, value=4800, currency="USD",
         u=user)  # fmt: skip
    for reason, note, value, currency in (("other", None, None, None),
                                          ("price", None, 4800, None)):  # fmt: skip
        with pytest.raises(IntegrityError):
            _run(row, id=uuid.uuid4(), t=tenant, reason=reason, note=note, value=value,
                 currency=currency, u=user)  # fmt: skip
    assert "'pricing'" in _definition("ck_interviews_preset")
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status, kind, visibility) "
        "VALUES (:id, :t, 'team-plan-pricing', 'Team plan pricing', 'draft', 'pricing', "
        "'approvers')",
        id=uuid.uuid4(), t=tenant,
    )  # fmt: skip

    with pytest.raises(RuntimeError, match="pricing memo"):
        command.downgrade(_cfg(), PREVIOUS)
    assert _table("deal_outcomes")
    assert _run("SELECT slug FROM documents") == [("team-plan-pricing",)]

    _run("DELETE FROM documents WHERE kind = 'pricing'")
    command.downgrade(_cfg(), PREVIOUS)
    assert not _table("deal_outcomes")
    for name in CHECKS:
        assert _definition(name) == before[name], name
