"""Migration 0090_interview_new_link (Make a new link, qa-work-43).

Card: protects=interviews.link_created_at and interviews.replaced_link_hashes come and go
with the revision, chained on 0091_prd_questions as the single head, and an
open link's made date is backfilled from its expiry; fails_when=a column is missing, the
backfill is wrong or the downgrade leaves a column; no_claim=their use
(tests/test_interviews.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0090_interview_new_link"
PREVIOUS = "0091_prd_questions"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_interview_new_link")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _run(sql: str, **params) -> list:
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                result = await conn.execute(text(sql), params)
                return list(result.all()) if result.returns_rows else []
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _columns() -> set[str]:
    rows = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'interviews'"
        " AND column_name IN ('link_created_at', 'replaced_link_hashes')"
    )
    return {r[0] for r in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0093_dont_know_open"]


def test_up_down_up_and_the_backfill(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tid = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tid)
    iid = uuid.uuid4()
    _run(
        "INSERT INTO interviews (id, tenant_id, kind, title, interviewee_name, status,"
        " link_token_hash, link_expires_at, created_by)"
        " VALUES (:i, :t, 'customer', 'Topic', 'Ana', 'invited', 'h',"
        " '2026-11-04T09:00:00+00', :u)",
        i=iid,
        t=tid,
        u=uuid.uuid4(),
    )
    command.upgrade(cfg, REVISION)
    assert _columns() == {"link_created_at", "replaced_link_hashes"}
    made, replaced = _run(
        "SELECT link_created_at, replaced_link_hashes FROM interviews WHERE id = :i", i=iid
    )[0]
    assert made == datetime(2026, 10, 28, 9, tzinfo=UTC) and replaced == []
    command.downgrade(cfg, PREVIOUS)
    assert _columns() == set()
    command.upgrade(cfg, REVISION)
    assert _columns() == {"link_created_at", "replaced_link_hashes"}
