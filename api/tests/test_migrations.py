"""Migration 0002: upgrade, downgrade and upgrade again on a scratch database.

Sync tests on purpose: Alembic's env.py runs its own event loop.
"""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.engine import make_url

import oracle.models  # noqa: F401
from oracle.db import Base
from oracle.templates import defaults
from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

V1_TABLES = {
    "invites",
    "run_tokens",
    "sources",
    "source_credentials",
    "source_items",
    "source_item_versions",
    "snapshots",
    "entities",
    "edges",
    "evidence",
    "entity_revisions",
    "proposals",
    "conflicts",
    "templates",
    "template_versions",
    "priority_snapshots",
    "runs",
    "run_segments",
    "checkpoints",
}
SCRATCH_URL = str(
    make_url(TEST_DATABASE_URL).set(database=make_url(TEST_DATABASE_URL).database + "_migrations")
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
    return {r[0] for r in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_upgrade_downgrade_round_trip(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0001")
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (gen_random_uuid(), :t, 'admin@example.com', 'x', 'owner')",
        t=tenant,
    )
    _run(
        "INSERT INTO api_tokens (id, tenant_id, name, token_hash) "
        "VALUES (gen_random_uuid(), :t, 'agent', 'hash')",
        t=tenant,
    )

    command.upgrade(cfg, "head")
    assert V1_TABLES <= _tables()
    # Existing tokens act as owners; existing tenants get the default template.
    assert _run("SELECT role FROM api_tokens") == [("owner",)]
    rows = _run(
        "SELECT t.key, v.version, v.body, v.required_sections FROM templates t "
        "JOIN template_versions v ON v.template_id = t.id WHERE t.tenant_id = :t",
        t=tenant,
    )
    assert rows == [
        (
            defaults.DEFAULT_TEMPLATE_KEY,
            1,
            defaults.DEFAULT_TEMPLATE_BODY,
            defaults.DEFAULT_REQUIRED_SECTIONS,
        )
    ]
    _run("UPDATE users SET role = 'viewer'")

    # A downgrade would lose the viewer's role: refused, nothing changed.
    with pytest.raises(RuntimeError, match="role other than owner"):
        command.downgrade(cfg, "0001")
    assert V1_TABLES <= _tables()

    _run("UPDATE users SET role = 'owner'")
    command.downgrade(cfg, "0001")
    assert not (V1_TABLES & _tables())
    assert _run("SELECT count(*) FROM users") == [(1,)]
    with pytest.raises(Exception, match="ck_users_role"):
        _run("UPDATE users SET role = 'viewer'")

    command.upgrade(cfg, "head")
    assert V1_TABLES <= _tables()
    command.downgrade(cfg, "base")
    assert _tables() == {"alembic_version"}


def test_models_match_migrations(scratch_db):
    """The models (Base.metadata) and the migrations describe the same schema."""
    command.upgrade(_cfg(), "head")

    async def diff():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        async with engine.connect() as conn:
            result = await conn.run_sync(
                lambda c: compare_metadata(MigrationContext.configure(c), Base.metadata)
            )
            names = await conn.run_sync(lambda c: inspect(c).get_table_names())
        await engine.dispose()
        return result, names

    result, names = asyncio.run(diff())
    assert result == []
    assert set(Base.metadata.tables) <= set(names)


def test_migration_template_copy_matches_defaults():
    import importlib.util

    path = API_DIR / "migrations" / "versions" / "0002_v1_foundation.py"
    spec = importlib.util.spec_from_file_location("migration_0002", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.DEFAULT_TEMPLATE_KEY == defaults.DEFAULT_TEMPLATE_KEY
    assert module.DEFAULT_TEMPLATE_NAME == defaults.DEFAULT_TEMPLATE_NAME
    assert module.DEFAULT_TEMPLATE_BODY == defaults.DEFAULT_TEMPLATE_BODY
    assert module.DEFAULT_REQUIRED_SECTIONS == defaults.DEFAULT_REQUIRED_SECTIONS
