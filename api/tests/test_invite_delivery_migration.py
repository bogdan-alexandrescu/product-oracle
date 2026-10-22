"""Migration 0022_invite_delivery: what happened to an invite (#242, A5).

Adds ``invites.access`` (granted / pending / skipped), ``access_error``, ``access_at``,
``email_status`` (queued / sent / failed / not_sent), ``email_error`` and ``email_at``.
An open invite made before it is ``pending`` (nobody granted its IAP access yet, so the
Members page offers Retry) and ``not_sent``; the downgrade drops the columns.

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
from sqlalchemy.exc import IntegrityError

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0022_invite_delivery"
COLUMNS = ["access", "access_at", "access_error", "email_at", "email_error", "email_status"]
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_invite_delivery")
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


def _columns() -> list[str]:
    return sorted(
        r[0]
        for r in _run(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'invites' "
            "AND (column_name LIKE 'access%' OR column_name LIKE 'email\\_%')"
        )
    )


def test_the_chain_after_feedback_agent_staging():
    script = ScriptDirectory.from_config(_cfg())
    # 0022_baseline_flow (B1) and the train's revisions chain on it; one head.
    assert script.get_heads() == ["0025_discussion_replies"]
    assert script.get_revision(REVISION).down_revision == "0021_feedback_agent_staging"
    assert script.get_revision("0022_baseline_flow").down_revision == REVISION


def test_upgrade_adds_the_delivery_columns_and_downgrade_drops_them(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0021_feedback_agent_staging")
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run(
        "INSERT INTO invites (id, tenant_id, email, role) VALUES (:i, :t, 'pat@example.com', "
        "'viewer')",
        i=uuid.uuid4(),
        t=tenant,
    )

    command.upgrade(cfg, REVISION)

    assert _columns() == COLUMNS
    assert _run("SELECT access, access_error, email_status, email_at FROM invites") == [
        ("pending", None, "not_sent", None)
    ]
    for column, value in (("access", "maybe"), ("email_status", "lost")):
        with pytest.raises(IntegrityError):
            _run(f"UPDATE invites SET {column} = :v", v=value)
    # A failed IAP access change is owed as a follow-up, with the address it is for.
    member = uuid.uuid4()
    _run(
        "INSERT INTO member_follow_ups (id, tenant_id, member_id, kind, target_id, email, "
        "status, attempts) VALUES (:i, :t, :m, 'iap_revoke', :m, 'pat@example.com', "
        "'pending', 1)",
        i=uuid.uuid4(),
        t=tenant,
        m=member,
    )
    with pytest.raises(IntegrityError):
        _run("UPDATE member_follow_ups SET kind = 'iap_maybe'")

    command.downgrade(cfg, "0021_feedback_agent_staging")
    assert _columns() == []
    assert _run("SELECT count(*) FROM invites") == [(1,)]
    assert _run("SELECT count(*) FROM member_follow_ups") == [(0,)]
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO member_follow_ups (id, tenant_id, member_id, kind, target_id, status, "
            "attempts) VALUES (:i, :t, :m, 'iap_grant', :m, 'pending', 0)",
            i=uuid.uuid4(),
            t=tenant,
            m=member,
        )
