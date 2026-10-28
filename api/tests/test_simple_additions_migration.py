"""Migration 0083_simple_additions (Simple S7, #723).

Card: protects=simple_goal_suggestions, simple_goal_autos, the llm_jobs kinds item_draft and
goal_suggestions and roadmap_items' S7 columns come and go with the revision, chained on
0082_roadmap_key_dates as the single head, and the widened one_owner check lets an item
added in Simple live on no version; fails_when=a table, kind or column is missing, or the
downgrade leaves one; no_claim=the routes' use (tests/test_simple_additions_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0083_simple_additions"
PREVIOUS = "0082_roadmap_key_dates"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_simple_additions")
    .render_as_string(hide_password=False)
)
TABLES = {"simple_goal_suggestions", "simple_goal_autos"}


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _run(sql: str):
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                return (await conn.execute(text(sql))).all()
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _state() -> tuple[set[str], bool]:
    tables = {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}
    kind = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_llm_jobs_kind'"
    )
    cols = {
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'roadmap_items' AND column_name IN "
            "('simple_draft_id', 'goal_ids', 'merged_into', 'kept_both')"
        )
    }
    one_owner = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'ck_roadmap_items_one_owner'"
    )[0][0]
    on = "item_draft" in kind[0][0] and "goal_suggestions" in kind[0][0]
    assert ("simple_draft_id" in one_owner) == on
    assert cols == ({"simple_draft_id", "goal_ids", "merged_into", "kept_both"} if on else set())
    return tables & TABLES, on


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0090_simple_prd_plans"]


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    assert _state() == (TABLES, True)
    command.downgrade(cfg, PREVIOUS)
    assert _state() == (set(), False)
    command.upgrade(cfg, REVISION)
    assert _state() == (TABLES, True)


def test_migration_passes_ruff():
    """Review: the revision's lines stay within ruff's limit (CI lints api/ as a whole)."""
    import subprocess
    import sys

    path = API_DIR / "migrations" / "versions" / f"{REVISION}.py"
    out = subprocess.run([sys.executable, "-m", "ruff", "check", str(path)], cwd=API_DIR,
                         capture_output=True, text=True)  # fmt: skip
    assert out.returncode == 0, out.stdout + out.stderr
