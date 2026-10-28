"""Migration 0068_intake_read (INT2 lane 1): the intake_analysis flow, the
``read:intake-input`` run-token scope and the queued pool jobs moved to SwarmCloud.

Card: protects=the flow and the scope come and go with the revision, chained on
0054_reply_opened as the single head; the upgrade cancels queued intake_analysis jobs as
moved_to_swarmcloud and leaves ended jobs alone; the downgrade refuses while a read is
running; fails_when=either check misses its value, a queued job stays queued, an ended job
is touched, or the downgrade drops the value under a live run; no_claim=the reads the tick
then starts (tests/test_intake_read.py).

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

REVISION = "0068_intake_read"
PREVIOUS = "0067_webhook_resumed_at"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_intake_read")
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
    assert script.get_heads() == ["0087_simple_chat_reads"]


def test_upgrade_cancels_queued_jobs_and_downgrade_refuses_under_a_live_read(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    intake = uuid.uuid4()
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief) "
        "VALUES (:i, :t, 'Saved addresses', 'A made-up brief')",
        i=intake, t=tenant,
    )  # fmt: skip
    queued, done, failed = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    for job, status in ((queued, "queued"), (done, "succeeded"), (failed, "failed")):
        _run(
            "INSERT INTO llm_jobs (id, tenant_id, kind, intake_id, status, input, attempts) "
            "VALUES (:j, :t, 'intake_analysis', :i, :s, '{}', 0)",
            j=job, t=tenant, i=intake, s=status,
        )  # fmt: skip
    command.upgrade(_cfg(), REVISION)
    assert "intake_analysis" in _check("ck_runs_flow")
    assert "read:intake-input" in _check("ck_run_tokens_scopes")
    rows = dict((r[0], (r[1], r[2])) for r in _run("SELECT id, status, error_reason FROM llm_jobs"))
    assert rows[queued] == ("cancelled", "moved_to_swarmcloud")
    assert rows[done][0] == "succeeded" and rows[failed][0] == "failed"

    run = uuid.uuid4()
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) VALUES (:r, :t, 'intake_analysis', "
        "'running')",
        r=run, t=tenant,
    )  # fmt: skip
    with pytest.raises(RuntimeError, match="intake_analysis"):
        command.downgrade(_cfg(), PREVIOUS)
    _run("UPDATE runs SET status = 'succeeded' WHERE id = :r", r=run)
    command.downgrade(_cfg(), PREVIOUS)
    assert "intake_analysis" not in _check("ck_runs_flow")
    assert "read:intake-input" not in _check("ck_run_tokens_scopes")
