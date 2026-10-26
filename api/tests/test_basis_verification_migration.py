"""Migration 0031_basis_verification (F3 Date bases): proposed and rejected statuses, a
nullable ``verified_at``, the proposal, note, withdrawal-reason and rejection columns, and
``withdrawn_reason`` backfilled from each withdrawal's audit event; reversible.

Sync on purpose (Alembic runs its own event loop); its own scratch database.
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0031_basis_verification"
PREVIOUS = "0030_roadmap_change_sets"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_basis_verification")
    .render_as_string(hide_password=False)
)
ROWS = "SELECT id, status, verified_at, withdrawn_at FROM schedule_bases ORDER BY reference"


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


def test_chains_on_mains_head():
    # protects=one alembic head; fails_when=a second head appears or the revision chains
    # on a fixed number other than main's head; no_claim=the schema (below).
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0055_source_sync"]


def _basis(tenant, doc, reference: str, status: str, **cols) -> uuid.UUID:
    basis = uuid.uuid4()
    names = ", ".join(cols)
    values = ", ".join(f":{c}" for c in cols)
    _run(
        "INSERT INTO schedule_bases (id, tenant_id, kind, reference, supports_date, "
        f"prd_document_id, status, verified_at{', ' + names if cols else ''}) VALUES "
        f"(:id, :t, 'estimate', :r, '2026-11-30', :d, :s, now(){', ' + values if cols else ''})",
        id=basis, t=tenant, r=reference, d=doc, s=status, **cols,
    )  # fmt: skip
    return basis


def test_up_down_up_keeps_bases_and_backfills_reasons(scratch_db):
    # protects=AC6 (backfill) and AC10; fails_when=a verified or withdrawn row changes, a
    # withdrawn row's reason is not read from its audit event, the downgrade leaves a
    # proposed or rejected row or the new columns, or verified_at may be null for a
    # verified basis; no_claim=the API.
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant, doc = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, kind, status) "
        "VALUES (:id, :t, 'example-prd', 'Example PRD', 'prd', 'draft')",
        id=doc, t=tenant,
    )  # fmt: skip
    _basis(tenant, doc, "ENG-1", "verified")
    gone = _basis(
        tenant, doc, "ENG-2", "withdrawn", withdrawn_at=datetime(2026, 10, 20, 10, tzinfo=UTC)
    )
    _basis(tenant, doc, "ENG-3", "withdrawn", withdrawn_at=datetime(2026, 10, 20, 11, tzinfo=UTC))
    _run(
        "INSERT INTO audit_events (id, tenant_id, actor, action, entity, entity_id, data) "
        "VALUES (:id, :t, 'user:x', 'schedule_basis.withdrawn', 'schedule_basis', :e, "
        "CAST(:data AS jsonb))",
        id=uuid.uuid4(), t=tenant, e=gone,
        data=json.dumps({"reference": "ENG-2", "reason": "The team re-estimated"}),
    )  # fmt: skip
    before = _run(ROWS)

    command.upgrade(cfg, REVISION)
    assert _run(ROWS) == before
    assert _run("SELECT reference, withdrawn_reason FROM schedule_bases ORDER BY reference") == [
        ("ENG-1", None),
        ("ENG-2", "The team re-estimated"),
        ("ENG-3", None),
    ]
    _basis(tenant, doc, "ENG-4", "verified")
    _run(
        "UPDATE schedule_bases SET status = 'proposed', verified_at = NULL "
        "WHERE reference = 'ENG-4'"
    )
    _basis(tenant, doc, "ENG-5", "verified")
    _run(
        "UPDATE schedule_bases SET status = 'rejected', verified_at = NULL, "
        "rejected_reason = 'No' WHERE reference = 'ENG-5'"
    )
    with pytest.raises(IntegrityError):
        _run("UPDATE schedule_bases SET verified_at = NULL WHERE reference = 'ENG-1'")

    command.downgrade(cfg, PREVIOUS)
    assert _run(ROWS) == before
    columns = {
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'schedule_bases'"
        )
    }
    assert not columns & {"proposed_by", "note", "withdrawn_reason", "rejected_reason"}
    with pytest.raises(IntegrityError):
        _run("UPDATE schedule_bases SET status = 'proposed' WHERE reference = 'ENG-1'")

    command.upgrade(cfg, REVISION)
    assert _run(ROWS) == before
    assert _run("SELECT withdrawn_reason FROM schedule_bases WHERE reference = 'ENG-2'") == [
        ("The team re-estimated",)
    ]
