"""Migration 0022_code_maps: the code_maps table and the code_map flow value. Additive;
the downgrade deletes code_map runs, drops the table and removes the value.

Card: protects=AC10 the table, its checks and the flow value come and go with the
revision, existing rows survive up/down/up, and other lanes' ck_runs_flow values survive;
fails_when=the upgrade misses the table or the value, the downgrade leaves either behind
or drops another lane's flow value; no_claim=the application's use of the table
(tests/test_code_maps.py).

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

REVISION = "0022_code_maps"
PREVIOUS = "0022_priority_overrides"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_code_maps")
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
    assert script.get_heads() == ["0055_discussion_decision_change"]


def test_upgrade_and_downgrade_keep_existing_rows(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    assert "code_maps" not in _tables()
    # Another lane's flow value added after its own migration survives either way.
    _run(
        "ALTER TABLE runs DROP CONSTRAINT ck_runs_flow, ADD CONSTRAINT ck_runs_flow CHECK "
        "(flow IN ('baseline_to_prd', 'feedback_loop', 'prd_to_roadmap', 'prd_to_spec', "
        "'request_triage', 'strategy_draft', 'launch_kit', 'other_lane'))"
    )
    t = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (gen_random_uuid(), :t, 'baseline_to_prd', 'draft')",
        t=t,
    )

    command.upgrade(_cfg(), REVISION)
    assert "code_maps" in _tables()
    flows = _check("ck_runs_flow")
    assert "code_map" in flows and "other_lane" in flows and "launch_kit" in flows
    u, src = uuid.uuid4(), uuid.uuid4()
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'dev@example.com', 'x', 'viewer')",
        u=u,
        t=t,
    )
    _run(
        "INSERT INTO sources (id, tenant_id, owner_user_id, kind, name, config, status) "
        "VALUES (:s, :t, :u, 'github', 'Repo', '{}', 'active')",
        s=src,
        t=t,
        u=u,
    )
    insert = (
        "INSERT INTO code_maps (id, tenant_id, source_id, repo, commit_sha, status, sharing) "
        "VALUES (gen_random_uuid(), :t, :s, 'example-org/app', :c, :st, :sh)"
    )
    _run(insert, t=t, s=src, c="abc", st="ready", sh="private")
    with pytest.raises(IntegrityError):
        _run(insert, t=t, s=src, c="abc", st="ready", sh="private")
    with pytest.raises(IntegrityError):
        _run(insert, t=t, s=src, c="def", st="done", sh="private")
    with pytest.raises(IntegrityError):
        _run(insert, t=t, s=src, c="ghi", st="ready", sh="summary")
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (gen_random_uuid(), :t, 'code_map', 'draft')",
        t=t,
    )

    command.downgrade(_cfg(), PREVIOUS)
    assert "code_maps" not in _tables()
    flows = _check("ck_runs_flow")
    assert "code_map" not in flows and "other_lane" in flows
    assert _run("SELECT flow FROM runs") == [("baseline_to_prd",)]

    command.upgrade(_cfg(), REVISION)
    assert "code_maps" in _tables()
    assert _run("SELECT flow FROM runs") == [("baseline_to_prd",)]
    # Deleting the source deletes its maps.
    _run(insert, t=t, s=src, c="abc", st="ready", sh="full")
    _run("DELETE FROM sources WHERE id = :s", s=src)
    assert _run("SELECT count(*) FROM code_maps") == [(0,)]
