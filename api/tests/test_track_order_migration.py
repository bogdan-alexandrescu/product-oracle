"""Migration 0128_track_order (track-order, owner Nov 9): the company's tracks keep one order.
Card: protects=``product_tracks.position`` is added and backfilled per company, oldest first
(newest last), so today's order is kept until someone moves one; the downgrade drops it and
the upgrade runs again; fails_when=a company's tracks are numbered across companies, out of
their made order, or the downgrade fails. Sync on purpose (Alembic runs its own loop)."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0128_track_order"
PREVIOUS = "0127_trash_tasks"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_track_order")
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


def _columns(table: str) -> set[str]:
    rows = _run("SELECT column_name FROM information_schema.columns WHERE table_name = :t", t=table)
    return {r[0] for r in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert len(script.get_heads()) == 1


def test_upgrade_backfills_newest_last_and_downgrade_drops(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    one, two = uuid.uuid4(), uuid.uuid4()
    for t, name in ((one, "Example Co"), (two, "Sample Inc")):
        _run("INSERT INTO tenants (id, name) VALUES (:t, :n)", t=t, n=name)
    made = {}
    for tenant, title, hours in (
        (one, "Search", 2), (one, "Checkout", 1), (two, "Returns", 5), (one, "Gift wrap", 3),
    ):  # fmt: skip
        k = uuid.uuid4()
        made[title] = k
        _run(
            "INSERT INTO product_tracks (id, tenant_id, title, created_at) "
            "VALUES (:k, :t, :title, now() + make_interval(hours => :h))",
            k=k, t=tenant, title=title, h=hours,
        )  # fmt: skip

    command.upgrade(_cfg(), REVISION)
    rows = dict(_run("SELECT title, position FROM product_tracks"))
    assert rows == {"Checkout": 1, "Search": 2, "Gift wrap": 3, "Returns": 1}

    command.downgrade(_cfg(), PREVIOUS)
    assert "position" not in _columns("product_tracks")
    command.upgrade(_cfg(), REVISION)
    assert "position" in _columns("product_tracks")
