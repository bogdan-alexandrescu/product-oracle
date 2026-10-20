"""Migration 0015_section_table_rows: stored body_text of sections with a table is
rewritten to one line per row; other sections are untouched; the downgrade restores the
cell-per-line text.

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from oracle.docs.parser import body_text
from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_table_rows")
    .render_as_string(hide_password=False)
)

TABLE_MD = "Targets:\n\n| Metric | Target |\n|---|---|\n| Checkout completion [c:c1] | 60% |"
OLD_TABLE_TEXT = "Targets:\nMetric\nTarget\nCheckout completion\n60%"
PIPE_MD = "Use a `a | b` shell pipe, not a table."


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


def test_0015_follows_0014_trace():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision("0015_section_table_rows").down_revision == "0014_trace"


def _section(t: uuid.UUID, v: uuid.UUID, key: str, ordinal: int, md: str, txt: str) -> None:
    _run(
        "INSERT INTO sections (id, tenant_id, version_id, section_key, ordinal, level, "
        "heading, body_md, body_text, content_hash) "
        "VALUES (gen_random_uuid(), :t, :v, :k, :o, 2, 'H', :md, :txt, 'h')",
        t=t,
        v=v,
        k=key,
        o=ordinal,
        md=md,
        txt=txt,
    )


def _texts() -> dict[str, str]:
    return dict(_run("SELECT section_key, body_text FROM sections"))


def test_upgrade_rewrites_table_rows_and_downgrade_restores_them(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0014_trace")
    t, d, v = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'checkout', 'Checkout', 'draft')",
        d=d,
        t=t,
    )
    _run(
        "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
        "content_hash) VALUES (:v, :t, :d, 1, 'x', 'h')",
        v=v,
        t=t,
        d=d,
    )
    _section(t, v, "metrics", 1, TABLE_MD, OLD_TABLE_TEXT)
    _section(t, v, "pipe", 2, PIPE_MD, "Use a a | b shell pipe, not a table.")
    _section(t, v, "plain", 3, "Just text.", "Just text.")

    command.upgrade(cfg, "0015_section_table_rows")
    after = _texts()
    assert after["metrics"] == "Targets:\nMetric | Target\nCheckout completion | 60%"
    # The migration writes what the parser writes today.
    assert after["metrics"] == body_text(TABLE_MD)
    assert after["pipe"] == "Use a a | b shell pipe, not a table."
    assert after["plain"] == "Just text."

    command.downgrade(cfg, "0014_trace")
    assert _texts() == {
        "metrics": OLD_TABLE_TEXT,
        "pipe": "Use a a | b shell pipe, not a table.",
        "plain": "Just text.",
    }
