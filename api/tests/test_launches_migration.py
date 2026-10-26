"""Migration 0020_launches: the launches, launch_tasks, changelog_entries and
requester_notes tables, and the launch_kit flow and launch_review checkpoint values.
Additive; the downgrade drops them and refuses while launch_kit runs exist, unless
forced.

Card: protects=the four tables, their checks and the run/checkpoint values come and go
with the revision, and other lanes' check values survive; fails_when=the upgrade misses
a table or value, the downgrade leaves one behind or silently deletes launch_kit runs;
no_claim=the application's use of the tables (tests/test_launches.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

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

REVISION = "0020_launches"
PREVIOUS = "0020_strategy"
TABLES = {"launches", "launch_tasks", "changelog_entries", "requester_notes"}
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_launches")
    .render_as_string(hide_password=False)
)


def _cfg(**x: str) -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    if x:
        cfg.cmd_opts = type("Opts", (), {"x": [f"{k}={v}" for k, v in x.items()]})()
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


def _check(name: str) -> str:
    return _run("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :n", n=name)[
        0
    ][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0064_feedback_withheld"]


def _tenant() -> uuid.UUID:
    t = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    return t


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    assert not TABLES & _tables()
    command.upgrade(_cfg(), REVISION)
    assert TABLES <= _tables()
    flows = _check("ck_runs_flow")
    assert "launch_kit" in flows and "prd_to_roadmap" in flows
    kinds = _check("ck_checkpoints_kind")
    assert "launch_review" in kinds and "roadmap_review" in kinds

    t = _tenant()
    d, track, launch = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'budgets', 'Budgets', 'draft')",
        d=d,
        t=t,
    )
    _run(
        "INSERT INTO product_tracks (id, tenant_id, prd_document_id, title) "
        "VALUES (:k, :t, :d, 'Budgets')",
        k=track,
        t=t,
        d=d,
    )
    insert = (
        "INSERT INTO launches (id, tenant_id, title, track_id, item_keys, state) "
        "VALUES (:l, :t, 'Hard caps', :k, ARRAY['hard-caps'], :s)"
    )
    _run(insert, l=launch, t=t, k=track, s="cancelled")
    _run(insert, l=uuid.uuid4(), t=t, k=track, s="planned")
    # One live launch per items of a track; a cancelled one does not count.
    with pytest.raises(IntegrityError):
        _run(insert, l=uuid.uuid4(), t=t, k=track, s="ready")
    with pytest.raises(IntegrityError):
        _run("UPDATE launches SET tier = 4 WHERE id = :l", l=launch)
    # A skipped task needs its reason.
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO launch_tasks (id, tenant_id, launch_id, title, position, audience, "
            "status) VALUES (gen_random_uuid(), :t, :l, 'Demo', 1, 'internal', 'skipped')",
            t=t,
            l=launch,
        )
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO changelog_entries (id, tenant_id, category, audience, title, "
            "released_on, created_actor) VALUES (gen_random_uuid(), :t, 'improved', "
            "'public', 'x', '2026-10-21', 'oracle')",
            t=t,
        )

    # A launch_kit run blocks the downgrade unless forced.
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (gen_random_uuid(), :t, 'launch_kit', 'draft')",
        t=t,
    )
    with pytest.raises(RuntimeError, match="launch_kit runs exist"):
        command.downgrade(_cfg(), PREVIOUS)
    assert TABLES <= _tables()
    command.downgrade(_cfg(force="1"), PREVIOUS)
    assert not TABLES & _tables()
    assert "launch_kit" not in _check("ck_runs_flow")
    assert "launch_review" not in _check("ck_checkpoints_kind")
    assert "prd_to_roadmap" in _check("ck_runs_flow")
    assert _run("SELECT count(*) FROM runs") == [(0,)]

    command.upgrade(_cfg(), REVISION)
    assert TABLES <= _tables()
