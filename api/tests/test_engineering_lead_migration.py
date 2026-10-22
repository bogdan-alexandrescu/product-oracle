"""Migration 0022_engineering_lead: the engineering lead flag on users and invites (A3).

Adds ``users.engineering_lead`` and ``invites.engineering_lead`` (boolean, not null,
default false) and a check on each that a viewer never carries it; existing rows read
false, and the downgrade drops the checks, then the columns.

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

REVISION = "0022_engineering_lead"
PREVIOUS = "0022_baseline_flow"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_engineering_lead")
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
        f"{r[0]}.{r[1]}"
        for r in _run(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE column_name = 'engineering_lead'"
        )
    )


def _checks() -> list[str]:
    return sorted(
        r[0]
        for r in _run(
            "SELECT conname FROM pg_constraint WHERE conname LIKE 'ck_%_engineering_lead_role'"
        )
    )


def test_the_chain_ends_here_after_feedback_agent_staging():
    # protects=one alembic head; fails_when=a second head or a fixed down_revision drifts;
    # no_claim=the columns (below).
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0025_goal_fields"]
    assert script.get_revision(REVISION).down_revision == PREVIOUS


def test_up_down_up_keeps_members_and_invites(scratch_db):
    # protects=AC14, the migration on a database holding users and invites; fails_when=a
    # row is lost, an existing row reads true, or the downgrade leaves a column or check;
    # no_claim=the API.
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES "
        "(:a, :t, 'a@example.com', 'x', 'commenter'), (:b, :t, 'b@example.com', 'x', 'viewer')",
        a=uuid.uuid4(),
        b=uuid.uuid4(),
        t=tenant,
    )
    _run(
        "INSERT INTO invites (id, tenant_id, email, role) "
        "VALUES (:i, :t, 'c@example.com', 'viewer')",
        i=uuid.uuid4(),
        t=tenant,
    )

    command.upgrade(cfg, REVISION)
    assert _columns() == ["invites.engineering_lead", "users.engineering_lead"]
    assert _checks() == ["ck_invites_engineering_lead_role", "ck_users_engineering_lead_role"]
    assert _run("SELECT DISTINCT engineering_lead FROM users") == [(False,)]
    assert _run("SELECT engineering_lead FROM invites") == [(False,)]

    command.downgrade(cfg, PREVIOUS)
    assert _columns() == [] and _checks() == []
    assert _run("SELECT count(*) FROM users") == [(2,)]
    assert _run("SELECT count(*) FROM invites") == [(1,)]

    command.upgrade(cfg, REVISION)
    assert _run("SELECT count(*) FROM users WHERE engineering_lead = false") == [(2,)]
    _run("UPDATE users SET engineering_lead = true WHERE email = 'a@example.com'")
    with pytest.raises(Exception, match="ck_users_engineering_lead_role"):
        _run("UPDATE users SET engineering_lead = true WHERE role = 'viewer'")
