"""Migration 0020_requests: three new tables, two widened checks, reversible.

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

REVISION = "0020_requests"
BEFORE = "0020_alignment_reports"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_requests")
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


def _tables() -> set[str]:
    rows = _run(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN "
        "('request_themes', 'product_requests', 'request_candidates')"
    )
    return {r[0] for r in rows}


def _check(constraint: str) -> str:
    return _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :n", n=constraint
    )[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_after_mains_head_with_a_single_head():
    """protects=one alembic head; fails_when=the migration forks the chain;
    no_claim=other lanes' later migrations."""
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == BEFORE
    assert script.get_heads() == ["0025_interviews"]


def test_the_migration_imports_no_application_code():
    """protects=a migration runs as written forever; fails_when=it imports oracle code
    that can change after it ships; no_claim=what the frozen helpers do (below)."""
    path = API_DIR / "migrations" / "versions" / f"{REVISION}.py"
    source = path.read_text()
    assert "from oracle" not in source and "import oracle" not in source


def test_upgrade_on_a_seeded_db_and_downgrade_reverses(scratch_db):
    """protects=additive tables and checks, existing runs untouched, a clean downgrade;
    fails_when=a check is missing, existing rows change or the downgrade leaves a table;
    no_claim=the routes."""
    cfg = _cfg()
    command.upgrade(cfg, BEFORE)
    t, run = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) VALUES (:r, :t, 'feedback_loop', 'draft')",
        r=run,
        t=t,
    )
    flows_before = _check("ck_runs_flow")

    command.upgrade(cfg, REVISION)
    assert _tables() == {"request_themes", "product_requests", "request_candidates"}
    assert _run("SELECT flow FROM runs") == [("feedback_loop",)]
    assert "'request_triage'" in _check("ck_runs_flow")
    assert "'request_triage'" in _check("ck_checkpoints_kind")
    for value in ("baseline_to_prd", "feedback_loop", "prd_to_roadmap"):
        assert f"'{value}'" in _check("ck_runs_flow")

    theme, a, b = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run(
        "INSERT INTO request_themes (id, tenant_id, title, origin) "
        "VALUES (:i, :t, 'Faster check-out', 'person')",
        i=theme,
        t=t,
    )
    with pytest.raises(Exception, match="ux_request_themes_title"):
        _run(
            "INSERT INTO request_themes (id, tenant_id, title, origin) "
            "VALUES (gen_random_uuid(), :t, 'FASTER check-out', 'oracle')",
            t=t,
        )
    insert = (
        "INSERT INTO product_requests (id, tenant_id, title, channel, origin, theme_id) "
        "VALUES (:i, :t, 'Saved addresses', 'sales', 'person', :th)"
    )
    _run(insert, i=a, t=t, th=theme)
    _run(insert, i=b, t=t, th=theme)
    assert _run("SELECT state, requester_kind, verified, lock_version FROM product_requests "
                "WHERE id = :i", i=a) == [("new", "unknown", True, 1)]  # fmt: skip
    with pytest.raises(Exception, match="ck_product_requests_merged"):
        _run("UPDATE product_requests SET state = 'merged' WHERE id = :i", i=a)
    with pytest.raises(Exception, match="ck_product_requests_disqualified"):
        _run("UPDATE product_requests SET state = 'disqualified' WHERE id = :i", i=a)
    with pytest.raises(Exception, match="ck_product_requests_not_self"):
        _run(
            "UPDATE product_requests SET state = 'merged', merged_into_id = id WHERE id = :i",
            i=a,
        )
    with pytest.raises(Exception, match="ck_product_requests_source_excerpt"):
        _run("UPDATE product_requests SET source_excerpt = repeat('x', 401) WHERE id = :i", i=a)
    with pytest.raises(Exception, match="ck_product_requests_channel"):
        _run("UPDATE product_requests SET channel = 'email' WHERE id = :i", i=a)
    _run(
        "UPDATE product_requests SET state = 'merged', merged_into_id = :b WHERE id = :i",
        i=a,
        b=b,
    )

    command.downgrade(cfg, BEFORE)
    assert _tables() == set()
    assert _check("ck_runs_flow") == flows_before
    assert "request_triage" not in _check("ck_checkpoints_kind")
    command.upgrade(cfg, REVISION)
    assert _run("SELECT count(*) FROM product_requests") == [(0,)]


def test_downgrade_refuses_while_a_triage_run_exists(scratch_db):
    """protects=the rollback note (delete request_triage runs first); fails_when=the
    downgrade drops the flow under a live row; no_claim=the flow (lane 3)."""
    cfg = _cfg()
    command.upgrade(cfg, REVISION)
    t = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (gen_random_uuid(), :t, 'request_triage', 'draft')",
        t=t,
    )
    with pytest.raises(Exception, match="request_triage"):
        command.downgrade(cfg, BEFORE)
    _run("DELETE FROM runs")
    command.downgrade(cfg, BEFORE)
    assert _tables() == set()


def test_widened_checks_keep_other_lanes_values(scratch_db):
    """protects=additive check edits; fails_when=the upgrade or downgrade drops a value
    another lane added; no_claim=which lanes add values."""
    cfg = _cfg()
    command.upgrade(cfg, BEFORE)
    for table, name, column in (("runs", "ck_runs_flow", "flow"),
                                ("checkpoints", "ck_checkpoints_kind", "kind")):  # fmt: skip
        values = _check(name)
        _run(f"ALTER TABLE {table} DROP CONSTRAINT {name}")
        head = f"({column} = ANY (ARRAY["
        widened = values.replace(head, f"{head}'x_lane'::text, ")
        _run(f"ALTER TABLE {table} ADD CONSTRAINT {name} {widened}")
    command.upgrade(cfg, REVISION)
    assert "'x_lane'" in _check("ck_runs_flow") and "'request_triage'" in _check("ck_runs_flow")
    command.downgrade(cfg, BEFORE)
    assert "'x_lane'" in _check("ck_runs_flow") and "'x_lane'" in _check("ck_checkpoints_kind")


def test_the_models_list_every_value_the_migrated_checks_allow(scratch_db):
    """protects=one list per check in the models; fails_when=the database allows a flow
    or checkpoint kind the models do not name; no_claim=the flow definitions (lane 3)."""
    from oracle.runs.models import CHECKPOINT_KINDS, FLOWS

    command.upgrade(_cfg(), "head")
    flows = set(_check("ck_runs_flow").split("'")[1::2])
    kinds = set(_check("ck_checkpoints_kind").split("'")[1::2])
    assert flows == set(FLOWS)
    assert kinds == set(CHECKPOINT_KINDS)
