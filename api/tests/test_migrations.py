"""Migrations 0002 and 0003: upgrade, downgrade and upgrade again on a scratch database.

Sync tests on purpose: Alembic's env.py runs its own event loop.
"""

import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.engine import make_url

import oracle.models  # noqa: F401
from oracle.db import Base
from oracle.templates import defaults
from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

V1_TABLES = {
    "invites",
    "run_tokens",
    "sources",
    "connections",
    "tenant_settings",
    "themes",
    "source_items",
    "source_item_versions",
    "snapshots",
    "entities",
    "edges",
    "evidence",
    "entity_revisions",
    "proposals",
    "conflicts",
    "templates",
    "template_versions",
    "priority_snapshots",
    "runs",
    "run_segments",
    "checkpoints",
}
# render_as_string keeps the password; str(url) masks it as "***" (CI's Postgres has one).
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations")
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


def _tables() -> set[str]:
    return {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_upgrade_downgrade_round_trip(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0001")
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (gen_random_uuid(), :t, 'admin@example.com', 'x', 'owner')",
        t=tenant,
    )
    _run(
        "INSERT INTO api_tokens (id, tenant_id, name, token_hash) "
        "VALUES (gen_random_uuid(), :t, 'agent', 'hash')",
        t=tenant,
    )

    command.upgrade(cfg, "head")
    assert V1_TABLES <= _tables()
    # Existing tokens act as owners; existing tenants get the default template.
    assert _run("SELECT role FROM api_tokens") == [("owner",)]
    rows = _run(
        "SELECT t.key, v.version, v.body, v.required_sections FROM templates t "
        "JOIN template_versions v ON v.template_id = t.id WHERE t.tenant_id = :t",
        t=tenant,
    )
    assert rows == [
        (
            defaults.DEFAULT_TEMPLATE_KEY,
            1,
            defaults.DEFAULT_TEMPLATE_BODY,
            defaults.DEFAULT_REQUIRED_SECTIONS,
        )
    ]
    _run("UPDATE users SET role = 'viewer'")

    # A downgrade would lose the viewer's role: refused, nothing changed.
    with pytest.raises(RuntimeError, match="role other than owner"):
        command.downgrade(cfg, "0001")
    assert V1_TABLES <= _tables()

    _run("UPDATE users SET role = 'owner'")
    command.downgrade(cfg, "0001")
    assert not (V1_TABLES & _tables())
    assert _run("SELECT count(*) FROM users") == [(1,)]
    with pytest.raises(Exception, match="ck_users_role"):
        _run("UPDATE users SET role = 'viewer'")

    command.upgrade(cfg, "head")
    assert V1_TABLES <= _tables()
    command.downgrade(cfg, "base")
    assert _tables() == {"alembic_version"}


def test_models_match_migrations(scratch_db):
    """The models (Base.metadata) and the migrations describe the same schema."""
    command.upgrade(_cfg(), "head")

    async def diff():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        async with engine.connect() as conn:
            result = await conn.run_sync(
                lambda c: compare_metadata(MigrationContext.configure(c), Base.metadata)
            )
            names = await conn.run_sync(lambda c: inspect(c).get_table_names())
        await engine.dispose()
        return result, names

    result, names = asyncio.run(diff())
    assert result == []
    assert set(Base.metadata.tables) <= set(names)


def test_migration_template_copy_matches_defaults():
    import importlib.util

    path = API_DIR / "migrations" / "versions" / "0002_v1_foundation.py"
    spec = importlib.util.spec_from_file_location("migration_0002", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.DEFAULT_TEMPLATE_KEY == defaults.DEFAULT_TEMPLATE_KEY
    assert module.DEFAULT_TEMPLATE_NAME == defaults.DEFAULT_TEMPLATE_NAME
    assert module.DEFAULT_TEMPLATE_BODY == defaults.DEFAULT_TEMPLATE_BODY
    assert module.DEFAULT_REQUIRED_SECTIONS == defaults.DEFAULT_REQUIRED_SECTIONS


BASELINE_FLOW = "0022_baseline_flow"


def _flow_check() -> str:
    return _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_runs_flow'"
    )[0][0]


def test_baseline_flow_check_up_down_up(scratch_db):
    # protects=the baseline flow value comes and goes with 0022_baseline_flow, other
    # flows' values survive, and the downgrade deletes only baseline runs (criterion 10);
    # fails_when=the upgrade misses the value, the downgrade leaves it or deletes another
    # flow's run, or the chain has two heads; no_claim=the application's use of the flow
    # (tests/test_baseline_flow.py).
    from alembic.script import ScriptDirectory

    cfg = _cfg()
    script = ScriptDirectory.from_config(cfg)
    previous = script.get_revision(BASELINE_FLOW).down_revision
    # removed-tracks, prd-order: renumbered when trains merge.
    assert script.get_heads() == ["0120_simple_changes_seq"]

    command.upgrade(cfg, previous)
    assert "'baseline'" not in _flow_check()
    command.upgrade(cfg, BASELINE_FLOW)
    check = _flow_check()
    assert "'baseline'" in check and "'launch_kit'" in check and "'prd_to_roadmap'" in check

    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    for flow in ("baseline", "baseline_to_prd"):
        _run(
            "INSERT INTO runs (id, tenant_id, flow, status) "
            "VALUES (gen_random_uuid(), :t, :f, 'succeeded')",
            t=tenant,
            f=flow,
        )

    command.downgrade(cfg, previous)
    assert "'baseline'" not in _flow_check() and "'launch_kit'" in _flow_check()
    assert _run("SELECT flow FROM runs") == [("baseline_to_prd",)]
    with pytest.raises(Exception, match="ck_runs_flow"):
        _run(
            "INSERT INTO runs (id, tenant_id, flow, status) "
            "VALUES (gen_random_uuid(), :t, 'baseline', 'draft')",
            t=tenant,
        )

    command.upgrade(cfg, BASELINE_FLOW)
    assert "'baseline'" in _flow_check()


REVISION_RUN = "0044_revision_run"


def _columns(table: str) -> set[str]:
    return {
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :t", t=table
        )
    }


