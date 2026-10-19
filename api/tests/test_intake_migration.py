"""Migration 0014_intake: additive on 0013, document jobs untouched, reversible.

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

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_intake")
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


def test_0014_intake_chains_on_the_foundation():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision("0014_intake").down_revision == "0013"


def test_upgrade_keeps_document_jobs_and_downgrade_reverses(scratch_db):
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
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, document_id, status) "
        "VALUES (gen_random_uuid(), :t, 'reporting', :d, 'queued')",
        t=t,
        d=doc,
    )

    command.upgrade(cfg, "0014_intake")
    assert _run("SELECT kind, document_id, intake_id FROM llm_jobs") == [("reporting", doc, None)]
    intake = uuid.uuid4()
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers retype addresses.')",
        i=intake,
        t=t,
    )
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, intake_id, status) "
        "VALUES (gen_random_uuid(), :t, 'intake_analysis', :i, 'queued')",
        t=t,
        i=intake,
    )
    _run(
        "INSERT INTO intake_proposals (id, tenant_id, intake_id, kind, title) "
        "VALUES (gen_random_uuid(), :t, :i, 'research_run', 'Research the metric')",
        t=t,
        i=intake,
    )
    # A job belongs to a document or an intake; a proposal kind is checked.
    with pytest.raises(Exception, match="ck_llm_jobs_subject"):
        _run(
            "INSERT INTO llm_jobs (id, tenant_id, kind, status) "
            "VALUES (gen_random_uuid(), :t, 'reporting', 'queued')",
            t=t,
        )
    with pytest.raises(Exception, match="ck_intake_proposals_kind"):
        _run(
            "INSERT INTO intake_proposals (id, tenant_id, intake_id, kind, title) "
            "VALUES (gen_random_uuid(), :t, :i, 'run_now', 'x')",
            t=t,
            i=intake,
        )

    command.downgrade(cfg, "0013")
    assert _run("SELECT kind FROM llm_jobs") == [("reporting",)]
    with pytest.raises(Exception, match="ck_llm_jobs_kind"):
        _run(
            "INSERT INTO llm_jobs (id, tenant_id, kind, document_id, status) "
            "VALUES (gen_random_uuid(), :t, 'intake_analysis', :d, 'queued')",
            t=t,
            d=doc,
        )
    command.upgrade(cfg, "0014_intake")
    assert _run("SELECT count(*) FROM intake_proposals") == [(0,)]


def test_rule_made_gaps_are_keyed_by_category_not_by_text(scratch_db):
    """Round 3 (S6): a rule-made gap carries its category key, backfilled from the
    statements as they stand at this revision; model and person gaps carry none."""
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, intake, person = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers retype addresses.')",
        i=intake,
        t=t,
    )
    rows = {
        "rule": ("ownership", "No team or person owns the outcome.", None),
        "model": ("ownership", "Is the checkout team staffed for this?", None),
        "person": ("ownership", "No team or person owns the outcome.", person),
    }
    ids = {}
    for name, (category, statement, created_by) in rows.items():
        ids[name] = uuid.uuid4()
        _run(
            "INSERT INTO knowledge_gaps (id, tenant_id, intake_id, category, statement, "
            "impact, importance, created_by) VALUES (:g, :t, :i, :c, :s, '{}', 'high', :by)",
            g=ids[name], t=t, i=intake, c=category, s=statement, by=created_by,
        )  # fmt: skip
    command.upgrade(cfg, "0014_intake")
    keys = dict(_run("SELECT id, rule_key FROM knowledge_gaps"))
    assert keys == {ids["rule"]: "ownership", ids["model"]: None, ids["person"]: None}
    command.downgrade(cfg, "0013")
    columns = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_gaps'"
    )
    assert ("rule_key",) not in columns
