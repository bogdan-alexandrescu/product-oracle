"""Migration 0033_question_retired (#307): a question may be ``retired``, and the open
questions of briefs already archived are retired once; reversible.

Sync on purpose (Alembic runs its own event loop); its own scratch database.

Card: protects=the backfill retires exactly the asked or delegated questions of archived
briefs, running it again changes nothing, and the downgrade asks them again;
fails_when=a live brief's question or an answered one is touched, a second run moves a
row, a second head appears, or the downgrade leaves a retired row; no_claim=the app's
archive and restore (tests/test_intake_archive_retires.py).
"""

import asyncio
import importlib.util
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0033_question_retired"
PREVIOUS = "0032_interviews"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_question_retired")
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


def _statuses() -> dict[str, str]:
    return {r[0]: r[1] for r in _run("SELECT prompt, status FROM stakeholder_questions")}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_mains_head_and_is_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0055_metric_errors_fixed"]


def test_backfill_retires_archived_briefs_open_questions_once(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant, archived, live = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    for intake, status in ((archived, "archived"), (live, "awaiting_answers")):
        _run(
            "INSERT INTO product_intakes (id, tenant_id, title, brief, status) "
            "VALUES (:id, :t, 'Saved addresses', 'Returning buyers retype their address.', :s)",
            id=intake, t=tenant, s=status,
        )  # fmt: skip
    rows = [
        (archived, "archived asked", "asked"),
        (archived, "archived delegated", "delegated"),
        (archived, "archived answered", "answered"),
        (archived, "archived draft", "draft"),
        (live, "live asked", "asked"),
    ]
    for intake, prompt, status in rows:
        _run(
            "INSERT INTO stakeholder_questions (id, tenant_id, intake_id, category, prompt, "
            "status) VALUES (:id, :t, :i, 'general', :p, :s)",
            id=uuid.uuid4(), t=tenant, i=intake, p=prompt, s=status,
        )  # fmt: skip

    command.upgrade(_cfg(), REVISION)
    after = {
        "archived asked": "retired",
        "archived delegated": "retired",
        "archived answered": "answered",
        "archived draft": "draft",
        "live asked": "asked",
    }
    assert _statuses() == after

    # Idempotent: the same data fix again moves nothing.
    path = API_DIR / "migrations" / "versions" / f"{REVISION}.py"
    spec = importlib.util.spec_from_file_location("migration_0030_question_retired", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    _run(migration.RETIRE_ARCHIVED)
    assert _statuses() == after

    command.downgrade(_cfg(), PREVIOUS)
    assert _statuses() == {
        "archived asked": "asked",
        "archived delegated": "asked",
        "archived answered": "answered",
        "archived draft": "draft",
        "live asked": "asked",
    }
