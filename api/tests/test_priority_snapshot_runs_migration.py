"""Migration 0022_priority_snapshot_runs: priority snapshots of a run (C8).

Adds ``status`` (existing rows become ``saved``), the run, checkpoint, document and PRD
scope links, ``check_result`` and ``decided_by/at``; the downgrade deletes proposed and
discarded rows and drops the columns.

Test card: protects=existing snapshots stay readable as saved, and the downgrade leaves
saved ones as plain snapshots; fails_when=an existing row is not saved, a column or the
index is missing, or the downgrade keeps an unapproved order; no_claim=the data a run
writes.

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

REVISION = "0022_priority_snapshot_runs"
PREVIOUS = "0022_discussions"
COLUMNS = [
    "check_result",
    "checkpoint_id",
    "decided_at",
    "decided_by",
    "document_id",
    "run_id",
    "scope_id",
    "status",
]
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_priority_runs")
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
        async with engine.begin() as conn:
            result = await conn.execute(text(sql), params)
            rows = result.all() if result.returns_rows else None
        await engine.dispose()
        return rows

    return asyncio.run(go())


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def _columns() -> list[str]:
    return sorted(
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'priority_snapshots' AND column_name = ANY(:names)",
            names=COLUMNS,
        )
    )


def test_the_chain_ends_here_after_feedback_agent_staging():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0030_basis_verification"]
    assert script.get_revision(REVISION).down_revision == PREVIOUS


def test_existing_rows_become_saved_and_downgrade_drops_unapproved_orders(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant, before = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run(
        "INSERT INTO priority_snapshots (id, tenant_id, method) VALUES (:i, :t, 'goal_weighted')",
        i=before,
        t=tenant,
    )

    command.upgrade(cfg, REVISION)

    assert _columns() == COLUMNS
    assert _run("SELECT status, run_id, check_result FROM priority_snapshots") == [
        ("saved", None, {})
    ]
    assert _run("SELECT to_regclass('public.ix_priority_snapshots_document') IS NOT NULL") == [
        (True,)
    ]
    run, proposed, discarded = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (:r, :t, 'baseline_to_prd', 'awaiting_checkpoint')",
        r=run,
        t=tenant,
    )
    for sid, status in ((proposed, "proposed"), (discarded, "discarded")):
        _run(
            "INSERT INTO priority_snapshots (id, tenant_id, method, status, run_id) "
            "VALUES (:i, :t, 'goal_weighted', :s, :r)",
            i=sid,
            t=tenant,
            s=status,
            r=run,
        )
    with pytest.raises(Exception, match="ck_priority_snapshots_status"):
        _run(
            "INSERT INTO priority_snapshots (id, tenant_id, method, status) "
            "VALUES (:i, :t, 'goal_weighted', 'approved')",
            i=uuid.uuid4(),
            t=tenant,
        )
    # A deleted run leaves its saved order as a plain snapshot.
    _run("UPDATE priority_snapshots SET run_id = :r WHERE id = :i", r=run, i=before)
    _run("DELETE FROM priority_snapshots WHERE id IN (:p, :d)", p=proposed, d=discarded)
    _run("DELETE FROM runs WHERE id = :r", r=run)
    assert _run("SELECT id, run_id FROM priority_snapshots") == [(before, None)]
    for sid, status in ((proposed, "proposed"), (discarded, "discarded")):
        _run(
            "INSERT INTO priority_snapshots (id, tenant_id, method, status) "
            "VALUES (:i, :t, 'goal_weighted', :s)",
            i=sid,
            t=tenant,
            s=status,
        )

    command.downgrade(cfg, PREVIOUS)
    assert _columns() == []
    assert _run("SELECT id FROM priority_snapshots") == [(before,)]
