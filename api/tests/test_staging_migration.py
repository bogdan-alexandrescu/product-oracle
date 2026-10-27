"""Migration 0026_staging: G4 One staging list.

Adds the discussion origin to D8's ``checkpoint_actions`` (``origin`` 'row' by default,
the discussion and change it came from, ``from_private``) and ``next_draft_changes`` (a
discussion's section change waiting for the document's next draft). The downgrade drops
the table and the four columns.

Sync tests on purpose (Alembic runs its own event loop); own scratch database.
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

REVISION = "0026_staging"
PREVIOUS = "0025_checkpoint_review"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_staging")
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
        async with engine.begin() as conn:
            result = await conn.execute(text(sql), params)
            rows = result.all() if result.returns_rows else None
        await engine.dispose()
        return rows

    return asyncio.run(go())


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def _origin_columns() -> list[str]:
    return sorted(
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns WHERE table_name = "
            "'checkpoint_actions' AND column_name IN ('origin', 'discussion_id', "
            "'discussion_change_id', 'from_private')"
        )
    )


def _has_table() -> bool:
    return bool(_run("SELECT 1 FROM pg_tables WHERE tablename = 'next_draft_changes'"))


def test_the_chain_ends_here_after_segment_skipped():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0079_simple_one_pagers"]
    assert script.get_revision(REVISION).down_revision == PREVIOUS


def test_up_down_up_keeps_existing_actions_as_row_actions(scratch_db):
    """protects=the schema of G4 (criterion 1); fails_when=an existing action is not a row
    action, a check or the one live row per change drifts, or the downgrade leaves
    anything; no_claim=data backfill (none)."""
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant, run, cp = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run("INSERT INTO runs (id, tenant_id, flow, status) VALUES (:r, :t, 'prd_to_roadmap', "
         "'awaiting_checkpoint')", r=run, t=tenant)  # fmt: skip
    _run("INSERT INTO checkpoints (id, tenant_id, run_id, kind, status) "
         "VALUES (:c, :t, :r, 'roadmap_items', 'pending')", c=cp, t=tenant, r=run)  # fmt: skip
    _run("INSERT INTO checkpoint_actions (id, tenant_id, checkpoint_id, item_key, kind, state) "
         "VALUES (gen_random_uuid(), :t, :c, 'a', 'drop', 'staged')", t=tenant, c=cp)  # fmt: skip

    command.upgrade(cfg, REVISION)

    assert _origin_columns() == ["discussion_change_id", "discussion_id", "from_private", "origin"]
    assert _run("SELECT origin, from_private FROM checkpoint_actions") == [("row", False)]
    with pytest.raises(Exception, match="ck_checkpoint_actions_origin"):
        _run("UPDATE checkpoint_actions SET origin = 'chat'")
    doc = uuid.uuid4()
    _run("INSERT INTO documents (id, tenant_id, slug, title, status) "
         "VALUES (:d, :t, 'doc', 'Doc', 'draft')", d=doc, t=tenant)  # fmt: skip
    insert = (
        "INSERT INTO next_draft_changes (id, tenant_id, document_id, section_key, "
        "raised_on_version, instruction, staged_by, discussion_change_id, status) VALUES "
        "(gen_random_uuid(), :t, :d, 'problem', 1, 'Say most', :u, :c, :s)"
    )
    change = uuid.uuid4()
    _run("ALTER TABLE next_draft_changes DROP CONSTRAINT "
         "fk_next_draft_changes_discussion_change_id_discussion_changes")  # fmt: skip
    _run(insert, t=tenant, d=doc, u=uuid.uuid4(), c=change, s="staged")
    _run(insert, t=tenant, d=doc, u=uuid.uuid4(), c=change, s="applied")
    with pytest.raises(Exception, match="uq_next_draft_changes_change_live"):
        _run(insert, t=tenant, d=doc, u=uuid.uuid4(), c=change, s="staged")
    with pytest.raises(Exception, match="ck_next_draft_changes_status"):
        _run(insert, t=tenant, d=doc, u=uuid.uuid4(), c=uuid.uuid4(), s="maybe")

    command.downgrade(cfg, PREVIOUS)
    assert _origin_columns() == [] and not _has_table()
    command.upgrade(cfg, REVISION)
    assert _has_table() and _origin_columns()
