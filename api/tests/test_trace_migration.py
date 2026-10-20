"""Migration 0014_trace: a dependency on a deleted entity survives (SET NULL plus a
snapshot), legacy rows are untouched, and the downgrade restores the cascade.

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

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
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_trace")
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


def test_0014_trace_follows_0014_usage_retry_at():
    # Re-chained at the wave 1 integration, part 2: 0014_* in merge order, one head.
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision("0014_trace").down_revision == "0014_usage_retry_at"
    assert script.get_heads() == ["0014_intake"]


def _seed(t, doc, ver, ent):
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'prd', 'PRD', 'draft')",
        d=doc, t=t,
    )  # fmt: skip
    _run(
        "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
        "content_hash) VALUES (:v, :t, :d, 1, '# P {#p}', 'h1')",
        v=ver, t=t, d=doc,
    )  # fmt: skip
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, origin, status) "
        "VALUES (:e, :t, 'requirement', 'r1', 'R1', 'user', 'confirmed')",
        e=ent, t=t,
    )  # fmt: skip
    _run(
        "INSERT INTO artifact_dependencies (id, tenant_id, document_version_id, "
        "upstream_entity_id, freshness) VALUES (gen_random_uuid(), :t, :a, :e, "
        "'potentially_stale')",
        t=t, a=ver, e=ent,
    )  # fmt: skip


def test_upgrade_keeps_rows_and_a_deleted_entity_leaves_its_dependency(scratch_db):
    cfg = _cfg()
    # The live database is at 0014_usage_retry_at when 0014_trace first runs.
    command.upgrade(cfg, "0014_usage_retry_at")
    t, doc, ver, ent = (uuid.uuid4() for _ in range(4))
    _seed(t, doc, ver, ent)
    av = ver

    command.upgrade(cfg, "0014_trace")
    assert _run("SELECT upstream_entity_id, upstream_snapshot FROM artifact_dependencies") == [
        (ent, None)
    ]
    _run(
        "UPDATE artifact_dependencies SET upstream_snapshot = "
        '\'{"key": "r1"}\'::jsonb, upstream_deleted_at = now()'
    )
    _run("DELETE FROM entities WHERE id = :e", e=ent)
    assert _run(
        "SELECT upstream_entity_id, upstream_snapshot->>'key', freshness FROM artifact_dependencies"
    ) == [(None, "r1", "potentially_stale")]
    # Without an entity, version or snapshot a dependency points at nothing: refused.
    with pytest.raises(Exception, match="ck_artifact_dependencies_upstream"):
        _run(
            "INSERT INTO artifact_dependencies (id, tenant_id, document_version_id) "
            "VALUES (gen_random_uuid(), :t, :a)",
            t=t, a=av,
        )  # fmt: skip

    command.downgrade(cfg, "0013")
    # The orphaned row goes (the old schema would have cascaded it); the cascade is back.
    assert _run("SELECT count(*) FROM artifact_dependencies") == [(0,)]
    ent2 = uuid.uuid4()
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, origin, status) "
        "VALUES (:e, :t, 'requirement', 'r2', 'R2', 'user', 'confirmed')",
        e=ent2, t=t,
    )  # fmt: skip
    _run(
        "INSERT INTO artifact_dependencies (id, tenant_id, document_version_id, "
        "upstream_entity_id) VALUES (gen_random_uuid(), :t, :a, :e)",
        t=t, a=av, e=ent2,
    )  # fmt: skip
    _run("DELETE FROM entities WHERE id = :e", e=ent2)
    assert _run("SELECT count(*) FROM artifact_dependencies") == [(0,)]
    command.upgrade(cfg, "head")


def _link_item_on_delete() -> str:
    (row,) = _run(
        "SELECT confdeltype::text FROM pg_constraint "
        "WHERE conname = 'fk_document_section_links_source_item_id_source_items'"
    )
    return row[0]


def test_a_section_links_source_item_stays_set_null(scratch_db):
    """A link that names an entity too must outlive its source item: the delete paths
    null the reference (or delete a link left with no target) before the item goes."""
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    assert _link_item_on_delete() == "n"
    command.upgrade(cfg, "0014_trace")
    assert _link_item_on_delete() == "n"
    command.downgrade(cfg, "0013")
    assert _link_item_on_delete() == "n"
    command.upgrade(cfg, "head")
    assert _link_item_on_delete() == "n"
