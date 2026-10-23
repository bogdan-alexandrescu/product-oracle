"""Migration 0015_specs: documents of kind spec and prd_to_spec runs become possible,
legacy rows are untouched, and the downgrade removes them and restores the constraints.

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

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_specs")
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


def test_0015_specs_chains_after_main_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision("0015_specs").down_revision == "0020_feedback_author"
    assert script.get_heads() == ["0042_slack_bridge"]


def _doc(t, kind: str) -> uuid.UUID:
    d = uuid.uuid4()
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status, kind) "
        "VALUES (:d, :t, :s, 'Doc', 'draft', :k)",
        d=d, t=t, s=f"{kind}-{d.hex[:6]}", k=kind,
    )  # fmt: skip
    return d


def _run_row(t, flow: str) -> None:
    _run(
        "INSERT INTO runs (id, tenant_id, flow, status) "
        "VALUES (gen_random_uuid(), :t, :f, 'draft')",
        t=t, f=flow,
    )  # fmt: skip


def test_upgrade_allows_specs_and_downgrade_removes_them(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0014_intake")
    t = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    prd = _doc(t, "prd")
    _run_row(t, "prd_to_roadmap")
    with pytest.raises(Exception, match="ck_documents_kind"):
        _doc(t, "spec")
    with pytest.raises(Exception, match="ck_runs_flow"):
        _run_row(t, "prd_to_spec")

    command.upgrade(cfg, "0015_specs")
    spec = _doc(t, "spec")
    _run_row(t, "prd_to_spec")
    with pytest.raises(Exception, match="ck_documents_kind"):
        _doc(t, "memo")

    command.downgrade(cfg, "0014_intake")
    assert _run("SELECT id FROM documents") == [(prd,)]
    assert _run("SELECT flow FROM runs") == [("prd_to_roadmap",)]
    assert spec not in [r[0] for r in _run("SELECT id FROM documents")]
    with pytest.raises(Exception, match="ck_documents_kind"):
        _doc(t, "spec")
    command.upgrade(cfg, "head")
