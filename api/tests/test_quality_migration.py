"""Migration 0014_quality: outcome records, learnings and the quality_review job kind.

Additive and reversible. Sync tests on purpose (Alembic's env.py runs its own loop), on
their own scratch database.
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

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_quality")
    .render_as_string(hide_password=False)
)
TABLES = {"outcome_records", "quality_learnings"}


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


def _tables() -> set[str]:
    return {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_0014_quality_sits_on_the_foundation():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision("0014_quality").down_revision == "0013"


def _job(t: uuid.UUID, d: uuid.UUID, kind: str) -> None:
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, document_id, status) "
        "VALUES (gen_random_uuid(), :t, :k, :d, 'queued')",
        t=t,
        k=kind,
        d=d,
    )


def test_upgrade_adds_tables_and_the_job_kind_and_downgrade_reverses(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, doc = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'legacy', 'Legacy', 'draft')",
        d=doc,
        t=t,
    )
    _job(t, doc, "reporting")
    with pytest.raises(IntegrityError):
        _job(t, doc, "quality_review")

    command.upgrade(cfg, "0014_quality")
    assert TABLES <= _tables()
    _job(t, doc, "quality_review")
    goal = uuid.uuid4()
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, origin, status) "
        "VALUES (:g, :t, 'goal', 'g', 'Goal', 'user', 'confirmed')",
        g=goal,
        t=t,
    )
    _run(
        "INSERT INTO outcome_records (id, tenant_id, goal_id, title, prediction, status) "
        "VALUES (gen_random_uuid(), :t, :g, 'Outcome', '{}', 'tracking')",
        t=t,
        g=goal,
    )
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO quality_learnings (id, tenant_id, statement, applies_to, target, "
            "direction, weight, status) VALUES (gen_random_uuid(), :t, 's', 'module', 'm', "
            "'recommend_more', 7, 'active')",
            t=t,
        )

    command.downgrade(cfg, "0013")
    assert not TABLES & _tables()
    # The quality_review jobs go with the kind; the others stay.
    assert _run("SELECT kind FROM llm_jobs") == [("reporting",)]
    with pytest.raises(IntegrityError):
        _job(t, doc, "quality_review")
