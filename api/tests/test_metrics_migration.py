"""Migration 0050_metrics (H5 Metrics review): the metrics, metric_values and
metric_variances tables, ``goal_measurements.metric_id``, ``company_integrations.config``
and the ``posthog``/``metrics`` check values; lane 2 adds the ``metrics_variance`` run
flow.

Card: protects=the tables, columns and check values come and go with the revision, a
week value must be a Monday, and two companies may connect the same PostHog project;
fails_when=the upgrade misses one, the downgrade leaves one behind or keeps a PostHog row
its checks no longer allow; no_claim=the application's use of the tables
(tests/test_metrics*.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid
from datetime import date

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0050_metrics"
PREVIOUS = "0049_request_replies"
TABLES = {"metrics", "metric_values", "metric_variances"}
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_metrics")
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
    return {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


def _columns(table: str) -> set[str]:
    rows = _run("SELECT column_name FROM information_schema.columns WHERE table_name = :t", t=table)
    return {r[0] for r in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_mains_head_and_is_the_only_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0092_bet_flow_line_key"]


def _posthog(t: uuid.UUID, by: uuid.UUID) -> None:
    _run(
        "INSERT INTO company_integrations (id, tenant_id, provider, purpose, account_id, "
        "ciphertext, key_version, installed_by, config) VALUES (:i, :t, 'posthog', 'metrics', "
        "'12345', 'x', 1, :by, '{\"host\": \"eu\", \"project_id\": \"12345\"}')",
        i=uuid.uuid4(), t=t, by=by,
    )  # fmt: skip


def test_upgrade_and_downgrade_on_a_seeded_database(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t, other, owner, metric = (uuid.uuid4() for _ in range(4))
    for tenant in (t, other):
        _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    command.upgrade(cfg, REVISION)
    assert TABLES <= _tables()
    assert "metric_id" in _columns("goal_measurements")
    assert "config" in _columns("company_integrations")
    # Two companies may read the same PostHog project.
    _posthog(t, owner)
    _posthog(other, owner)
    _run(
        "INSERT INTO metrics (id, tenant_id, title, description, kind, unit, direction, "
        "owner_id, source) VALUES (:m, :t, 'Weekly active teams', 'Teams active', 'output', "
        "'teams', 'up', :o, 'manual')",
        m=metric, t=t, o=owner,
    )  # fmt: skip
    insert_value = (
        "INSERT INTO metric_values (id, tenant_id, metric_id, week_start, value, source, "
        "definition_version) VALUES (:i, :t, :m, :w, 1, 'manual', 1)"
    )
    _run(insert_value, i=uuid.uuid4(), t=t, m=metric, w=date(2026, 10, 12))
    with pytest.raises(IntegrityError):
        _run(insert_value, i=uuid.uuid4(), t=t, m=metric, w=date(2026, 10, 13))
    command.downgrade(cfg, PREVIOUS)
    assert not TABLES & _tables()
    assert "metric_id" not in _columns("goal_measurements")
    assert "config" not in _columns("company_integrations")
    assert _run("SELECT count(*) FROM company_integrations")[0][0] == 0
    command.upgrade(cfg, REVISION)
    assert TABLES <= _tables()


def _flows() -> list[str]:
    (definition,) = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_runs_flow'"
    )[0]
    return definition


# protects=lane 2: the revision lets runs.flow hold metrics_variance (the metrics review's
# explanation run), keeps every other flow, and the downgrade removes it only while no run
# uses it; fails_when=a metrics_variance run is refused after the upgrade, another flow is
# lost, or a run in use breaks the downgrade; no_claim=the run itself
# (tests/test_metrics_review.py).
def test_the_metrics_variance_flow_comes_and_goes(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    assert "metrics_variance" not in _flows()
    command.upgrade(cfg, REVISION)
    assert "'metrics_variance'" in _flows() and "'ritual_summary'" in _flows()
    command.downgrade(cfg, PREVIOUS)
    assert "metrics_variance" not in _flows() and "'ritual_summary'" in _flows()
