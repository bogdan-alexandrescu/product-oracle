"""Migration 0022_checkpoint_actions: the shared draft decision (D8).

Adds ``checkpoint_actions`` (one staged or suggested action per item, kind and field of a
pending checkpoint) and ``checkpoints.draft_note`` / ``draft_revision``; existing
checkpoints read revision 0 with no note. The downgrade drops all three.

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

REVISION = "0022_checkpoint_actions"
PREVIOUS = "0022_code_maps"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_checkpoint_actions")
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


def _draft_columns() -> list[str]:
    return sorted(
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'checkpoints' AND column_name LIKE 'draft_%'"
        )
    )


def _has_table() -> bool:
    return bool(_run("SELECT 1 FROM pg_tables WHERE tablename = 'checkpoint_actions'"))


def test_the_chain_ends_here_after_agent_staging():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0055_late_answers"]
    assert script.get_revision(REVISION).down_revision == PREVIOUS


def test_upgrade_adds_the_draft_and_downgrade_drops_it(scratch_db):
    """protects=the schema of the shared draft; fails_when=the table, its checks, its one
    slot per item, kind and field or the two columns drift; no_claim=data backfill (none)."""
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant, run, cp = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run("INSERT INTO runs (id, tenant_id, flow, status) VALUES (:r, :t, 'prd_to_roadmap', "
         "'awaiting_checkpoint')", r=run, t=tenant)  # fmt: skip
    _run("INSERT INTO checkpoints (id, tenant_id, run_id, kind, status) "
         "VALUES (:c, :t, :r, 'roadmap_items', 'pending')", c=cp, t=tenant, r=run)  # fmt: skip

    command.upgrade(cfg, REVISION)

    assert _draft_columns() == ["draft_note", "draft_revision"]
    assert _run("SELECT draft_note, draft_revision FROM checkpoints") == [(None, 0)]
    insert = (
        "INSERT INTO checkpoint_actions (id, tenant_id, checkpoint_id, item_key, kind, field, "
        "state) VALUES (gen_random_uuid(), :t, :c, 'a', :kind, :field, :state)"
    )
    _run(insert, t=tenant, c=cp, kind="edit", field="horizon", state="staged")
    _run(insert, t=tenant, c=cp, kind="accept", field=None, state="suggested")
    assert _run("SELECT answers FROM checkpoint_actions WHERE kind = 'accept'") == [([],)]
    # One action per item, kind and field (a null field is one slot too).
    with pytest.raises(Exception, match="ux_checkpoint_actions_slot"):
        _run(insert, t=tenant, c=cp, kind="accept", field=None, state="staged")
    with pytest.raises(Exception, match="ck_checkpoint_actions_kind"):
        _run(insert, t=tenant, c=cp, kind="bless", field=None, state="staged")
    with pytest.raises(Exception, match="ck_checkpoint_actions_state"):
        _run(insert, t=tenant, c=cp, kind="drop", field=None, state="maybe")
    for kind in ("look_again", "add", "waive", "question", "split", "merge", "restore"):
        _run(insert, t=tenant, c=cp, kind=kind, field=None, state="staged")
    # Deleting the checkpoint deletes its actions.
    _run("DELETE FROM checkpoints WHERE id = :c", c=cp)
    assert _run("SELECT count(*) FROM checkpoint_actions") == [(0,)]

    command.downgrade(cfg, PREVIOUS)
    assert _draft_columns() == [] and not _has_table()
    command.upgrade(cfg, REVISION)
    assert _has_table()
