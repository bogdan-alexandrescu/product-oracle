"""Migration 0020_decisions: the decision log (H1). Upgrade backfills accepted gap risks and
assumptions, the decided CHECK allows a null review date only for checkpoint records, the
downgrade drops both tables, the synced baseline entities and the setting key.

Sync on purpose (Alembic runs its own event loop); its own scratch database. Each test
states its card (protects / fails_when / no_claim)."""

import asyncio
import uuid
from datetime import UTC, date, datetime

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0020_decisions"
PREVIOUS = "0014_account_fixes"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_decisions")
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


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def _company() -> tuple[uuid.UUID, uuid.UUID]:
    t, u = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'owner@example.com', 'x', 'owner')",
        u=u,
        t=t,
    )
    return t, u


def _assumption(t, u, decision: str, statement: str, review: datetime | None) -> uuid.UUID:
    a = uuid.uuid4()
    _run(
        "INSERT INTO assumption_decisions (id, tenant_id, statement, decision, rationale, "
        "decided_by, review_at) VALUES (:a, :t, :s, :d, 'Measured in the pilot', :u, :r)",
        a=a,
        t=t,
        s=statement,
        d=decision,
        u=u,
        r=review,
    )
    return a


def test_chains_on_the_single_head():
    """protects=the revision chains after main's head and leaves exactly one head;
    fails_when=a second head appears; no_claim=none beyond protects."""
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0030_interviews"]


def test_upgrade_backfills_accepted_assumptions_and_downgrade_removes_it_all(scratch_db):
    """protects=upgrade adds one decided record per accepted risk or assumption (with its
    review date and its locked decision entity d-<n>), none for validate/reject; downgrade
    drops the tables, the synced decision entities and the setting key, leaving the source
    rows; fails_when=a backfill or its entity is missing or doubled, or anything survives
    the downgrade; no_claim=none beyond protects."""
    command.upgrade(_cfg(), PREVIOUS)
    t, u = _company()
    risk = _assumption(
        t, u, "accept_risk", "Partner quota holds", datetime(2026, 12, 1, tzinfo=UTC)
    )
    assumed = _assumption(t, u, "accept_assumption", "Buyers keep one address", None)
    _assumption(t, u, "validate", "Measured", None)
    _assumption(t, u, "reject", "Rejected", None)

    command.upgrade(_cfg(), REVISION)
    assert {"decisions", "decision_reviews"} <= _tables()
    got = _run(
        "SELECT number, status, origin, class, source_kind, source_id, review_at, approver_id "
        "FROM decisions ORDER BY number"
    )
    assert [(r[0], r[1], r[2], r[3], r[4]) for r in got] == [
        (1, "decided", "assumption", "judgement", "assumption_decision"),
        (2, "decided", "assumption", "judgement", "assumption_decision"),
    ]
    assert {r[5] for r in got} == {risk, assumed}
    by_source = {r[5]: r for r in got}
    assert str(by_source[risk][6]) == "2026-12-01"
    assert by_source[assumed][6] is not None  # decided date + 90 days
    assert {r[7] for r in got} == {u}
    # Each in the Baseline graph as live capture leaves it: its locked decision entity.
    synced = _run(
        "SELECT e.key, e.status, e.locked, e.attrs->>'decision_id', d.id, d.entity_ids, "
        "(SELECT count(*) FROM entity_revisions r WHERE r.entity_id = e.id) "
        "FROM decisions d JOIN entities e ON e.id = d.entity_id ORDER BY d.number"
    )
    assert [(r[0], r[1], r[2]) for r in synced] == [
        ("d-1", "confirmed", True),
        ("d-2", "confirmed", True),
    ]
    assert all(r[3] == str(r[4]) and r[5] == [] and r[6] == 1 for r in synced)

    # The setting, as the app would leave it.
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, status, origin, attrs, locked) "
        "VALUES (gen_random_uuid(), :t, 'decision', 'non-goal', 'kept', 'confirmed', 'user', "
        "'{}', false)",
        t=t,
    )
    _run(
        "INSERT INTO tenant_settings (id, tenant_id, key, value) "
        "VALUES (gen_random_uuid(), :t, 'decision_irreversible_role', '\"approver\"')",
        t=t,
    )

    command.downgrade(_cfg(), PREVIOUS)
    assert not {"decisions", "decision_reviews"} & _tables()
    assert [r[0] for r in _run("SELECT key FROM entities")] == ["non-goal"]
    assert _run("SELECT key FROM tenant_settings") == []
    assert len(_run("SELECT id FROM assumption_decisions")) == 4


def test_decided_check_allows_a_null_review_date_only_for_checkpoints(scratch_db):
    """protects=a decided judgement call needs a review date and a decided checkpoint
    record may have none; numbers and sources are unique per company; fails_when=either
    rule is not enforced by the database; no_claim=none beyond protects."""
    command.upgrade(_cfg(), REVISION)
    t, u = _company()

    def insert(origin: str, number: int, review: date | None, source: uuid.UUID | None = None):
        _run(
            "INSERT INTO decisions (id, tenant_id, number, title, status, approver_id, driver, "
            "origin, chosen_option, rationale, decided_at, review_at, source_kind, source_id) "
            "VALUES (gen_random_uuid(), :t, :n, 'x', 'decided', :u, 'oracle', :o, 'approve', "
            "'ok', now(), :r, :sk, :s)",
            t=t,
            n=number,
            u=u,
            o=origin,
            r=review,
            sk="checkpoint" if source else None,
            s=source,
        )

    insert("checkpoint", 1, None, uuid.uuid4())
    with pytest.raises(IntegrityError):
        insert("manual", 2, None)
    insert("manual", 2, date(2027, 1, 1))
    with pytest.raises(IntegrityError):
        insert("manual", 2, date(2027, 1, 1))
    cp = uuid.uuid4()
    insert("checkpoint", 3, None, cp)
    with pytest.raises(IntegrityError):
        insert("checkpoint", 4, None, cp)
    assert [r[0] for r in _run("SELECT class FROM decisions ORDER BY number")] == [
        "checkpoint",
        "judgement",
        "checkpoint",
    ]
