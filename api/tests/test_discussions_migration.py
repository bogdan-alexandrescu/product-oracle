"""Migration 0022_discussions: the discussion model (G1).

Adds ``discussions``, ``discussion_participants``, ``discussion_messages`` and
``discussion_changes`` with their CHECKs; the downgrade drops the four tables and leaves
every other table as it was.

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

REVISION = "0022_discussions"
PREVIOUS = "0022_engineering_lead"
TABLES = ["discussion_changes", "discussion_messages", "discussion_participants", "discussions"]
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_discussions")
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


def _tables() -> list[str]:
    return sorted(
        r[0]
        for r in _run(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name LIKE 'discussion%'"
        )
    )


def _checks(table: str) -> set[str]:
    return {
        r[0]
        for r in _run(
            "SELECT conname FROM pg_constraint WHERE contype = 'c' "
            "AND conrelid = CAST(:t AS regclass)",
            t=table,
        )
    }


def _insert_discussion(tenant: uuid.UUID, **over) -> uuid.UUID:
    d = uuid.uuid4()
    values = {
        "subject_kind": "priorities",
        "subject_key": "priorities",
        "title": "Order",
        "visibility": "open",
        "status": "open",
        "origin": "discuss",
        **over,
    }
    _run(
        "INSERT INTO discussions (id, tenant_id, subject_kind, subject, subject_key, title, "
        "visibility, status, origin, started_by) VALUES (:d, :t, :subject_kind, '{}', "
        ":subject_key, :title, :visibility, :status, :origin, :u)",
        d=d,
        t=tenant,
        u=uuid.uuid4(),
        **values,
    )
    return d


# protects=the chain has one head, this one, right after main's; fails_when=a second head
# or a fixed number that skips main's; no_claim=what the tables hold.
def test_the_chain_ends_here_after_feedback_agent_staging():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0090_goal_suggestion_people"]
    assert script.get_revision(REVISION).down_revision == PREVIOUS


# protects=criterion 1: upgrade, downgrade, upgrade on an empty database and on one with
# discussions; the four tables and their CHECKs exist; fails_when=a step fails, a table or
# CHECK is missing, or the downgrade leaves a table behind; no_claim=the routes.
def test_upgrade_downgrade_upgrade_with_discussions_in_it(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    command.downgrade(cfg, PREVIOUS)
    assert _tables() == []
    command.upgrade(cfg, REVISION)
    assert _tables() == TABLES
    assert {
        "ck_discussions_subject_kind",
        "ck_discussions_title",
        "ck_discussions_visibility",
        "ck_discussions_status",
        "ck_discussions_origin",
        "ck_discussions_summary",
        "ck_discussions_summary_status",
    } <= _checks("discussions")
    assert {"ck_discussion_participants_added_via"} <= _checks("discussion_participants")
    assert {
        "ck_discussion_messages_author_kind",
        "ck_discussion_messages_via",
        "ck_discussion_messages_body",
        "ck_discussion_messages_status",
    } <= _checks("discussion_messages")
    assert {
        "ck_discussion_changes_kind",
        "ck_discussion_changes_rationale",
        "ck_discussion_changes_proposed_by_kind",
        "ck_discussion_changes_status",
    } <= _checks("discussion_changes")

    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    d = _insert_discussion(tenant)
    _run(
        "INSERT INTO discussion_messages (id, tenant_id, discussion_id, author_kind, body) "
        "VALUES (:m, :t, :d, 'system', 'Opened')",
        m=uuid.uuid4(),
        t=tenant,
        d=d,
    )
    _run(
        "INSERT INTO discussion_changes (id, tenant_id, discussion_id, kind, target, payload, "
        "proposed_by_kind) VALUES (:c, :t, :d, 'priority_pin', '{}', '{}', 'oracle')",
        c=uuid.uuid4(),
        t=tenant,
        d=d,
    )
    assert _run("SELECT visibility, lock_version, summary_status FROM discussions") == [
        ("open", 1, "none")
    ]
    for bad in ({"visibility": "secret"}, {"subject_kind": "inbox"}, {"title": ""}):
        with pytest.raises(IntegrityError):
            _insert_discussion(tenant, **bad)

    command.downgrade(cfg, PREVIOUS)
    assert _tables() == []
    assert _run("SELECT count(*) FROM tenants") == [(1,)]
    command.upgrade(cfg, REVISION)
    assert _tables() == TABLES
