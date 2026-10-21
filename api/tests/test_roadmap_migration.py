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
    # 0016_refinement_batch (C1e) chains on it, 0017_citation_source_oracle on that, then
    # 0018_runtime_features, 0019_citation_confidence, 0014_intake and the PRD review chain
    # (0014_review ... 0014_member_follow_up_retry); still a single head.
    assert script.get_heads() == ["0014_member_follow_up_retry"]
    assert script.get_revision("0016_refinement_batch").down_revision == REVISION
    assert script.get_revision("0017_citation_source_oracle").down_revision == (
        "0016_refinement_batch"
    )
    assert script.get_revision("0014_intake").down_revision == "0019_citation_confidence"
    assert script.get_revision("0014_review").down_revision == "0017_source_config_version"


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


def _subjects() -> set[str]:
    (row,) = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'ck_change_events_subject_kind'"
    )
    import re

    return set(re.findall(r"'([^']*)'", row[0]))


def _allow_member() -> None:
    """What another lane's migration (PR #69's 0014_review) does: one more subject."""
    values = ", ".join(f"'{v}'" for v in sorted(_subjects() | {"member"}))
    _run("ALTER TABLE change_events DROP CONSTRAINT ck_change_events_subject_kind")
    _run(
        "ALTER TABLE change_events ADD CONSTRAINT ck_change_events_subject_kind "
        f"CHECK (subject_kind IN ({values}))"
    )


def test_the_subject_check_keeps_other_lanes_values(scratch_db):
    """0016 adds only product_track to whatever the check holds at upgrade time and
    removes only product_track at downgrade: another lane's subject survives both."""
    cfg = _cfg()
    command.upgrade(cfg, "0014_blockers_snapshot")
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    before = _subjects()
    _allow_member()
    _event(tenant, "member")

    command.upgrade(cfg, REVISION)
    assert _subjects() == before | {"member", "product_track"}
    _event(tenant, "member")
    _event(tenant, "product_track")

    command.downgrade(cfg, "0014_blockers_snapshot")
    assert _subjects() == before | {"member"}
    _event(tenant, "member")
    with pytest.raises(IntegrityError):
        _event(tenant, "product_track")

    # The other order: the other lane's value lands after 0016, then 0016 is undone.
    _run("DELETE FROM change_events WHERE subject_kind = 'member'")
    _run("ALTER TABLE change_events DROP CONSTRAINT ck_change_events_subject_kind")
    _run(
        "ALTER TABLE change_events ADD CONSTRAINT ck_change_events_subject_kind "
        "CHECK (subject_kind IN (" + ", ".join(f"'{v}'" for v in sorted(before)) + "))"
    )
    command.upgrade(cfg, REVISION)
    _allow_member()
    command.downgrade(cfg, "0014_blockers_snapshot")
    assert _subjects() == before | {"member"}
    command.upgrade(cfg, REVISION)
    assert _subjects() == before | {"member", "product_track"}


def test_a_product_track_event_survives_upgrade_head_and_a_round_trip(scratch_db):
    """The guard for every migration after 0016 (PR #84's 0014_review among them): with a
    product_track change event in the table, ``upgrade head`` must keep the subject (a
    migration that rebuilds the check from a fixed list fails here), and a downgrade to
    0016 and back to head must too."""
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _event(tenant, "product_track")

    command.upgrade(cfg, "head")
    assert "product_track" in _subjects()
    command.downgrade(cfg, REVISION)
    assert "product_track" in _subjects()
    command.upgrade(cfg, "head")
    assert "product_track" in _subjects()
    assert _run("SELECT count(*) FROM change_events WHERE subject_kind = 'product_track'") == [(1,)]
    _event(tenant, "product_track")

    # Below 0016 the events go with the subject, and head brings the subject back.
    command.downgrade(cfg, "0014_blockers_snapshot")
    assert "product_track" not in _subjects()
    command.upgrade(cfg, "head")
    _event(tenant, "product_track")


def test_the_migration_imports_no_application_code():
    """A migration runs as written forever: it must not import oracle modules that can
    change after it ships (0016 carries a frozen copy of oracle.migration_checks)."""
    source = (API_DIR / "migrations" / "versions" / "0016_roadmap.py").read_text()
    assert "from oracle" not in source and "import oracle" not in source


