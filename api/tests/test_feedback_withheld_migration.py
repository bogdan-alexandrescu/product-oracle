"""Migration 0064_feedback_withheld (#636 re-review): ``feedback_items.withheld_at``.

Card: protects=the flag comes and goes with the revision, chained on 0063_late_answers as
the single head, nullable, and set on the late-answer items already kept with the withheld
summary; fails_when=the upgrade misses the column or the backfill (or flags another item),
or the downgrade leaves it; no_claim=what a withheld item hides
(tests/test_late_answers_feedback.py).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0064_feedback_withheld"
PREVIOUS = "0063_late_answers"
WITHHELD = "Answered after drafting started (withheld while its finding is not shared in full)"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_feedback_withheld")
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


def _columns() -> dict[str, str]:
    rows = _run(
        "SELECT column_name, is_nullable FROM information_schema.columns "
        "WHERE table_name = 'feedback_items'"
    )
    return {name: nullable for name, nullable in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0081_simple_visuals"]


def test_upgrade_backfills_and_downgrade(scratch_db):
    from oracle.intake.late_answers import WITHHELD as current

    assert current == WITHHELD
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t, doc, intake, question, answer = (uuid.uuid4() for _ in range(5))
    kept, linked, typed = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'prd', 'PRD', 'draft')",
        d=doc,
        t=t,
    )
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief) "
        "VALUES (:i, :t, 'Brief', 'A brief')",
        i=intake,
        t=t,
    )
    _run(
        "INSERT INTO stakeholder_questions (id, tenant_id, intake_id, category, prompt) "
        "VALUES (:q, :t, :i, 'general', 'Which metric?')",
        q=question,
        t=t,
        i=intake,
    )
    _run(
        "INSERT INTO stakeholder_answers (id, tenant_id, question_id, kind, body) "
        "VALUES (:a, :t, :q, 'answer', 'A late answer.')",
        a=answer,
        t=t,
        q=question,
    )
    second = uuid.uuid4()
    _run(
        "INSERT INTO stakeholder_answers (id, tenant_id, question_id, kind, body) "
        "VALUES (:a, :t, :q, 'answer', 'Another.')",
        a=second,
        t=t,
        q=question,
    )
    for item, summary, link in (
        (kept, WITHHELD, answer),
        (linked, "Answered after drafting started: Which metric? Another.", second),
        (typed, WITHHELD, None),
    ):
        _run(
            "INSERT INTO feedback_items (id, tenant_id, document_id, raised_on_version, kind, "
            "summary, status, intake_answer_id) "
            "VALUES (:i, :t, :d, 1, 'general', :s, 'addressed', :a)",
            i=item,
            t=t,
            d=doc,
            s=summary,
            a=link,
        )

    command.upgrade(cfg, REVISION)
    assert _columns()["withheld_at"] == "YES"
    flagged = _run("SELECT id FROM feedback_items WHERE withheld_at IS NOT NULL")
    assert flagged == [(kept,)]

    command.downgrade(cfg, PREVIOUS)
    assert "withheld_at" not in _columns()
    assert _run("SELECT count(*) FROM feedback_items") == [(3,)]
