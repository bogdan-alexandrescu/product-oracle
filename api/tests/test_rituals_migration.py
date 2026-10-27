"""Migration 0037_rituals (H2 Cadence engine): the rituals, ritual_occurrences and
ritual_reads tables and the ritual_summary flow; the downgrade drops them and the two
settings keys. Sync on purpose (Alembic runs its own event loop); its own scratch
database.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
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

REVISION = "0037_rituals"
PREVIOUS = "0036_goal_fields"
TABLES = {"rituals", "ritual_occurrences", "ritual_reads"}
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_rituals")
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


def _tables() -> set[str]:
    rows = _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    return {r[0] for r in rows}


def _flow_check() -> str:
    return _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_runs_flow'"
    )[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_b5s_head():
    """protects=one head, chained after 0036_goal_fields; fails_when=a second head or a
    fixed parent other than B5's; no_claim=later lanes' re-chaining."""
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    # H3's 0038_outcome_tracking chains on it; one head.
    assert script.get_heads() == ["0080_simple_one_pagers"]
    assert script.get_revision("0038_outcome_tracking").down_revision == REVISION


def test_upgrade_and_downgrade(scratch_db):
    """protects=the upgrade adds the three tables and the ritual_summary flow (other flows
    kept) and the unique (ritual_id, due_at); the downgrade drops them, the ritual_summary
    runs and the two settings keys; fails_when=a table or value is left behind, or
    another flow's value is dropped; no_claim=data written by the service."""
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    assert not (TABLES & _tables())
    command.upgrade(cfg, REVISION)
    assert TABLES <= _tables()
    check = _flow_check()
    assert "'ritual_summary'" in check and "'update_draft'" in check
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    ritual = uuid.uuid4()
    _run(
        "INSERT INTO rituals (id, tenant_id, kind, title, schedule, duration_min, prep_hours, "
        "owner_id) VALUES (:id, :t, 'custom', 'Pricing sync', '{}', 30, 12, :o)",
        id=ritual, t=tenant, o=uuid.uuid4(),
    )  # fmt: skip
    insert = (
        "INSERT INTO ritual_occurrences (id, tenant_id, ritual_id, due_at, ends_at) "
        "VALUES (gen_random_uuid(), :t, :r, '2026-11-03T10:00Z', '2026-11-03T11:00Z')"
    )
    _run(insert, t=tenant, r=ritual)
    with pytest.raises(Exception, match="ritual_id"):
        _run(insert, t=tenant, r=ritual)
    _run(
        "INSERT INTO tenant_settings (id, tenant_id, key, value) VALUES "
        "(gen_random_uuid(), :t, 'company_timezone', '\"Europe/Paris\"')",
        t=tenant,
    )
    command.downgrade(cfg, PREVIOUS)
    assert not (TABLES & _tables())
    assert "'ritual_summary'" not in _flow_check() and "'update_draft'" in _flow_check()
    assert _run("SELECT count(*) FROM tenant_settings WHERE key = 'company_timezone'") == [(0,)]
