"""Test harness. Needs a Postgres database it may wipe: ORACLE_TEST_DATABASE_URL.

The schema is built once per run with ``alembic upgrade head`` (so every run also
proves the migration applies to an empty database); tables are truncated after
each test.
"""

import asyncio
import os
import uuid
from pathlib import Path

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
    asyncio.run(_reset_schema(TEST_DATABASE_URL))
    run_migrations(TEST_DATABASE_URL)


@pytest.fixture(autouse=True)
async def _truncate_after_test(migrated_db):
    yield
    tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
    async with get_engine().begin() as conn:
        await conn.execute(text(f"TRUNCATE {tables} CASCADE"))


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
