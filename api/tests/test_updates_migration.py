"""Migration 0022_updates (H8 Board and investor drafts): the update kind on documents,
templates and themes, the update_draft flow and update_review checkpoint, and
documents.visibility. The downgrade refuses while update documents exist, unless
ORACLE_DOWNGRADE_DROP_UPDATES=1.

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

REVISION = "0022_updates"
PREVIOUS = "0022_checkpoint_actions"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_updates")
    .render_as_string(hide_password=False)
)
CHECKS = {
    "ck_documents_kind": ("update",),
    "ck_templates_kind": ("update",),
    "ck_themes_kind": ("update",),
    "ck_runs_flow": ("update_draft",),
    "ck_checkpoints_kind": ("update_review",),
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
    return _run("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :n", n=name)[
        0
    ][0]


def _column(name: str) -> bool:
    return bool(
        _run(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'documents' AND column_name = :n",
            n=name,
        )
    )


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_mains_head():
    """protects=one head, on main's head at build time; fails_when=a second head or a
    fixed number; no_claim=later lanes' re-chaining."""
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    # 0023_source_partial_sync (#249) chains on it, then 0023_intake_brief_fields (C4)
    # and 0024_segment_skipped; one head.
    assert script.get_heads() == ["0081_simple_visuals"]
    assert script.get_revision("0023_source_partial_sync").down_revision == REVISION


def test_upgrade_adds_the_kind_and_visibility_and_downgrade_removes_them(scratch_db, monkeypatch):
    """protects=the five checks gain only this lane's values (others kept), visibility
    defaults to company for existing documents and allows only company or approvers, and
    the downgrade refuses while update documents exist unless told to drop them, then
    narrows the checks and drops the column; fails_when=a value is missing, another lane's
    value is dropped, an existing document is hidden, or the downgrade loses documents
    silently; no_claim=data written by the app."""
    monkeypatch.delenv("ORACLE_DOWNGRADE_DROP_UPDATES", raising=False)
    command.upgrade(_cfg(), PREVIOUS)
    before = {name: _definition(name) for name in CHECKS}
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status, kind) "
        "VALUES (:id, :t, 'a-prd', 'A PRD', 'draft', 'prd')",
        id=uuid.uuid4(), t=tenant,
    )  # fmt: skip
    assert not _column("visibility")

    command.upgrade(_cfg(), REVISION)
    for name, values in CHECKS.items():
        after = _definition(name)
        for v in values:
            assert f"'{v}'" in after, (name, v)
        for kept in ("prd", "roadmap", "strategy", "vision", "feedback_loop", "strategy_draft",
                     "prd_review", "launch_review"):  # fmt: skip
            if f"'{kept}'" in before[name]:
                assert f"'{kept}'" in after, (name, kept)
    assert _run("SELECT visibility FROM documents") == [("company",)]
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status, kind, visibility) "
        "VALUES (:id, :t, 'investor-update', 'Investor update', 'draft', 'update', 'approvers')",
        id=uuid.uuid4(), t=tenant,
    )  # fmt: skip
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO documents (id, tenant_id, slug, title, status, kind, visibility) "
            "VALUES (:id, :t, 'x', 'x', 'draft', 'prd', 'secret')",
            id=uuid.uuid4(), t=tenant,
        )  # fmt: skip
    assert _run("SELECT indexname FROM pg_indexes WHERE indexname = 'ix_documents_visibility'") == [
        ("ix_documents_visibility",)
    ]

    with pytest.raises(RuntimeError, match="ORACLE_DOWNGRADE_DROP_UPDATES"):
        command.downgrade(_cfg(), PREVIOUS)
    assert _column("visibility")

    monkeypatch.setenv("ORACLE_DOWNGRADE_DROP_UPDATES", "1")
    command.downgrade(_cfg(), PREVIOUS)
    assert not _column("visibility")
    assert _run("SELECT slug FROM documents") == [("a-prd",)]
    for name in CHECKS:
        assert _definition(name) == before[name], name
