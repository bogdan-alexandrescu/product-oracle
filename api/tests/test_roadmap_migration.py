"""Migration 0016_roadmap (lane v2-roadmap, CR-11): additive, reversible, legacy
roadmaps untouched, and change_events accepts the product_track subject.

Sync tests on purpose: Alembic's env.py runs its own event loop. Own scratch database.
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
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_roadmap")
    .render_as_string(hide_password=False)
)
REVISION = "0016_roadmap"
TABLES = {
    "product_tracks",
    "track_milestones",
    "schedule_bases",
    "tracker_records",
    "roadmap_items",
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


def _tables() -> set[str]:
    return {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_0016_roadmap_follows_the_wave_1_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == "0014_blockers_snapshot"
    assert script.get_heads() == [REVISION]


def _event(tenant: uuid.UUID, subject: str) -> None:
    _run(
        "INSERT INTO change_events (id, tenant_id, subject_kind, cause, actor, data, handled_by) "
        "VALUES (:id, :t, :s, 'track_monitored', 'system', '{}', '{}')",
        id=uuid.uuid4(), t=tenant, s=subject,
    )  # fmt: skip


def test_upgrade_adds_tables_and_the_subject_and_downgrade_reverses(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0014_blockers_snapshot")
    tenant, doc = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, kind, status) "
        "VALUES (:id, :t, 'example-roadmap', 'Example roadmap', 'roadmap', 'draft')",
        id=doc, t=tenant,
    )  # fmt: skip
    assert not TABLES & _tables()
    with pytest.raises(IntegrityError):
        _event(tenant, "product_track")

    command.upgrade(cfg, REVISION)
    assert TABLES <= _tables()
    _event(tenant, "product_track")
    # A legacy roadmap is untouched and has no items until a run or a person adds them.
    assert _run("SELECT slug FROM documents") == [("example-roadmap",)]
    assert _run("SELECT count(*) FROM roadmap_items") == [(0,)]
    # No date without a basis, at the database too.
    track = uuid.uuid4()
    _run(
        "INSERT INTO product_tracks (id, tenant_id, prd_document_id, title) "
        "VALUES (:id, :t, :d, 'Example')",
        id=track, t=tenant, d=doc,
    )  # fmt: skip
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO track_milestones (id, tenant_id, track_id, name, target_date) "
            "VALUES (:id, :t, :k, 'Beta', '2027-01-01')",
            id=uuid.uuid4(), t=tenant, k=track,
        )  # fmt: skip

    command.downgrade(cfg, "0014_blockers_snapshot")
    assert not TABLES & _tables()
    assert _run("SELECT count(*) FROM change_events WHERE subject_kind = 'product_track'") == [(0,)]
    assert _run("SELECT slug FROM documents") == [("example-roadmap",)]
    command.upgrade(cfg, REVISION)
