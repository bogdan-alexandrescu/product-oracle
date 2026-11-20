"""Migration 0133_null_run_cost (#1572): ``runs.spent_usd`` and ``run_segments.cost_usd``
take a null (unknown) with no 0 default, and the downgrade puts 0 back on nulls.

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0133_null_run_cost"
PREVIOUS = "0132_roadmap_picked_quarter"
COLUMNS = {("runs", "spent_usd"), ("run_segments", "cost_usd")}
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_null_cost")
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
        try:
            async with engine.begin() as conn:
                result = await conn.execute(text(sql))
                return result.all() if result.returns_rows else None
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _shape() -> dict[tuple[str, str], tuple[str, str | None]]:
    rows = _run(
        "SELECT table_name, column_name, is_nullable, column_default "
        "FROM information_schema.columns WHERE table_schema = 'public' "
        "AND column_name IN ('spent_usd', 'cost_usd')"
    )
    return {(t, c): (n, d) for t, c, n, d in rows if (t, c) in COLUMNS}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert len(script.get_heads()) == 1


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), REVISION)
    assert _shape() == {col: ("YES", None) for col in COLUMNS}

    command.downgrade(_cfg(), PREVIOUS)
    shape = _shape()
    assert {n for n, _ in shape.values()} == {"NO"}
    assert all(d is not None and "0" in d for _, d in shape.values())

    command.upgrade(_cfg(), REVISION)
    assert _shape() == {col: ("YES", None) for col in COLUMNS}
