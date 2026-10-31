"""Migration 0091_prd_questions (prd-questions).

Card: protects=decisions.prd_question and decisions.due_on, the ``prd`` origin and the
prd_questions job kind come and go with the revision, chained on 0090_whole_prd_stale_cleared as
the single head; fails_when=a column or a value is missing or the downgrade leaves them;
no_claim=their use (tests/test_simple_prd_questions.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0091_prd_questions"
PREVIOUS = "0090_whole_prd_stale_cleared"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_prd_questions")
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
                columns = await conn.scalar(
                    text(
                        "SELECT count(*) FROM information_schema.columns WHERE table_name ="
                        " 'decisions' AND column_name IN ('prd_question', 'due_on')"
                    )
                )

                async def check(name: str) -> str:
                    return (
                        await conn.scalar(
                            text("SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                                 " WHERE conname = :n"),
                            {"n": name},
                        )
                        or ""
                    )  # fmt: skip

                return (
                    columns == 2,
                    "'prd'" in await check("ck_decisions_origin"),
                    "prd_questions" in await check("ck_llm_jobs_kind"),
                )
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
    assert script.get_heads() == ["0095_chat_read_answered_at"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _state() == (True, True, True)
    command.downgrade(cfg, PREVIOUS)
    assert _state() == (False, False, False)
    command.upgrade(cfg, REVISION)
    assert _state() == (True, True, True)
