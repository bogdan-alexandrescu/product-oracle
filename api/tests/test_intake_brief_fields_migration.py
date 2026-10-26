"""Migration 0023_intake_brief_fields (C4 One New PRD door): the brief's goals,
out-of-scope lines, template, theme and O1d answers on product_intakes; reversible.

Sync on purpose (Alembic runs its own event loop); its own scratch database.

Card: protects=the five columns arrive with their defaults on existing intakes and the
downgrade drops exactly them; fails_when=a column is missing, an existing intake gets a
NULL list or answers, a second head appears, or the downgrade leaves a column behind;
no_claim=data written by the app.
"""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0023_intake_brief_fields"
PREVIOUS = "0023_source_partial_sync"
COLUMNS = {"goal_ids", "out_of_scope", "draft_template", "draft_theme", "prd_answers"}
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_intake_brief")
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


def _columns() -> set[str]:
    rows = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'product_intakes'"
    )
    return {r[0] for r in rows} & COLUMNS


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_mains_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    # 0024_segment_skipped chains on it; one head.
    assert script.get_heads() == ["0058_feedback_withheld"]
    assert script.get_revision("0024_segment_skipped").down_revision == REVISION


def test_upgrade_adds_the_brief_fields_and_downgrade_drops_them(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant, intake = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief) "
        "VALUES (:id, :t, 'Saved addresses', 'Returning buyers retype their address.')",
        id=intake, t=tenant,
    )  # fmt: skip
    assert _columns() == set()

    command.upgrade(_cfg(), REVISION)
    assert _columns() == COLUMNS
    row = _run(
        "SELECT goal_ids, out_of_scope, draft_template, draft_theme, prd_answers "
        "FROM product_intakes WHERE id = :id",
        id=intake,
    )[0]
    assert tuple(row) == ([], [], None, None, {})

    command.downgrade(_cfg(), PREVIOUS)
    assert _columns() == set()
    assert _run("SELECT count(*) FROM product_intakes")[0][0] == 1
