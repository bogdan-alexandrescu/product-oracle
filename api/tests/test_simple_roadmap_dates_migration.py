"""Migration 0077_simple_roadmap_dates (Simple S2, #723).

Card: protects=roadmap_items' start_date, end_date, date_source (checked), accepted_risks
('[]') and draft (false) and the roadmap_date_suggestions table (one open suggestion per
item) come and go with the revision, chained on 0075_live_tokens as the single head, and
the downgrade takes the internal ``simple_date_suggestions`` setting with it;
fails_when=a column, default, check or the open-suggestion index is missing, or the
downgrade leaves any of them or touches other settings; no_claim=the routes' use
(tests/test_simple_roadmap_api.py).

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

REVISION = "0077_simple_roadmap_dates"
PREVIOUS = "0075_live_tokens"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_simple_dates")
    .render_as_string(hide_password=False)
)
COLUMNS = {"start_date", "end_date", "date_source", "accepted_risks", "draft"}


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


def _columns() -> set[str]:
    rows = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'roadmap_items'"
    )
    return {r[0] for r in rows} & COLUMNS


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
    assert script.get_heads() == ["0080_simple_one_pagers"]


def _seed_item() -> tuple[uuid.UUID, uuid.UUID]:
    tenant, doc, version, item = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status, kind) "
        "VALUES (:d, :t, 'plan', 'Plan', 'approved', 'roadmap')",
        d=doc,
        t=tenant,
    )
    _run(
        "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
        "content_hash) VALUES (:v, :t, :d, 1, '# Plan', 'h1')",
        v=version,
        t=tenant,
        d=doc,
    )
    _run(
        "INSERT INTO roadmap_items (id, tenant_id, roadmap_document_id, roadmap_version_id, "
        "item_key, position, title, horizon) VALUES (:i, :t, :d, :v, 'a', 0, 'A', 'now')",
        i=item,
        t=tenant,
        d=doc,
        v=version,
    )
    return tenant, item


def test_upgrade_and_downgrade(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant, item = _seed_item()
    assert _columns() == set()

    command.upgrade(_cfg(), REVISION)
    assert _columns() == COLUMNS
    assert _run("SELECT accepted_risks, draft, date_source FROM roadmap_items") == [
        ([], False, None)
    ]
    with pytest.raises(IntegrityError):
        _run("UPDATE roadmap_items SET date_source = 'guessed'")
    insert = (
        "INSERT INTO roadmap_date_suggestions (id, tenant_id, item_id, start_date, end_date, "
        "basis) VALUES (gen_random_uuid(), :t, :i, '2026-11-02', '2026-12-01', 'Why.')"
    )
    _run(insert, t=tenant, i=item)
    with pytest.raises(IntegrityError):
        _run(insert, t=tenant, i=item)  # one open suggestion per item
    for key in ("simple_date_suggestions", "web_searches_per_month"):
        _run(
            "INSERT INTO tenant_settings (id, tenant_id, key, value) "
            "VALUES (gen_random_uuid(), :t, :k, '{}')",
            t=tenant,
            k=key,
        )

    command.downgrade(_cfg(), PREVIOUS)
    assert _columns() == set()
    assert "roadmap_date_suggestions" not in _tables()
    assert _run("SELECT key FROM tenant_settings") == [("web_searches_per_month",)]

    command.upgrade(_cfg(), REVISION)
    assert _columns() == COLUMNS
