"""Migration 0017_item_provenance: the backfill fills the rows of every company.

Oracle keeps tenants apart in the application (an ORM filter, oracle.tenancy), not with
Postgres row-level security, so the migration's plain UPDATE sees every tenant's rows.
This pins that: two companies' Notion pages and Fireflies meetings are all backfilled.

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

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_provenance")
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


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_the_chain_ends_here_after_0014_intake():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0030_interviews"]
    assert script.get_revision("0016_source_needs_attention").down_revision == "0014_intake"
    assert script.get_revision("0016_browse_calls").down_revision == "0016_source_needs_attention"
    assert script.get_revision("0017_item_provenance").down_revision == "0016_browse_calls"
    rev = script.get_revision("0017_source_config_version")
    assert rev.down_revision == "0017_item_provenance"
    # The Drive picker's per-item notes chain last (re-chained when #122 merged main).
    drive = script.get_revision("0018_source_unavailable_items")
    assert drive.down_revision == "0017_source_config_version"


def test_no_table_uses_row_level_security(scratch_db):
    command.upgrade(_cfg(), "0017_item_provenance")
    assert _run("SELECT count(*) FROM pg_class WHERE relrowsecurity OR relforcerowsecurity") == [
        (0,)
    ]


def test_the_backfill_fills_the_rows_of_two_companies(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0016_browse_calls")
    root = "11111111111141118111111111111111"
    expected: dict[uuid.UUID, tuple[str, str]] = {}
    for n in (1, 2):
        tenant, user = uuid.uuid4(), uuid.uuid4()
        _run("INSERT INTO tenants (id, name) VALUES (:t, :n)", t=tenant, n=f"Company {n}")
        _run(
            "INSERT INTO users (id, tenant_id, email, password_hash, role) "
            "VALUES (:u, :t, :e, 'x', 'owner')",
            u=user,
            t=tenant,
            e=f"owner{n}@example.com",
        )
        for kind, item_kind, external, acl in (
            ("notion", "page", f"page-{n}", f'{{"root": "{root}"}}'),
            ("fireflies", "transcript", f"meeting-{n}", "{}"),
        ):
            source, item = uuid.uuid4(), uuid.uuid4()
            _run(
                "INSERT INTO sources (id, tenant_id, owner_user_id, kind, name, config, status) "
                "VALUES (:s, :t, :u, :k, :name, '{}', 'active')",
                s=source,
                t=tenant,
                u=user,
                k=kind,
                name=f"My {kind}",
            )
            _run(
                "INSERT INTO source_items (id, tenant_id, source_id, external_id, kind, acl) "
                "VALUES (:i, :t, :s, :e, :ik, CAST(:acl AS jsonb))",
                i=item,
                t=tenant,
                s=source,
                e=external,
                ik=item_kind,
                acl=acl,
            )
            expected[item] = (kind, external)

    command.upgrade(cfg, "0017_item_provenance")

    rows = _run("SELECT id, provenance FROM source_items")
    assert len(rows) == 4
    for item_id, provenance in rows:
        kind, external = expected[item_id]
        if kind == "notion":
            assert provenance == {"root": root}
        else:
            assert provenance == {"meeting": external}
