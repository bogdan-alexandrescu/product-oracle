"""Migration 0122_prd_milestone_codes (item-milestone).

Card: protects=a roadmap's own goal milestones stay coded per goal
(``uq_track_milestones_goal_code`` now skips PRD rows) and a PRD's are coded per roadmap and PRD
(``uq_track_milestones_prd_code``), both with the revision, and the downgrade puts the old
per-goal index back alone, chained on 0121_simple_changes_seq as the single head;
fails_when=either index is missing or keeps the old predicate after the upgrade, the PRD index
survives the downgrade, or the chain has two heads; no_claim=the roadmap read making two PRDs'
M1 in one goal (tests/test_simple_item_milestone_api.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0122_prd_milestone_codes"
PREVIOUS = "0121_simple_changes_seq"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_prd_milestone_codes")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _indexes() -> dict[str, str]:
    """track_milestones' unique code indexes: name -> definition."""

    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                sql = (
                    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = "
                    "'track_milestones' AND indexname LIKE 'uq_track_milestones_%_code'"
                )
                return {r[0]: r[1] for r in (await conn.execute(text(sql))).all()}
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
    # One head, and this migration is on its chain (test_migrations pins the head itself).
    [head] = script.get_heads()
    assert REVISION in {r.revision for r in script.walk_revisions("base", head)}


def _upgraded(ix: dict[str, str]) -> None:
    assert set(ix) == {"uq_track_milestones_goal_code", "uq_track_milestones_prd_code"}, ix
    goal, prd = ix["uq_track_milestones_goal_code"], ix["uq_track_milestones_prd_code"]
    assert "(roadmap_id, goal_id, code)" in goal and "origin_prd_id IS NULL" in goal, goal
    assert "(roadmap_id, origin_prd_id, code)" in prd and "origin_prd_id IS NOT NULL" in prd, prd


def test_up_down_up(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    _upgraded(_indexes())
    command.downgrade(cfg, PREVIOUS)
    ix = _indexes()
    assert set(ix) == {"uq_track_milestones_goal_code"}, ix
    assert "origin_prd_id" not in ix["uq_track_milestones_goal_code"]
    command.upgrade(cfg, REVISION)
    _upgraded(_indexes())
