"""Migration 0049_request_replies (H10 Reasoned no): ``request_replies``, a request's
basis, loop and asked-again columns, a theme's problem, a request as an ``llm_jobs``
subject with the ``why_not_reply`` kind, and the new reasons and decision origin.

Test card: protects=criterion 10 (the upgrade applies to a seeded database; the downgrade
refuses with a count while a request is disqualified as few_customers, and succeeds once
the reason is changed by hand, dropping the table and columns and keeping a recorded
request_decline decision); fails_when=the upgrade or downgrade fails, the refusal names no
count, the new reason survives the downgrade, or the chain has two heads; no_claim=the
application's use of the columns (tests/test_request_replies.py).

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

REVISION = "0049_request_replies"
PREVIOUS = "0048_scope_review"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_request_replies")
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


def test_chains_on_mains_head_and_is_the_only_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0071_simple_roadmap_dates"]


def test_upgrade_and_a_downgrade_refused_while_a_new_reason_is_used(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t, r, theme, d = (uuid.uuid4() for _ in range(4))
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO request_themes (id, tenant_id, title, origin) "
        "VALUES (:th, :t, 'Reporting', 'person')",
        th=theme,
        t=t,
    )
    _run(
        "INSERT INTO product_requests (id, tenant_id, title, channel, origin, theme_id) "
        "VALUES (:i, :t, 'Export every board', 'sales', 'person', :th)",
        i=r,
        t=t,
        th=theme,
    )
    command.upgrade(cfg, REVISION)
    assert _run("SELECT basis, loop_closed_on FROM product_requests")[0] == ({}, None)
    assert _run("SELECT problem_state FROM request_themes")[0][0] == "none"
    _run(
        "UPDATE product_requests SET state = 'disqualified', disqualify_reason = 'few_customers' "
        "WHERE id = :i",
        i=r,
    )
    _run(
        "INSERT INTO decisions (id, tenant_id, number, title, options, chosen_option, rationale, "
        "status, approver_id, driver, review_at, origin, source_kind, source_id, decided_at) "
        "VALUES (:d, :t, 1, 'Say no to Export every board', '[]', 'say_no', 'Too few', "
        "'decided', :u, 'oracle', now()::date + 90, 'request_decline', 'product_request', :i, "
        "now())",
        d=d,
        t=t,
        u=uuid.uuid4(),
        i=r,
    )
    _run(
        "INSERT INTO request_replies (id, tenant_id, request_id, root_request_id, kind, "
        "decision_id, asker_kind) VALUES (:x, :t, :i, :i, 'no', :d, 'customer')",
        x=uuid.uuid4(),
        t=t,
        i=r,
        d=d,
    )
    with pytest.raises(IntegrityError):
        _run(
            "INSERT INTO request_replies (id, tenant_id, request_id, root_request_id, kind, "
            "asker_kind, status) VALUES (:x, :t, :i, :i, 'no', 'customer', 'skipped')",
            x=uuid.uuid4(),
            t=t,
            i=r,
        )
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, request_id, status, input, attempts) "
        "VALUES (:j, :t, 'why_not_reply', :i, 'queued', '{}', 0)",
        j=uuid.uuid4(),
        t=t,
        i=r,
    )

    with pytest.raises(RuntimeError, match="^1 request"):
        command.downgrade(cfg, PREVIOUS)
    _run("UPDATE product_requests SET disqualify_reason = 'wont_do' WHERE id = :i", i=r)
    command.downgrade(cfg, PREVIOUS)
    tables = {row[0] for row in _run("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}
    assert "request_replies" not in tables
    columns = {
        (row[0], row[1])
        for row in _run(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_name IN ('product_requests', 'request_themes', 'llm_jobs')"
        )
    }
    assert ("product_requests", "basis") not in columns
    assert ("request_themes", "problem") not in columns
    assert ("llm_jobs", "request_id") not in columns
    assert _run("SELECT count(*) FROM llm_jobs")[0][0] == 0
    # The recorded decision stays, as an ordinary decided record.
    assert _run("SELECT origin, status FROM decisions")[0] == ("request_decline", "decided")
    with pytest.raises(IntegrityError):
        _run("UPDATE product_requests SET disqualify_reason = 'few_customers' WHERE id = :i", i=r)
    command.upgrade(cfg, REVISION)
