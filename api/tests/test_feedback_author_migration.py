"""Migration 0020_feedback_author: feedback items keep who raised them.

Adds the nullable ``feedback_items.author_id`` and fills it for existing items from their
comment's author or their verdict's reviewer; items with neither stay null.

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

REVISION = "0020_feedback_author"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_feedback_author")
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


def test_it_follows_the_prd_review_chain():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0047_slack_bridge"]
    assert script.get_revision(REVISION).down_revision == "0014_member_follow_up_retry"


def test_upgrade_fills_the_author_and_downgrade_drops_it(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0014_member_follow_up_retry")
    tenant, author, reviewer = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    doc, version, comment, review = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'prd', 'PRD', 'draft')",
        d=doc,
        t=tenant,
    )
    _run(
        "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
        "content_hash) VALUES (:v, :t, :d, 1, '# PRD', 'h')",
        v=version,
        t=tenant,
        d=doc,
    )
    _run(
        "INSERT INTO comments (id, tenant_id, version_id, section_key, body, author_id) "
        "VALUES (:c, :t, :v, 'title', 'Who?', :a)",
        c=comment,
        t=tenant,
        v=version,
        a=author,
    )
    _run(
        "INSERT INTO section_reviews (id, tenant_id, version_id, section_key, verdict, "
        "reviewer_id) VALUES (:r, :t, :v, 'title', 'changes_requested', :a)",
        r=review,
        t=tenant,
        v=version,
        a=reviewer,
    )
    items = {"comment": uuid.uuid4(), "section_review": uuid.uuid4(), "general": uuid.uuid4()}
    for kind, item in items.items():
        _run(
            "INSERT INTO feedback_items (id, tenant_id, document_id, raised_on_version, kind, "
            "comment_id, section_review_id, summary, status) "
            "VALUES (:i, :t, :d, 1, :k, :c, :r, 's', 'open')",
            i=item,
            t=tenant,
            d=doc,
            k=kind,
            c=comment if kind == "comment" else None,
            r=review if kind == "section_review" else None,
        )

    command.upgrade(cfg, REVISION)

    rows = dict(_run("SELECT id, author_id FROM feedback_items"))
    assert rows == {
        items["comment"]: author,
        items["section_review"]: reviewer,
        items["general"]: None,
    }

    command.downgrade(cfg, "0014_member_follow_up_retry")
    cols = _run(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'feedback_items' AND column_name = 'author_id'"
    )
    assert cols == []
