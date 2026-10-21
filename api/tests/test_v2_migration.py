"""Migration 0013 (v2 foundation): additive, legacy data untouched, reversible.

Sync tests on purpose: Alembic's env.py runs its own event loop. Own scratch database,
so it can run beside tests/test_migrations.py.
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
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_v2")
    .render_as_string(hide_password=False)
)
V2_TABLES = {
    "module_definitions",
    "module_versions",
    "template_module_assignments",
    "document_compositions",
    "composition_revisions",
    "product_intakes",
    "knowledge_gaps",
    "stakeholder_questions",
    "stakeholder_answers",
    "assumption_decisions",
    "blocker_options",
    "feasibility_experiments",
    "blocker_resolution_events",
    "change_events",
    "document_section_links",
    "artifact_dependencies",
    "evaluation_reports",
    "evaluation_findings",
    "artifact_requests",
    "artifact_versions",
    "artifact_outputs",
    "artifact_review_events",
}


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


def _tables() -> set[str]:
    return {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_0013_follows_0012_and_the_0014_lanes_chain_on_it():
    # Lanes add 0014_<lane> on top of 0013 (waves.md); the integrator re-chains them in
    # merge order so the chain stays linear, one head.
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0020_strategy"]
    assert script.get_revision("0013").down_revision == "0012"
    assert script.get_revision("0014_quality").down_revision == "0013"
    assert script.get_revision("0014_usage_retry_at").down_revision == "0014_quality"
    assert script.get_revision("0014_trace").down_revision == "0014_usage_retry_at"
    assert script.get_revision("0015_section_table_rows").down_revision == "0014_trace"
    assert script.get_revision("0014_blockers_snapshot").down_revision == "0015_section_table_rows"
    assert script.get_revision("0016_roadmap").down_revision == "0014_blockers_snapshot"
    assert script.get_revision("0016_refinement_batch").down_revision == "0016_roadmap"
    assert script.get_revision("0017_citation_source_oracle").down_revision == (
        "0016_refinement_batch"
    )
    assert script.get_revision("0014_intake").down_revision == "0019_citation_confidence"
    assert script.get_revision("0014_review").down_revision == "0018_source_unavailable_items"
    assert script.get_revision("0014_member_disable").down_revision == "0014_review"
    assert script.get_revision("0014_member_follow_up_retry").down_revision == "0014_member_disable"


def test_upgrade_keeps_legacy_data_and_downgrade_reverses(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0012")
    t, doc, ver = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'legacy', 'Legacy', 'approved')",
        d=doc,
        t=t,
    )
    _run(
        "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
        "content_hash, approved_at) VALUES (:v, :t, :d, 1, '# L {#l}', 'h1', now())",
        v=ver,
        t=t,
        d=doc,
    )
    _run(
        "INSERT INTO section_reviews (id, tenant_id, version_id, section_key, verdict) "
        "VALUES (gen_random_uuid(), :t, :v, 'l', 'approved')",
        t=t,
        v=ver,
    )
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, origin, status) "
        "VALUES (gen_random_uuid(), :t, 'constraint', 'quota', 'Quota', 'user', 'confirmed')",
        t=t,
    )

    command.upgrade(cfg, "head")
    assert V2_TABLES <= _tables()
    # Legacy rows untouched; the new review-correctness columns are null on them.
    assert _run("SELECT section_hash FROM section_reviews") == [(None,)]
    assert _run("SELECT approved_by, base_number, markdown FROM document_versions") == [
        (None, None, "# L {#l}")
    ]
    # The new graph types are accepted, and the v2 tables take rows.
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, origin, status) "
        "VALUES (gen_random_uuid(), :t, 'risk', 'r', 'Risk', 'user', 'proposed')",
        t=t,
    )
    _run(
        "INSERT INTO edges (id, tenant_id, src_id, dst_id, type, origin, status) "
        "SELECT gen_random_uuid(), :t, r.id, c.id, 'affects', 'user', 'proposed' FROM entities r, "
        "entities c WHERE r.type = 'risk' AND c.type = 'constraint'",
        t=t,
    )
    _run(
        "INSERT INTO document_compositions (id, tenant_id, document_id) "
        "VALUES (gen_random_uuid(), :t, :d)",
        t=t,
        d=doc,
    )
    _run(
        "INSERT INTO blocker_options (id, tenant_id, blocker_id, title, approach) "
        "SELECT gen_random_uuid(), :t, id, 'Queue', 'operations' FROM entities "
        "WHERE type = 'constraint'",
        t=t,
    )
    assert _run("SELECT compliance, status, lock_version FROM blocker_options") == [
        ("needs_review", "proposed", 1)
    ]

    command.downgrade(cfg, "0012")
    assert not (V2_TABLES & _tables())
    # New-type graph rows are removed so the old type constraints hold again.
    assert _run("SELECT type FROM entities") == [("constraint",)]
    assert _run("SELECT count(*) FROM edges") == [(0,)]
    assert _run("SELECT count(*) FROM section_reviews") == [(1,)]
    with pytest.raises(Exception, match="ck_entities_type"):
        _run(
            "INSERT INTO entities (id, tenant_id, type, key, title, origin, status) "
            "VALUES (gen_random_uuid(), :t, 'risk', 'r2', 'Risk', 'user', 'proposed')",
            t=t,
        )

    command.upgrade(cfg, "head")
    assert V2_TABLES <= _tables()
    assert _run("SELECT slug FROM documents") == [("legacy",)]
