"""Migration 0020_prd_scopes (C6 Feature set and PRD scope): ``prd_scopes`` and
``prd_scope_items`` on a seeded database. Upgrade creates both with their checks (status,
kind, the per-kind decision) and keeps the existing rows; downgrade drops both.

Test card: protects=the scope tables apply to a database with runs, checkpoints and
documents, enforce their checks, and roll back cleanly; fails_when=the upgrade or the
downgrade fails, a check lets a wrong decision through, or the chain has two heads;
no_claim=the application's use of the tables (tests/test_prd_scope.py).

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

REVISION = "0020_prd_scopes"
PREVIOUS = "0020_decisions"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_scopes")
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


def _exists(table: str) -> bool:
    return _run(f"SELECT to_regclass('public.{table}') IS NOT NULL")[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_mains_head_and_is_the_only_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0071_simple_roadmap_dates"]


def test_upgrade_and_downgrade_on_a_seeded_database(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t, run, cp, doc = (uuid.uuid4() for _ in range(4))
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (:r, :t, 'baseline_to_prd', 'awaiting_checkpoint')",
        r=run,
        t=t,
    )
    _run(
        "INSERT INTO checkpoints (id, tenant_id, run_id, kind, status) "
        "VALUES (:c, :t, :r, 'feature_set', 'pending')",
        c=cp,
        t=t,
        r=run,
    )
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, kind, status) "
        "VALUES (:d, :t, 'saved-addresses', 'Saved addresses', 'prd', 'draft')",
        d=doc,
        t=t,
    )
    assert not _exists("prd_scopes")

    command.upgrade(cfg, REVISION)
    assert _exists("prd_scopes") and _exists("prd_scope_items")
    # Existing rows are untouched.
    assert _run("SELECT status FROM checkpoints WHERE id = :c", c=cp) == [("pending",)]
    scope, feat = uuid.uuid4(), uuid.uuid4()
    _run(
        "INSERT INTO prd_scopes (id, tenant_id, run_id, segment_seq, attempt, checkpoint_id, "
        "document_id) VALUES (:s, :t, :r, 2, 1, :c, :d)",
        s=scope,
        t=t,
        r=run,
        c=cp,
        d=doc,
    )
    row = _run("SELECT status, check_result, lock_version FROM prd_scopes WHERE id = :s", s=scope)
    assert row == [("proposed", {}, 1)]
    _run(
        "INSERT INTO prd_scope_items (id, tenant_id, scope_id, kind, key, title, decision, "
        "position) VALUES (:i, :t, :s, 'feature', 'saved-addresses', 'Saved addresses', "
        "'include', 0)",
        i=feat,
        t=t,
        s=scope,
    )
    _run(
        "INSERT INTO prd_scope_items (id, tenant_id, scope_id, kind, parent_id, key, title, "
        "text, decision, position) VALUES (:i, :t, :s, 'requirement', :p, 'pick', 'Pick', "
        "'The buyer picks', 'keep', 0)",
        i=uuid.uuid4(),
        t=t,
        s=scope,
        p=feat,
    )
    defaults = _run(
        "SELECT acceptance, goals, depends_on, blocker_keys, evidence_ids, flags, origin "
        "FROM prd_scope_items WHERE id = :i",
        i=feat,
    )
    assert defaults == [([], [], [], [], [], [], "agent")]
    # A feature is included, excluded or deferred; a requirement is kept or cut.
    for kind, decision in (("feature", "keep"), ("requirement", "include"), ("feature", "x")):
        with pytest.raises(IntegrityError):
            _run(
                "INSERT INTO prd_scope_items (id, tenant_id, scope_id, kind, key, title, "
                "decision, position) VALUES (:i, :t, :s, :k, :key, 'T', :d, 1)",
                i=uuid.uuid4(),
                t=t,
                s=scope,
                k=kind,
                key=f"k-{uuid.uuid4().hex[:6]}",
                d=decision,
            )
    with pytest.raises(IntegrityError):
        _run("UPDATE prd_scopes SET status = 'done' WHERE id = :s", s=scope)
    # One scope per run, segment and attempt.
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO prd_scopes (id, tenant_id, run_id, segment_seq, attempt) "
            "VALUES (:s, :t, :r, 2, 1)",
            s=uuid.uuid4(),
            t=t,
            r=run,
        )
    # A deleted checkpoint or document leaves the scope; a deleted run takes it along.
    _run("DELETE FROM checkpoints WHERE id = :c", c=cp)
    _run("DELETE FROM documents WHERE id = :d", d=doc)
    assert _run("SELECT checkpoint_id, document_id FROM prd_scopes WHERE id = :s", s=scope) == [
        (None, None)
    ]
    _run("DELETE FROM runs WHERE id = :r", r=run)
    assert _run("SELECT count(*) FROM prd_scope_items")[0][0] == 0

    command.downgrade(cfg, PREVIOUS)
    assert not _exists("prd_scopes") and not _exists("prd_scope_items")
    command.upgrade(cfg, "head")
    assert _exists("prd_scopes")
