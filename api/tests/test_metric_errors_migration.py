"""Migration 0059_metric_errors_fixed (#565 review minor): a metric error stored before
#565, which may carry PostHog's own text, becomes the fixed sentence every member may read.

Card: protects=after the upgrade no metric's last_error is anything but one of Oracle's
own sentences (PostHog's text replaced by QUERY_FAILED, Oracle's sentences and refusals
kept, a clear metric left clear), chained on 0054_reply_opened as the single head;
fails_when=a member keeps reading PostHog's raw message from before #565;
no_claim=the server log (the text is not recoverable there for old rows).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from oracle.metrics import posthog, pull
from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0059_metric_errors_fixed"
PREVIOUS = "0058_fireflies_endpoint"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_metric_errors")
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


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def _metric(tenant: uuid.UUID, title: str, error: str | None) -> uuid.UUID:
    mid = uuid.uuid4()
    _run(
        "INSERT INTO metrics (id, tenant_id, title, description, kind, unit, direction, "
        "owner_id, source, query, last_error) VALUES (:id, :t, :title, '', 'output', 'count', "
        "'up', :o, 'posthog', 'SELECT 1', :e)",
        id=mid, t=tenant, title=title, o=uuid.uuid4(), e=error,
    )  # fmt: skip
    return mid


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0081_simple_meetings"]


def test_old_posthog_text_becomes_the_fixed_sentence(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    kept = {
        posthog.QUERY_FAILED, posthog.UNREACHABLE, pull.DISCONNECTED,
        "The query must return one row with one number", "PostHog's answer was not JSON",
        "query: raw_sessions cannot be read (only events, groups, persons, sessions)",
    }  # fmt: skip
    ids = {_metric(tenant, f"kept {i}", e): e for i, e in enumerate(sorted(kept))}
    leaked = _metric(tenant, "leaked", "table secret_billing_ledger does not exist")
    reach = _metric(tenant, "reach", "Could not reach PostHog: [Errno -2] Name not known")
    clear = _metric(tenant, "clear", None)
    command.upgrade(_cfg(), REVISION)
    got = dict(_run("SELECT id, last_error FROM metrics"))
    assert got[leaked] == posthog.QUERY_FAILED
    assert got[reach] == posthog.UNREACHABLE
    assert got[clear] is None
    for mid, error in ids.items():
        assert got[mid] == error
    command.downgrade(_cfg(), PREVIOUS)
    assert dict(_run("SELECT id, last_error FROM metrics"))[leaked] == posthog.QUERY_FAILED
