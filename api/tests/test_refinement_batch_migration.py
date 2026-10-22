"""Migration 0016_refinement_batch: llm_jobs.kind gains refinement_batch by extending the
check the database has (kinds added by other lanes are kept), and the downgrade takes it
out again (deleting batch jobs). Sync on purpose; its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0016_refinement_batch"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_batch")
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


def _check() -> str:
    return _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_llm_jobs_kind'"
    )[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_roadmap_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == "0016_roadmap"
    # 0017_citation_source_oracle chains on it, then 0018_runtime_features,
    # 0019_citation_confidence, the intake lane's 0014_intake and the PRD review chain;
    # one head.
    assert script.get_heads() == ["0025_tracker_links"]
    assert script.get_revision("0017_citation_source_oracle").down_revision == REVISION
    assert script.get_revision("0014_intake").down_revision == "0019_citation_confidence"
    assert script.get_revision("0014_review").down_revision == "0018_source_unavailable_items"


def test_extends_the_live_check_and_keeps_other_kinds(scratch_db):
    command.upgrade(_cfg(), "0016_roadmap")
    # Another lane's kind, added after 0013, must survive.
    _run("ALTER TABLE llm_jobs DROP CONSTRAINT ck_llm_jobs_kind")
    _run(
        "ALTER TABLE llm_jobs ADD CONSTRAINT ck_llm_jobs_kind CHECK (kind IN "
        "('review_comments', 'reporting', 'refinement', 'quality_review', 'other_lane'))"
    )
    command.upgrade(_cfg(), REVISION)
    check = _check()
    for kind in ("review_comments", "quality_review", "other_lane", "refinement_batch"):
        assert f"'{kind}'" in check
    command.downgrade(_cfg(), "0016_roadmap")
    check = _check()
    assert "'refinement_batch'" not in check and "'other_lane'" in check