def test_revision_run_up_down_up(scratch_db):
    # protects=B2 criterion 10: entity_revisions.run_id (and its index) comes and goes
    # with 0042_revision_run, after main's head; fails_when=the column survives the
    # downgrade, is missing after the upgrade, or the chain has two heads; no_claim=the
    # application's writes (tests/test_baseline_from_run.py).
    from alembic.script import ScriptDirectory

    cfg = _cfg()
    script = ScriptDirectory.from_config(cfg)
    assert REVISION_RUN in {r.revision for r in script.walk_revisions()}
    previous = script.get_revision(REVISION_RUN).down_revision
    assert previous == "0043_invite_message"
    command.upgrade(cfg, REVISION_RUN)
    assert "run_id" in _columns("entity_revisions")
    command.downgrade(cfg, previous)
    assert "run_id" not in _columns("entity_revisions")
    command.upgrade(cfg, REVISION_RUN)
    assert "run_id" in _columns("entity_revisions")


SIMPLE_CHANGES_SEQ = "0113_simple_changes_seq"


def test_simple_changes_seq_backfills_in_the_order_made(scratch_db):
    # protects=0113 numbers the changes already stored by (at, id): older ones first, and
    # rows sharing one ``at`` by id, so a tie lists the same as it did before the column;
    # a change made after the upgrade numbers after them all and NOT NULL holds;
    # fails_when=seq follows storage (heap) order, or a new change takes a used number;
    # no_claim=the order lists use (tests/test_simple_changes_api.py).
    from alembic.script import ScriptDirectory

    cfg = _cfg()
    previous = ScriptDirectory.from_config(cfg).get_revision(SIMPLE_CHANGES_SEQ).down_revision
    command.upgrade(cfg, previous)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    ids = [uuid.UUID(int=n) for n in (9, 3, 7, 1, 5)]
    # Stored newest first and ids out of order: heap order is neither (at) nor (at, id).
    rows = [
        (ids[0], datetime(2026, 10, 2, 9, tzinfo=UTC)),
        (ids[1], datetime(2026, 10, 2, 9, tzinfo=UTC)),
        (ids[2], datetime(2026, 10, 2, 9, tzinfo=UTC)),
        (ids[3], datetime(2026, 10, 1, 9, tzinfo=UTC)),
        (ids[4], datetime(2026, 9, 30, 9, tzinfo=UTC)),
    ]
    for i, at in rows:
        _run(
            "INSERT INTO simple_changes (id, tenant_id, op, target, before, after, status, by, at)"
            " VALUES (:id, :t, 'edit_title', '{}', '{}', '{}', 'applied', :by, "
            ":at)",
            id=i,
            t=tenant,
            by=uuid.uuid4(),
            at=at,
        )

    command.upgrade(cfg, SIMPLE_CHANGES_SEQ)
    got = [r[0] for r in _run("SELECT id FROM simple_changes ORDER BY seq")]
    assert got == [ids[4], ids[3], ids[1], ids[2], ids[0]]
    assert [r[0] for r in _run("SELECT seq FROM simple_changes ORDER BY seq")] == [1, 2, 3, 4, 5]
    _run(
        "INSERT INTO simple_changes (id, tenant_id, op, target, before, after, status, by, at)"
        " VALUES (gen_random_uuid(), :t, 'edit_title', '{}', '{}', '{}', 'applied', "
        "gen_random_uuid(), now())",
        t=tenant,
    )
    assert _run("SELECT max(seq), count(DISTINCT seq) FROM simple_changes") == [(6, 6)]
    assert _run(
        "SELECT is_nullable FROM information_schema.columns "
        "WHERE table_name = 'simple_changes' AND column_name = 'seq'"
    ) == [("NO",)]
    command.downgrade(cfg, previous)
    assert "seq" not in _columns("simple_changes")
    command.upgrade(cfg, SIMPLE_CHANGES_SEQ)
    assert "seq" in _columns("simple_changes")
