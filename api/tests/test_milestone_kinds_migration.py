"""Migration 0125_milestone_kinds (owner): every roadmap milestone is one of six kinds.

Card: protects=the upgrade adds the kind, done-when line, status override and measure
columns to ``track_milestones`` and ``roadmap_key_dates`` and ``on_roadmap`` to goals; a
goal's key-result milestone becomes a ``sub_goal`` while a PRD's milestone and a key date
stay ``delivery``; the downgrade drops them all and a second upgrade works again;
fails_when=a column is missing, the backfill marks the wrong rows, or the downgrade leaves a
column. Sync on purpose (Alembic runs its own loop)."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0125_milestone_kinds"
PREVIOUS = "0124_track_prds"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_milestone_kinds")
    .render_as_string(hide_password=False)
)
NEW = {
    "kind", "done_when_line", "status_set", "status_set_by", "status_reason", "measure",
    "baseline", "target", "current", "sub_goal_of_id", "from_track_id", "to_track_id",
}  # fmt: skip


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


def _columns(table: str) -> set[str]:
    rows = _run("SELECT column_name FROM information_schema.columns WHERE table_name = :t", t=table)
    return {r[0] for r in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert len(script.get_heads()) == 1


def test_upgrade_backfills_kinds_and_downgrade_drops_them(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant, roadmap, prd, goal, user = (uuid.uuid4() for _ in range(5))
    key_result, prd_ms, plain, key_date = (uuid.uuid4() for _ in range(4))
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    for doc, slug, kind in ((roadmap, "launch", "roadmap"), (prd, "setup", "prd")):
        _run(
            "INSERT INTO documents (id, tenant_id, slug, title, kind, status) "
            "VALUES (:d, :t, :s, :s, :k, 'draft')",
            d=doc, t=tenant, s=slug, k=kind,
        )  # fmt: skip
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, status, origin) "
        "VALUES (:g, :t, 'goal', 'activation', 'Activation', 'confirmed', 'user')",
        g=goal, t=tenant,
    )  # fmt: skip
    for mid, name, goal_id, origin in (
        (key_result, "Ten teams set up", goal, None),
        (prd_ms, "Prove it", goal, prd),
        (plain, "Launch day", None, None),
    ):
        _run(
            "INSERT INTO track_milestones (id, tenant_id, name, roadmap_id, goal_id, "
            "origin_prd_id, code) VALUES (:m, :t, :n, :r, :g, :o, 'M1')",
            m=mid, t=tenant, n=name, r=roadmap, g=goal_id, o=origin,
        )  # fmt: skip
    _run(
        "INSERT INTO roadmap_key_dates (id, tenant_id, roadmap_document_id, name, on_date, "
        "created_by) VALUES (:k, :t, :r, 'Expo', '2026-12-01', :u)",
        k=key_date, t=tenant, r=roadmap, u=user,
    )  # fmt: skip

    command.upgrade(_cfg(), REVISION)
    assert NEW <= _columns("track_milestones")
    assert NEW <= _columns("roadmap_key_dates")
    assert "on_roadmap" in _columns("entities")
    kinds = dict(_run("SELECT id, kind FROM track_milestones"))
    assert kinds == {key_result: "sub_goal", prd_ms: "delivery", plain: "delivery"}
    assert _run("SELECT kind, done_when_line FROM roadmap_key_dates") == [("delivery", "")]
    assert _run("SELECT on_roadmap FROM entities") == [(True,)]
    with pytest.raises(Exception, match="kind"):
        _run("UPDATE track_milestones SET kind = 'party' WHERE id = :m", m=plain)
    with pytest.raises(Exception, match="status_set"):
        _run("UPDATE roadmap_key_dates SET status_set = 'late' WHERE id = :k", k=key_date)

    command.downgrade(_cfg(), PREVIOUS)
    assert not NEW & _columns("track_milestones")
    assert not NEW & _columns("roadmap_key_dates")
    assert "on_roadmap" not in _columns("entities")

    command.upgrade(_cfg(), REVISION)
    assert dict(_run("SELECT id, kind FROM track_milestones"))[key_result] == "sub_goal"
