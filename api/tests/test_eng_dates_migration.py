"""Migration 0069_eng_dates: ``ck_checkpoints_kind`` gains ``eng_dates`` (F4 lane B).

Up keeps every kind other lanes added; down refuses while an eng_dates checkpoint exists,
and otherwise removes only that value. Sync tests on purpose (Alembic runs its own event
loop); own scratch database.
"""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0069_eng_dates"
PREVIOUS = "0068_intake_read"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_eng_dates")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _run(sql: str):
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        async with engine.begin() as conn:
            result = await conn.execute(text(sql))
            rows = result.all() if result.returns_rows else None
        await engine.dispose()
        return rows

    return asyncio.run(go())


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def _check() -> str:
    return _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_checkpoints_kind'"
    )[0][0]


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0092_bet_flow_line_key"]


def test_up_down_up_keeps_every_other_kind(scratch_db):
    # protects=AC17; fails_when=up drops a kind another lane added, down leaves eng_dates
    # or removes another kind; no_claim=data in other tables.
    command.upgrade(_cfg(), PREVIOUS)
    before = _check()
    assert "eng_dates" not in before
    command.upgrade(_cfg(), REVISION)
    after = _check()
    assert "eng_dates" in after and "eng_review" in after and "prd_review" in after
    command.downgrade(_cfg(), PREVIOUS)
    assert _check() == before
    command.upgrade(_cfg(), REVISION)
    assert "eng_dates" in _check()


def test_down_refuses_while_an_eng_dates_checkpoint_exists(scratch_db):
    # protects=AC17 refusal; fails_when=the downgrade drops the value under a row using
    # it; no_claim=-.
    command.upgrade(_cfg(), REVISION)
    _run(
        "INSERT INTO tenants (id, name) VALUES "
        "('00000000-0000-0000-0000-0000000000a1', 'Example Co')"
    )
    _run(
        "INSERT INTO runs (tenant_id, id, flow, status, knobs, created_by) VALUES "
        "('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', "
        "'baseline_to_prd', 'running', '{}', '00000000-0000-0000-0000-0000000000c1')"
    )
    _run(
        "INSERT INTO checkpoints (tenant_id, id, run_id, kind, status, approver_role, payload) "
        "VALUES ('00000000-0000-0000-0000-0000000000a1', "
        "'00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', "
        "'eng_dates', 'pending', 'approver', '{}')"
    )
    with pytest.raises(Exception, match="eng_dates"):
        command.downgrade(_cfg(), PREVIOUS)
