"""Migration 0048_scope_review (C7 Scope review): ``prd_scope_items.original`` and a PRD
scope as an ``llm_jobs`` subject, with the ``scope_enhance`` kind.

Test card: protects=the upgrade applies to a database with a scope and its rows (the new
column defaults to {}), a scope_enhance job with only scope_id is accepted, and the
downgrade deletes those jobs and restores the subject check; fails_when=the upgrade or
the downgrade fails, the subject check lets a job with no subject through, or the chain
has two heads; no_claim=the application's use of the column (tests/test_scope_review.py).

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

REVISION = "0048_scope_review"
PREVIOUS = "0047_slack_bridge"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_scope_review")
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


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_mains_head_and_is_the_only_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0055_discussion_research"]


def test_upgrade_and_downgrade_on_a_seeded_database(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t, run, scope, item = (uuid.uuid4() for _ in range(4))
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (:r, :t, 'baseline_to_prd', 'awaiting_checkpoint')",
        r=run,
        t=t,
    )
    _run(
        "INSERT INTO prd_scopes (id, tenant_id, run_id, segment_seq, attempt) "
        "VALUES (:s, :t, :r, 2, 1)",
        s=scope,
        t=t,
        r=run,
    )
    _run(
        "INSERT INTO prd_scope_items (id, tenant_id, scope_id, kind, key, title, decision, "
        "position) VALUES (:i, :t, :s, 'feature', 'saved-addresses', 'Saved addresses', "
        "'include', 0)",
        i=item,
        t=t,
        s=scope,
    )
    command.upgrade(cfg, REVISION)
    assert _run("SELECT original FROM prd_scope_items")[0][0] == {}
    job = uuid.uuid4()
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, scope_id, status, input, attempts) "
        "VALUES (:j, :t, 'scope_enhance', :s, 'queued', '{}', 0)",
        j=job,
        t=t,
        s=scope,
    )
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO llm_jobs (id, tenant_id, kind, status, input, attempts) "
            "VALUES (:j, :t, 'scope_enhance', 'queued', '{}', 0)",
            j=uuid.uuid4(),
            t=t,
        )
    command.downgrade(cfg, PREVIOUS)
    assert _run("SELECT count(*) FROM llm_jobs")[0][0] == 0
    columns = {
        (r[0], r[1])
        for r in _run(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_name IN ('prd_scope_items', 'llm_jobs')"
        )
    }
    assert ("prd_scope_items", "original") not in columns
    assert ("llm_jobs", "scope_id") not in columns
    assert _run("SELECT count(*) FROM prd_scope_items")[0][0] == 1
    command.upgrade(cfg, REVISION)
