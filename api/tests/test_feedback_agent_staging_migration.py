"""Migration 0021_feedback_agent_staging: feedback items staged for the agents (D12).

Adds the nullable ``feedback_items.staged_for_agents_at`` and ``staged_for_agents_by``;
existing items stay unstaged, and the downgrade drops both.

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

REVISION = "0021_feedback_agent_staging"
COLUMNS = ["staged_for_agents_at", "staged_for_agents_by"]
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_agent_staging")
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


def _columns() -> list[str]:
    return sorted(
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'feedback_items' AND column_name LIKE 'staged_for_agents%'"
        )
    )


def test_the_chain_after_feedback_authors():
    script = ScriptDirectory.from_config(_cfg())
    # 0022_invite_delivery (A5) chains on it, then 0022_baseline_flow (B1),
    # 0022_engineering_lead (A3), 0022_discussions (G1), 0022_priority_snapshot_runs (C8),
    # C9 Move and pin's 0022_priority_overrides, 0022_code_maps (F5-2),
    # 0022_checkpoint_actions (D8), 0022_updates (H8), 0023_source_partial_sync (#249),
    # 0023_intake_brief_fields (C4) and 0024_segment_skipped; one head.
    assert script.get_heads() == ["0055_slack_pings"]
    assert script.get_revision("0022_invite_delivery").down_revision == REVISION
    assert script.get_revision("0022_baseline_flow").down_revision == "0022_invite_delivery"
    assert script.get_revision("0022_engineering_lead").down_revision == "0022_baseline_flow"
    assert script.get_revision("0022_discussions").down_revision == "0022_engineering_lead"
    assert script.get_revision("0022_priority_snapshot_runs").down_revision == "0022_discussions"
    assert script.get_revision("0022_priority_overrides").down_revision == (
        "0022_priority_snapshot_runs"
    )
    assert script.get_revision("0022_checkpoint_actions").down_revision == "0022_code_maps"
    assert script.get_revision("0022_updates").down_revision == "0022_checkpoint_actions"
    assert script.get_revision("0023_source_partial_sync").down_revision == "0022_updates"
    assert script.get_revision("0023_intake_brief_fields").down_revision == (
        "0023_source_partial_sync"
    )
    assert script.get_revision("0024_segment_skipped").down_revision == "0023_intake_brief_fields"
    assert script.get_revision(REVISION).down_revision == "0020_prd_scopes"


def test_upgrade_adds_the_staging_columns_and_downgrade_drops_them(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0020_prd_scopes")
    tenant, doc, item = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'prd', 'PRD', 'draft')",
        d=doc,
        t=tenant,
    )
    _run(
        "INSERT INTO feedback_items (id, tenant_id, document_id, raised_on_version, kind, "
        "summary, status) VALUES (:i, :t, :d, 1, 'general', 'Whole draft', 'open')",
        i=item,
        t=tenant,
        d=doc,
    )

    command.upgrade(cfg, REVISION)

    assert _columns() == COLUMNS
    assert _run("SELECT staged_for_agents_at, staged_for_agents_by FROM feedback_items") == [
        (None, None)
    ]

    command.downgrade(cfg, "0020_prd_scopes")
    assert _columns() == []
    assert _run("SELECT count(*) FROM feedback_items") == [(1,)]
