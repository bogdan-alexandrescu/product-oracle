"""Test harness. Needs a Postgres database it may wipe: ORACLE_TEST_DATABASE_URL.

The schema is built once per run with ``alembic upgrade head`` (so every run also
proves the migration applies to an empty database); tables are truncated after
each test.
"""

import asyncio
import os
import uuid
from pathlib import Path

# CI sets this; without it the tests try a local Postgres and, if none answers, the
# database-backed tests are skipped (DB-free ones, e.g. tests/connectors, still run).
_EXPLICIT_DATABASE = "ORACLE_TEST_DATABASE_URL" in os.environ
BASE_TEST_DATABASE_URL = os.environ.get(
    "ORACLE_TEST_DATABASE_URL",
    "postgresql+asyncpg://oracle:oracle@localhost:5432/oracle_test",
)
# Under pytest-xdist each worker gets its own database (oracle_test_gw0, ...), created
# on demand, because every run wipes the schema.
_WORKER = os.environ.get("PYTEST_XDIST_WORKER")
TEST_DATABASE_URL = f"{BASE_TEST_DATABASE_URL}_{_WORKER}" if _WORKER else BASE_TEST_DATABASE_URL
# Must happen before oracle.config.get_settings() is first called.
os.environ["ORACLE_DATABASE_URL"] = TEST_DATABASE_URL
# No background sweep of the Claude account pool while tests run; tests call it.
os.environ["ORACLE_CLAUDE_SWEEP_SECONDS"] = "0"
# Nor the built-in job worker; tests run jobs themselves.
os.environ["ORACLE_LLM_JOBS_WORKER_SECONDS"] = "0"
# Nor E1's derivations of PRD drafts' roadmap items (tests/test_draft_roadmaps.py turns
# them on): they would take the runtime outcomes a test scripts for its own runs.
os.environ["ORACLE_DRAFT_ROADMAPS_START"] = "0"
# The test build: users and invites at example.com and other reserved domains are fine.
os.environ["ORACLE_ALLOW_RESERVED_EMAIL_DOMAINS"] = "1"

import httpx  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import make_url, text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

import oracle.models  # noqa: E402,F401
from oracle.db import Base, get_engine  # noqa: E402
from oracle.models import Tenant  # noqa: E402
from oracle.tenancy import tenant_session, unscoped_session  # noqa: E402

API_DIR = Path(__file__).resolve().parents[1]


async def _ensure_database(url: str) -> None:
    if url == BASE_TEST_DATABASE_URL:
        return
    name = make_url(url).database
    engine = create_async_engine(BASE_TEST_DATABASE_URL, isolation_level="AUTOCOMMIT")
    async with engine.connect() as conn:
        exists = await conn.scalar(
            text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": name}
        )
        if not exists:
            await conn.execute(text(f'CREATE DATABASE "{name}"'))
    await engine.dispose()


async def _reset_schema(url: str) -> None:
    await _ensure_database(url)
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await engine.dispose()


def run_migrations(url: str) -> None:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = url
    command.upgrade(cfg, "head")


@pytest.fixture(scope="session", autouse=True)
def migrated_db() -> None:
    try:
        asyncio.run(_reset_schema(TEST_DATABASE_URL))
    except OSError as e:
        if _EXPLICIT_DATABASE:
            raise
        pytest.skip(f"no Postgres at the default test URL ({e}); set ORACLE_TEST_DATABASE_URL")
    run_migrations(TEST_DATABASE_URL)


@pytest.fixture(autouse=True)
async def _truncate_after_test(migrated_db):
    yield
    tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
    async with get_engine().begin() as conn:
        await conn.execute(text(f"TRUNCATE {tables} CASCADE"))


@pytest.fixture(autouse=True)
def _forget_items_checks():
    """Each test checks its roadmap_items.yaml afresh: the checks one test kept
    (oracle.runs.roadmap._checks, the only cache of them) are not another's."""
    from oracle.runs import roadmap

    roadmap._checks.clear()
    yield
    roadmap._checks.clear()


