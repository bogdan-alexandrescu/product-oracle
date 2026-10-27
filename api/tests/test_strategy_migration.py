"""Migration 0020_strategy (H4 Strategy and vision): the vision and strategy kinds, the
strategy_choice entity type, the strategy_draft flow and strategy_review checkpoint, and
the strategy_findings and strategy_checks tables. The downgrade refuses while vision or
strategy documents exist, unless ORACLE_DOWNGRADE_DROP_STRATEGY=1.

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

REVISION = "0020_strategy"
PREVIOUS = "0020_question_subjects"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_strategy")
    .render_as_string(hide_password=False)
)
CHECKS = {
    "ck_documents_kind": ("vision", "strategy"),
    "ck_templates_kind": ("vision", "strategy"),
    "ck_themes_kind": ("vision", "strategy"),
    "ck_entities_type": ("strategy_choice",),
    "ck_runs_flow": ("strategy_draft",),
    "ck_checkpoints_kind": ("strategy_review",),
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


def _table(name: str) -> bool:
    return _run("SELECT to_regclass(:n) IS NOT NULL", n=f"public.{name}")[0][0]


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
    assert script.get_heads() == ["0081_simple_chat_cards"]


def _tenant() -> uuid.UUID:
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    return tenant


def test_upgrade_widens_the_checks_and_downgrade_narrows_them(scratch_db, monkeypatch):
    """protects=the six checks gain only this lane's values (others kept), the tables
    come and go, and the downgrade refuses while strategy documents exist unless told to
    drop them; fails_when=a value is missing, another lane's value is dropped, or the
    downgrade loses documents silently; no_claim=data written by the app."""
    monkeypatch.delenv("ORACLE_DOWNGRADE_DROP_STRATEGY", raising=False)
    command.upgrade(_cfg(), PREVIOUS)
    before = {name: _definition(name) for name in CHECKS}
    assert not _table("strategy_findings")
    command.upgrade(_cfg(), REVISION)
    for name, values in CHECKS.items():
        after = _definition(name)
        for v in values:
            assert f"'{v}'" in after, (name, v)
        for kept in ("prd", "roadmap", "goal", "feedback_loop", "prd_review"):
            if f"'{kept}'" in before[name]:
                assert f"'{kept}'" in after, (name, kept)
    assert _table("strategy_findings") and _table("strategy_checks")

    tenant = _tenant()
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status, kind) "
        "VALUES (:id, :t, 'product-strategy', 'Product strategy', 'draft', 'strategy')",
        id=uuid.uuid4(), t=tenant,
    )  # fmt: skip
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, status, origin) "
        "VALUES (:id, :t, 'strategy_choice', 'product-strategy-one', 'One', 'confirmed', 'user')",
        id=uuid.uuid4(), t=tenant,
    )  # fmt: skip
    _run(
        "INSERT INTO strategy_findings (id, tenant_id, kind, severity, subject_kind, subject_ref)"
        " VALUES (:id, :t, 'no_strategy', 'info', 'document', 'strategy')",
        id=uuid.uuid4(), t=tenant,
    )  # fmt: skip
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO strategy_findings (id, tenant_id, kind, severity, subject_kind, "
            "subject_ref) VALUES (:id, :t, 'bogus', 'info', 'document', 'x')",
            id=uuid.uuid4(), t=tenant,
        )  # fmt: skip
    with pytest.raises(IntegrityError):
        # One finding per subject, a null subject included.
        _run(
            "INSERT INTO strategy_findings (id, tenant_id, kind, severity, subject_kind, "
            "subject_ref) VALUES (:id, :t, 'no_strategy', 'info', 'document', 'strategy')",
            id=uuid.uuid4(), t=tenant,
        )  # fmt: skip

    with pytest.raises(RuntimeError, match="ORACLE_DOWNGRADE_DROP_STRATEGY"):
        command.downgrade(_cfg(), PREVIOUS)
    assert _table("strategy_findings")

    monkeypatch.setenv("ORACLE_DOWNGRADE_DROP_STRATEGY", "1")
    command.downgrade(_cfg(), PREVIOUS)
    assert not _table("strategy_findings") and not _table("strategy_checks")
    assert _run("SELECT count(*) FROM documents")[0][0] == 0
    assert _run("SELECT count(*) FROM entities")[0][0] == 0
    for name in CHECKS:
        assert _definition(name) == before[name], name