def test_the_model_lists_every_subject_the_migrated_check_allows(scratch_db):
    from oracle.v2.models import CHANGE_SUBJECTS

    command.upgrade(_cfg(), "head")
    assert _subjects() == set(CHANGE_SUBJECTS)


# ------------------------------------------------------------- 0014_review after 0016

# PR #69's 0014_review as it stands: change_events.subject_kind "as of 0013", rebuilt
# from this fixed list plus 'member' (upgrade) or without it (downgrade).
REVIEW_0013_SUBJECTS = (
    "document_section",
    "requirement",
    "decision",
    "source_permission",
    "blocker_status",
    "composition_revision",
    "document_version",
    "entity",
    "artifact_version",
)


def _review_fixed_list(upgrade: bool) -> None:
    """0014_review's subject check, as written in PR #69: drop and recreate from a list."""
    values = REVIEW_0013_SUBJECTS + (("member",) if upgrade else ())
    if not upgrade:
        _run("DELETE FROM change_events WHERE subject_kind = 'member'")
    _run("ALTER TABLE change_events DROP CONSTRAINT ck_change_events_subject_kind")
    _run(
        "ALTER TABLE change_events ADD CONSTRAINT ck_change_events_subject_kind "
        "CHECK (subject_kind IN (" + ", ".join(f"'{v}'" for v in values) + "))"
    )


def _review_additive(upgrade: bool) -> None:
    """The change PR #69's 0014_review needs: add or remove only 'member', through
    oracle.migration_checks, as 0016 does for 'product_track'."""
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext
    from sqlalchemy.ext.asyncio import create_async_engine

    from oracle.migration_checks import add_check_values, remove_check_values

    check = ("change_events", "ck_change_events_subject_kind", "subject_kind")

    def go(conn) -> None:
        with Operations.context(MigrationContext.configure(conn)):
            if upgrade:
                add_check_values(*check, ("member",))
            else:
                remove_check_values(*check, ("member",))

    async def run() -> None:
        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                if not upgrade:
                    await conn.execute(
                        text("DELETE FROM change_events WHERE subject_kind = 'member'")
                    )
                await conn.run_sync(go)
        finally:
            await engine.dispose()

    asyncio.run(run())


@pytest.mark.parametrize(
    "review",
    [
        pytest.param(
            _review_fixed_list,
            marks=pytest.mark.xfail(
                strict=True,
                raises=(AssertionError, IntegrityError),
                reason="PR #69's 0014_review rebuilds the check from a fixed list: run "
                "after 0016 it drops product_track (and fails once a product_track "
                "event exists)",
            ),
            id="fixed_list",
        ),
        pytest.param(_review_additive, id="additive"),
    ],
)
def test_0014_review_after_0016_keeps_product_track(scratch_db, review):
    """The integrator may chain 0014_review after 0016. 0016 is additive in both orders
    (test above); 0014_review must be too, or the track monitor's change events break."""
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    before = _subjects()
    assert "product_track" in before

    # A fresh database (CI): no product_track event yet. The rebuild succeeds...
    review(upgrade=True)
    # ...and must still allow both lanes' subjects.
    assert _subjects() == before | {"member"}
    _event(tenant, "product_track")
    _event(tenant, "member")

    # A deployed database: product_track events exist when 0014_review is undone.
    review(upgrade=False)
    assert _subjects() == before
    _event(tenant, "product_track")

    # And applied again with product_track events present.
    review(upgrade=True)
    assert _subjects() == before | {"member"}


def test_what_breaks_when_the_fixed_list_rebuild_runs_after_0016(scratch_db):
    """What PR #69's 0014_review does today, chained after 0016: on a fresh database it
    silently drops product_track (the track monitor's change events are then refused);
    on a database with a product_track event the upgrade itself fails."""
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)

    _review_fixed_list(upgrade=True)
    assert "product_track" not in _subjects()
    with pytest.raises(IntegrityError):
        _event(tenant, "product_track")

    command.downgrade(cfg, "0014_blockers_snapshot")
    command.upgrade(cfg, REVISION)
    _event(tenant, "product_track")
    with pytest.raises(IntegrityError, match="ck_change_events_subject_kind"):
        _review_fixed_list(upgrade=True)
