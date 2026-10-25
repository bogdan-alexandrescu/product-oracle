"""Migration 0027_request_in_app: a request may come from the app itself (#329).

Additive. ``ck_product_requests_channel`` also allows ``in_app``: a person files a request
with New request on the Requests screen. The downgrade records those requests as Other and
stops allowing the value.

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

REVISION = "0027_request_in_app"
PREVIOUS = "0026_staging"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_request_in_app")
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


def _add(tenant: uuid.UUID, channel: str) -> None:
    _run(
        "INSERT INTO product_requests (id, tenant_id, title, channel, origin) "
        "VALUES (:i, :t, 'Reorder a past basket', :c, 'person')",
        i=uuid.uuid4(),
        t=tenant,
        c=channel,
    )


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_after_mains_head_with_a_single_head():
    """protects=one alembic head; fails_when=the migration forks the chain;
    no_claim=other lanes' later migrations."""
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0055_slack_pings"]


def test_upgrade_allows_in_app_and_downgrade_records_them_as_other(scratch_db):
    """protects=the in_app channel in the database; fails_when=the check refuses it after
    the upgrade, or the downgrade fails on in_app rows; no_claim=the API's rules."""
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    with pytest.raises(IntegrityError):
        _add(tenant, "in_app")

    command.upgrade(cfg, REVISION)
    _add(tenant, "in_app")
    _add(tenant, "sales")
    assert sorted(_run("SELECT channel FROM product_requests")) == [("in_app",), ("sales",)]

    command.downgrade(cfg, PREVIOUS)
    assert sorted(_run("SELECT channel FROM product_requests")) == [("other",), ("sales",)]
    with pytest.raises(IntegrityError):
        _add(tenant, "in_app")
