"""Migration 0018_runtime_features: the table of learned runtime feature states (UI test
finding E3). Upgrade creates it with its state check; the downgrade drops it.

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0018_runtime_features"
PREVIOUS = "0017_citation_source_oracle"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_rtf")
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


def _exists() -> bool:
    return _run("SELECT to_regclass('public.runtime_features') IS NOT NULL")[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_citation_source_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    # 0019_citation_confidence chains on it, the intake lane's 0014_intake on that and the
    # PRD review chain (0014_review ... 0014_member_follow_up_retry) on that.
    assert script.get_heads() == ["0070_brand_assets"]
    assert script.get_revision("0019_citation_confidence").down_revision == REVISION


def test_upgrade_creates_the_table_and_downgrade_drops_it(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    assert not _exists()
    command.upgrade(_cfg(), REVISION)
    assert _exists()
    _run(
        "INSERT INTO runtime_features (feature, state, reason, learned_at) "
        "VALUES ('await_input', 'off', 'x', now())"
    )
    assert _run("SELECT feature, state, expires_at FROM runtime_features") == [
        ("await_input", "off", None)
    ]
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO runtime_features (feature, state, learned_at) "
            "VALUES ('caller_mcp', 'bogus', now())"
        )
    command.downgrade(_cfg(), PREVIOUS)
    assert not _exists()
