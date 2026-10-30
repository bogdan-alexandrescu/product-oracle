"""Migration 0070_brand_assets (O5 lane 4): the brand_assets table.

Card: protects=brand_assets comes and goes with the revision, chained on 0054_reply_opened
as the single head, one logo per sha256 per company, and the downgrade takes the stored
``branding`` setting with it; fails_when=the upgrade misses the table or its unique index,
or the downgrade leaves the table or the setting behind or touches other settings;
no_claim=the routes' use of the table (tests/test_branding.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

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

REVISION = "0070_brand_assets"
PREVIOUS = "0069_eng_dates"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_brand_assets")
    .render_as_string(hide_password=False)
)
INSERT_ASSET = (
    "INSERT INTO brand_assets (id, tenant_id, sha256, content_type, bytes, width, height) "
    "VALUES (gen_random_uuid(), :t, :sha, 'image/png', '\\x89504e47', 320, 80)"
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


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0092_bet_flow_line_key"]


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    assert "brand_assets" not in _tables()

    command.upgrade(_cfg(), REVISION)
    assert "brand_assets" in _tables()
    tenant, other = uuid.uuid4(), uuid.uuid4()
    for t in (tenant, other):
        _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    sha = "a" * 64
    _run(INSERT_ASSET, t=tenant, sha=sha)
    _run(INSERT_ASSET, t=other, sha=sha)  # another company may hold the same image
    with pytest.raises(IntegrityError):
        _run(INSERT_ASSET, t=tenant, sha=sha)
    for key in ("branding", "web_searches_per_month"):
        _run(
            "INSERT INTO tenant_settings (id, tenant_id, key, value) "
            "VALUES (gen_random_uuid(), :t, :k, '{}')",
            t=tenant,
            k=key,
        )

    command.downgrade(_cfg(), PREVIOUS)
    assert "brand_assets" not in _tables()
    assert _run("SELECT key FROM tenant_settings") == [("web_searches_per_month",)]

    command.upgrade(_cfg(), REVISION)
    assert "brand_assets" in _tables()
