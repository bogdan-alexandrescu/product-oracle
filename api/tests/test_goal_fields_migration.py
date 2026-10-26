"""Migration 0036_goal_fields: dated goal measurements and typed goal fields (B5).

Adds ``goal_measurements``; moves every goal value that does not fit the typed shape to
``<key>_text``; the downgrade writes the text back and drops the table.

Sync tests on purpose (Alembic runs its own event loop); own scratch database.
"""

import asyncio
import json
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0036_goal_fields"
PREVIOUS = "0035_track_alerts"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_goal_fields")
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


def _goal(tenant: uuid.UUID, key: str, attrs: dict) -> uuid.UUID:
    g = uuid.uuid4()
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, attrs, status, origin, locked) "
        "VALUES (:g, :t, 'goal', :k, :k, CAST(:a AS jsonb), 'confirmed', 'user', true)",
        g=g,
        t=tenant,
        k=key,
        a=json.dumps(attrs),
    )
    return g


def _attrs(g: uuid.UUID) -> dict:
    return _run("SELECT attrs FROM entities WHERE id = :g", g=g)[0][0]


def _tables() -> list[str]:
    rows = _run(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_name = 'goal_measurements'"
    )
    return [r[0] for r in rows]


# protects=the chain has one head, this one, right after main's; fails_when=a second head
# or a number that skips main's; no_claim=what the table holds.
def test_the_chain_ends_here_after_discussion_replies():
    script = ScriptDirectory.from_config(_cfg())
    # H2 Cadence engine's 0037_rituals chains on it; one head.
    assert script.get_heads() == ["0071_simple_roadmap_dates"]
    assert script.get_revision("0037_rituals").down_revision == REVISION
    assert script.get_revision(REVISION).down_revision == PREVIOUS


# protects=criterion 7: "45%", "2026-Q4", "below 8%" and a text owner move to *_text, a
# numeric weight stays, the downgrade restores every original value and drops the table;
# fails_when=a text value stays typed, a valid one moves, or the downgrade loses a value;
# no_claim=fill from text (its own tests).
def test_goal_text_moves_to_text_keys_and_back(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant, member = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'lead@example.com', 'x', 'approver')",
        u=member,
        t=tenant,
    )
    activation = {
        "metric": "Accounts that finish setup",
        "target": "45%",
        "horizon": "2026-Q4",
        "weight": 0.5,
        "owner": "Growth Lead",
    }
    churn = {"target": "below 8%", "weight": 0.2, "owner": str(member), "note": "kept"}
    a, c = _goal(tenant, "activation", activation), _goal(tenant, "churn", churn)

    command.upgrade(cfg, REVISION)
    assert _tables() == ["goal_measurements"]
    assert _attrs(a) == {
        "metric": "Accounts that finish setup",
        "weight": 0.5,
        "target_text": "45%",
        "horizon_text": "2026-Q4",
        "owner_text": "Growth Lead",
    }
    assert _attrs(c) == {
        "target_text": "below 8%",
        "weight": 0.2,
        "owner": str(member),
        "note": "kept",
    }
    locked = _run("SELECT locked, status FROM entities WHERE id = :g", g=a)[0]
    assert tuple(locked) == (True, "confirmed")

    command.downgrade(cfg, PREVIOUS)
    assert _tables() == []
    assert _attrs(a) == activation
    assert _attrs(c) == churn
    command.upgrade(cfg, REVISION)


# protects=review finding 3: after the upgrade no goal is left in a state the checks
# refuse: a target without its unit or comparison, a current without its day, a future
# day, a negative percentage and a metric that is not 3-200 characters move to *_text;
# the downgrade puts every value back as it was; fails_when=a goal keeps a refused value
# typed, so every later save of it is 422; no_claim=values that fit (the test above).
def test_goals_the_checks_refuse_are_normalised(scratch_db):
    from oracle.baseline import goals

    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    seeded = {
        "bare": {"target": 45, "weight": 2},
        "no_way": {"target": 45, "unit": "%", "current": 40},
        "future": {"current": 3, "current_as_of": "2999-01-01"},
        "negative": {"target": -5, "unit": "%", "comparison": "at_least"},
        "short_metric": {"metric": "x", "horizon": "short"},
        "fine": {"target": 45, "unit": "%", "comparison": "at_least", "current": 40,
                 "current_as_of": "2026-10-01"},
    }  # fmt: skip
    ids = {k: _goal(tenant, k, v) for k, v in seeded.items()}

    command.upgrade(cfg, REVISION)
    after = {k: _attrs(g) for k, g in ids.items()}
    for key, attrs in after.items():
        assert goals.field_problems(attrs) == [], (key, attrs)
    assert after["bare"] == {"target_text": "45", "weight": 2}
    assert after["no_way"] == {"target_text": "45", "unit_text": "%", "current_text": "40"}
    assert after["future"] == {"current_text": "3", "current_as_of_text": "2999-01-01"}
    assert after["negative"] == {
        "target_text": "-5",
        "unit_text": "%",
        "comparison_text": "at_least",
    }
    assert after["short_metric"] == {"metric_text": "x", "horizon": "short"}
    assert after["fine"] == seeded["fine"]

    command.downgrade(cfg, PREVIOUS)
    assert {k: _attrs(g) for k, g in ids.items()} == seeded
    command.upgrade(cfg, REVISION)
