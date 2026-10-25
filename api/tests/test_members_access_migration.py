"""Migration 0042_members_access (A5): names, invite expiry and resend, access requests.

Card: protects=an upgrade leaves nobody cut off (open invites get 14 days from the deploy,
others created_at + 14 days, names null) and a downgrade drops what it added;
fails_when=an open invite expires at once, the chain gains a second head, or the downgrade
leaves the table or the setting rows; no_claim=the API's use of the columns.

Sync tests on purpose (Alembic runs its own event loop); own scratch database.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0042_members_access"
BEFORE = "0041_subgoals"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_members_access")
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


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_one_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0055_late_answers"]
    assert script.get_revision(REVISION).down_revision == BEFORE


def test_upgrade_down_up_keeps_people_and_invites(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, BEFORE)
    tenant = uuid.uuid4()
    old = datetime.now(UTC) - timedelta(days=30)
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:i, :t, 'pat@example.com', 'x', 'viewer')",
        i=uuid.uuid4(),
        t=tenant,
    )
    for email, accepted, revoked in (
        ("open@example.com", None, None),
        ("done@example.com", old, None),
        ("gone@example.com", None, old),
    ):
        _run(
            "INSERT INTO invites (id, tenant_id, created_at, email, role, accepted_at, "
            "revoked_at) VALUES (:i, :t, :c, :e, 'viewer', :a, :r)",
            i=uuid.uuid4(), t=tenant, c=old, e=email, a=accepted, r=revoked,
        )  # fmt: skip

    command.upgrade(cfg, REVISION)
    rows = dict(_run("SELECT email, expires_at FROM invites"))
    now = datetime.now(UTC)
    assert abs(rows["open@example.com"] - (now + timedelta(days=14))) < timedelta(minutes=5)
    for email in ("done@example.com", "gone@example.com"):
        assert abs(rows[email] - (old + timedelta(days=14))) < timedelta(seconds=1)
    assert _run("SELECT name FROM users") == [(None,)]
    assert _run("SELECT DISTINCT name, resend_count FROM invites") == [(None, 0)]
    _run(
        "INSERT INTO access_requests (id, tenant_id, email) VALUES (:i, :t, 'x@example.com')",
        i=uuid.uuid4(),
        t=tenant,
    )
    with pytest.raises(IntegrityError):  # one pending row per email
        _run(
            "INSERT INTO access_requests (id, tenant_id, email) VALUES (:i, :t, 'x@example.com')",
            i=uuid.uuid4(),
            t=tenant,
        )
    with pytest.raises(IntegrityError):
        _run("UPDATE users SET name = :n", n="x" * 81)
    _run(
        "INSERT INTO tenant_settings (id, tenant_id, key, value) "
        "VALUES (:i, :t, 'sign_in_without_invite', '\"join\"')",
        i=uuid.uuid4(),
        t=tenant,
    )

    command.downgrade(cfg, BEFORE)
    assert _run("SELECT to_regclass('access_requests')") == [(None,)]
    assert _run("SELECT count(*) FROM tenant_settings") == [(0,)]
    assert _run("SELECT count(*) FROM invites") == [(3,)]
    command.upgrade(cfg, REVISION)
    assert _run("SELECT count(*) FROM users") == [(1,)]
