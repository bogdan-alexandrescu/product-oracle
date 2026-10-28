"""Migration 0090_simple_prd_plans (plan-model).

Card: protects=simple_prd_plans, roadmap_date_suggestions.slice_code and the prd_plan job
kind come and go with the revision, chained on 0089_ritual_attendees_edited_at as the
single head; fails_when=the table, the column or the kind is missing or the downgrade
leaves them; no_claim=their use (tests/test_simple_plan_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0090_simple_prd_plans"
PREVIOUS = "0089_ritual_attendees_edited_at"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_prd_plans")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _state() -> tuple[bool, bool, bool]:
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                table = await conn.scalar(text("SELECT to_regclass('simple_prd_plans')"))
                column = await conn.scalar(
                    text(
                        "SELECT count(*) FROM information_schema.columns WHERE table_name ="
                        " 'roadmap_date_suggestions' AND column_name = 'slice_code'"
                    )
                )
                check = await conn.scalar(
                    text(
                        "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                        " WHERE conname = 'ck_llm_jobs_kind'"
                    )
                )
                return table is not None, column == 1, "prd_plan" in (check or "")
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0091_prd_questions"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _state() == (True, True, True)
    command.downgrade(cfg, PREVIOUS)
    assert _state() == (False, False, False)
    command.upgrade(cfg, REVISION)
    assert _state() == (True, True, True)
