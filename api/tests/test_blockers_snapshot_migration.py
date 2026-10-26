"""Migration 0014_blockers_snapshot: one gate snapshot per readable legacy blocker.

Blockers recorded before gate snapshots existed get one ``legacy_snapshot`` event from
their current strategy, so reads never need to write one. Unreadable strategies get
none (they stay critical); blockers that already have a snapshot and plain constraints
are left alone. Downgrade removes exactly the events the upgrade wrote.

Sync tests on purpose: Alembic's env.py runs its own event loop. Own scratch database,
so it can run beside the other migration tests.
"""

import asyncio
import json
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0014_blockers_snapshot"
PREVIOUS = "0015_section_table_rows"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_blockers")
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


def test_the_migration_follows_0015_and_precedes_0014_intake():
    # Re-chained at the wave 1 integration: the blockers lane's 0014 comes after main's
    # 0014 chain (quality, usage_retry_at, trace).
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == "0015_section_table_rows"
    # v2-roadmap (wave 2) chains 0016_roadmap on it; 0016_refinement_batch (C1e) chains on
    # that, 0017_citation_source_oracle on that, then 0018_runtime_features,
    # 0019_citation_confidence, the intake lane's 0014_intake and the PRD review chain
    # (0014_review, 0014_member_disable, 0014_member_follow_up_retry) on that.
    assert script.get_heads() == ["0056_public_texts"]
    assert script.get_revision("0016_roadmap").down_revision == REVISION
    assert script.get_revision("0016_refinement_batch").down_revision == "0016_roadmap"
    assert (
        script.get_revision("0017_citation_source_oracle").down_revision == "0016_refinement_batch"
    )
    assert script.get_revision("0014_intake").down_revision == "0019_citation_confidence"
    assert script.get_revision("0014_review").down_revision == "0018_source_unavailable_items"
    drive = script.get_revision("0018_source_unavailable_items")
    assert drive.down_revision == "0017_source_config_version"
    assert script.get_revision("0015_specs").down_revision == "0020_feedback_author"


def _constraint(t, key: str, attrs: dict) -> uuid.UUID:
    entity_id = uuid.uuid4()
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, origin, status, attrs) "
        "VALUES (:id, :t, 'constraint', :k, :k, 'user', 'confirmed', CAST(:a AS jsonb))",
        id=entity_id,
        t=t,
        k=key,
        a=json.dumps(attrs),
    )
    return entity_id


def _snapshots(entity_id) -> list[tuple]:
    return _run(
        "SELECT kind, to_status, actor, data, tenant_id FROM blocker_resolution_events "
        "WHERE blocker_id = :b AND data ? 'gate' ORDER BY created_at",
        b=entity_id,
    )


def test_upgrade_snapshots_readable_legacy_blockers_and_downgrade_removes_them(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t = uuid.uuid4()
    doc_b, doc_a = (
        uuid.UUID("bbbbbbbb-0000-0000-0000-000000000000"),
        uuid.UUID("aaaaaaaa-0000-0000-0000-000000000000"),
    )
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    legacy = _constraint(
        t,
        "legacy",
        {
            "blocker": {
                "type": "soft",
                "severity": "low",
                "status": "resolved",
                "limit_kind": "capacity",
                "document_ids": [str(doc_b), str(doc_a)],
            }
        },
    )
    # Fields left to their defaults (severity medium, status open, no documents).
    defaults = _constraint(t, "defaults", {"blocker": {"type": "hard"}})
    garbled = _constraint(t, "garbled", {"blocker": {"type": "hard", "severity": "catastrophic"}})
    plain = _constraint(t, "plain", {})
    recorded = _constraint(t, "recorded", {"blocker": {"type": "hard", "severity": "critical"}})
    gate = {"type": "hard", "severity": "critical", "status": "open", "document_ids": []}
    _run(
        "INSERT INTO blocker_resolution_events (id, tenant_id, blocker_id, kind, to_status, "
        "actor, data, created_at) VALUES (gen_random_uuid(), :t, :b, 'status_changed', 'open', "
        "'user:x', CAST(:d AS jsonb), now() + interval '1 hour')",
        t=t,
        b=recorded,
        d=json.dumps({"gate": gate}),
    )
    # A legacy status event later than now: the snapshot still comes after it.
    _run(
        "INSERT INTO blocker_resolution_events (id, tenant_id, blocker_id, kind, to_status, "
        "actor, data, created_at) VALUES (gen_random_uuid(), :t, :b, 'status_changed', "
        "'resolved', 'user:x', '{}', now() + interval '1 day')",
        t=t,
        b=legacy,
    )

    command.upgrade(cfg, REVISION)
    rows = _snapshots(legacy)
    assert len(rows) == 1
    kind, to_status, actor, data, tenant = rows[0]
    assert (kind, to_status, actor, tenant) == ("status_changed", None, "system:migration", t)
    assert data["change"] == "legacy_snapshot"
    assert data["gate"] == {
        "type": "soft",
        "severity": "low",
        "status": "resolved",
        "document_ids": sorted([str(doc_a), str(doc_b)]),
    }
    order = _run(
        "SELECT data ? 'gate' FROM blocker_resolution_events WHERE blocker_id = :b "
        "ORDER BY created_at",
        b=legacy,
    )
    assert order == [(False,), (True,)]
    assert _snapshots(defaults)[0][3]["gate"] == {
        "type": "hard",
        "severity": "medium",
        "status": "open",
        "document_ids": [],
    }
    assert _snapshots(garbled) == []
    assert _run("SELECT count(*) FROM blocker_resolution_events WHERE blocker_id = :b", b=plain)[
        0
    ] == (0,)
    assert len(_snapshots(recorded)) == 1  # already had one: untouched

    # Running it again (down, up) does not duplicate anything.
    command.downgrade(cfg, PREVIOUS)
    assert _snapshots(legacy) == [] and _snapshots(defaults) == []
    assert len(_snapshots(recorded)) == 1
    assert _run(
        "SELECT count(*) FROM blocker_resolution_events WHERE blocker_id = :b", b=legacy
    ) == [(1,)]
    command.upgrade(cfg, REVISION)
    assert len(_snapshots(legacy)) == 1


def test_full_downgrade_and_upgrade_with_a_snapshot_written(scratch_db):
    # Production runs migrations at startup: the whole chain from 0013 goes up over
    # seeded blockers, and back down to 0013, without errors.
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    legacy = _constraint(t, "legacy", {"blocker": {"type": "hard", "severity": "high"}})
    command.upgrade(cfg, "head")
    assert len(_snapshots(legacy)) == 1
    command.downgrade(cfg, "0013")
    assert _snapshots(legacy) == []
    command.upgrade(cfg, "head")
    assert len(_snapshots(legacy)) == 1
