"""Migration 0092_feedback_discussion (0092_feedback_discussion.py): a General item made from a
Discuss thread keeps its thread (``feedback_items.discussion_id``, one item per thread).

Card: protects=the upgrade adds the column to a table that already holds items (they keep
everything, no thread); one item per thread; a deleted thread leaves its item with no thread;
the downgrade drops the column and keeps every item; up again works; chained on
0092_bet_flow_line_key; fails_when=an item is lost or changed either way, two items share a
thread, deleting a thread deletes its item, or the downgrade leaves the column or its
constraints; no_claim=the item's behaviour (test_fix4_simple_decide_review_api).

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

REVISION = "0092_feedback_discussion"
PREVIOUS = "0092_bet_flow_line_key"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_feedback_discussion")
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


def _items() -> list[tuple]:
    return _run(
        "SELECT id, kind, summary, status, raised_on_version FROM feedback_items ORDER BY summary"
    )


def _columns() -> set[str]:
    rows = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'feedback_items'"
    )
    return {r[0] for r in rows}


def _constraints() -> set[str]:
    rows = _run("SELECT conname FROM pg_constraint WHERE conrelid = 'feedback_items'::regclass")
    return {r[0] for r in rows}


def _thread(t: uuid.UUID, d: uuid.UUID, title: str) -> uuid.UUID:
    x = uuid.uuid4()
    _run(
        "INSERT INTO discussions (id, tenant_id, subject_kind, subject, subject_key, document_id, "
        "title, started_by) VALUES (:x, :t, 'document', CAST(:s AS jsonb), :k, :d, :title, :u)",
        x=x, t=t, s=f'{{"document_id": "{d}"}}', k=f"document:{d}", d=d, title=title,
        u=uuid.uuid4(),
    )  # fmt: skip
    return x


def test_chains_on_bet_flow_line_key():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert len(script.get_heads()) == 1


def test_items_keep_everything_up_and_down(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t, d = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'setup', 'Guided setup', 'draft')",
        d=d, t=t,
    )  # fmt: skip
    for summary, status in (("Name the first step", "open"), ("Shorter tour", "addressed")):
        _run(
            "INSERT INTO feedback_items (id, tenant_id, document_id, raised_on_version, kind, "
            "summary, status) VALUES (gen_random_uuid(), :t, :d, 1, 'general', :s, :st)",
            t=t, d=d, s=summary, st=status,
        )  # fmt: skip
    before = _items()
    assert "discussion_id" not in _columns()

    command.upgrade(cfg, REVISION)
    assert _items() == before
    assert _run("SELECT count(*) FROM feedback_items WHERE discussion_id IS NOT NULL")[0][0] == 0
    # One item per thread.
    thread = _thread(t, d, "About the first step")
    first, second = (r[0] for r in before)
    _run("UPDATE feedback_items SET discussion_id = :x WHERE id = :i", x=thread, i=first)
    with pytest.raises(IntegrityError):
        _run("UPDATE feedback_items SET discussion_id = :x WHERE id = :i", x=thread, i=second)
    # A deleted thread leaves its item, with no thread.
    _run("DELETE FROM discussions WHERE id = :x", x=thread)
    assert _items() == before
    assert _run("SELECT discussion_id FROM feedback_items WHERE id = :i", i=first)[0][0] is None
    # A thread kept for the way down.
    kept = _thread(t, d, "About the tour")
    _run("UPDATE feedback_items SET discussion_id = :x WHERE id = :i", x=kept, i=second)

    command.downgrade(cfg, PREVIOUS)
    assert _items() == before
    assert "discussion_id" not in _columns()
    assert (
        not {
            "fk_feedback_items_discussion_id_discussions",
            "uq_feedback_items_discussion_id",
        }
        & _constraints()
    )
    assert _run("SELECT count(*) FROM discussions WHERE id = :x", x=kept)[0][0] == 1

    command.upgrade(cfg, REVISION)
    assert _items() == before
    assert "uq_feedback_items_discussion_id" in _constraints()