# The suites written before "Start paused until goals" (owner decision 2026-10-29) that
# reach the built-in rituals' seeding (the ritual ticker, the metrics review's activation):
# they model a company that already has a confirmed goal, so its built-ins are seeded on.
_RITUALS_SEEDED_ON = frozenset({
    "test_adapter_v2_round6",
    "test_alignment_reports",
    "test_autonomy",
    "test_autonomy_strategy_external",
    "test_autonomy_wired",
    "test_board_goal_groups",
    "test_changelog",
    "test_code_maps",
    "test_company_day_text",
    "test_company_timezone",
    "test_discussion_replies",
    "test_display_timezone",
    "test_export_audience",
    "test_hidden_title_matching",
    "test_intake_read_private",
    "test_interviews",
    "test_launch_kit",
    "test_launch_request_requesters",
    "test_launches",
    "test_market",
    "test_market_check_now_limits",
    "test_market_digest",
    "test_market_watch",
    "test_market_web_findings",
    "test_member_draft_runs_visibility",
    "test_member_runs_visibility",
    "test_metrics",
    "test_metrics_posthog",
    "test_metrics_query_limits",
    "test_metrics_review",
    "test_metrics_ticker",
    "test_next_drafts_autonomy",
    "test_outcome_capture",
    "test_outcome_learnings",
    "test_outcome_shipping",
    "test_pricing_ritual_visibility",
    "test_priority_overrides",
    "test_public_texts",
    "test_questions_autonomy",
    "test_requests_triage",
    "test_rituals",
    "test_rituals_autonomy",
    "test_rituals_baseline_rebuild",
    "test_rituals_schedule",
    "test_rituals_ticker",
    "test_run_artifacts_visibility",
    "test_run_ticker",
    "test_simple_additions_api",
    "test_simple_changes_api",
    "test_simple_chat_api",
    "test_simple_meetings_review",
    "test_simple_meetings_walk",
    "test_simple_review_fixes",
    "test_simple_roadmap_api",
    "test_simple_walk_fixes3_cp_api",
    "test_simple_walk_fixes3_m2_api",
    "test_simple_walk_fixes_api",
    "test_simple_walk_fixes_review2_api",
    "test_simple_walk_fixes_review_api",
    "test_slack_bridge",
    "test_source_background_sync",
    "test_strategy_drift",
    "test_tenant_settings_api",
    "test_track_alerts",
    "test_tracks",
    "test_tracks_followups",
    "test_trash",
    "test_visibility_minors",
    "test_webhooks_delivery",
})  # fmt: skip


@pytest.fixture(autouse=True)
def _rituals_seed_on(request, monkeypatch):
    """Every other suite sees the real check: a new company's built-in rituals wait
    paused for its first confirmed goal (tests/test_rituals_wait_for_goal*.py)."""
    if request.module.__name__.rpartition(".")[2] not in _RITUALS_SEEDED_ON:
        return
    from oracle.rituals import service as rituals

    async def seeded_on(db) -> bool:
        return True

    monkeypatch.setattr(rituals, "has_confirmed_goal", seeded_on)


async def make_tenant(name: str = "Example Co") -> uuid.UUID:
    async with unscoped_session() as s:
        tenant = Tenant(name=name)
        s.add(tenant)
        await s.commit()
        return tenant.id


async def seed_company(tenant_id: uuid.UUID) -> None:
    """Seed a company's built-in templates and themes, as startup and company creation
    do (reads never seed)."""
    from oracle.templates.builtins import ensure_builtins

    async with tenant_session(tenant_id) as s:
        await ensure_builtins(s)
        await s.commit()


@pytest.fixture
async def tenant_id() -> uuid.UUID:
    return await make_tenant()


@pytest.fixture
async def db(tenant_id):
    async with tenant_session(tenant_id) as s:
        yield s


@pytest.fixture
async def client():
    from oracle.main import app

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def intake_local_runtime(request):
    """The intake lane's tests read as runs over MCP (tests.test_mcp.mcp_client): a local
    runtime there, so run tokens come from any address, as tests.test_mcp's own
    ``local_runtime`` fixture does (the egress check has its own tests)."""
    if not request.module.__name__.rsplit(".", 1)[-1].startswith("test_intake"):
        yield
        return
    from oracle.swarm import FakeRuntime, set_runtime

    set_runtime(FakeRuntime())
    yield
    set_runtime(None)
