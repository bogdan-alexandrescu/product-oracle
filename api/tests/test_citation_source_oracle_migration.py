"""Migration 0017_citation_source_oracle: citations.source gains 'oracle' (a draft cites
Oracle's own baseline) by extending the check the database has (sources another lane
added are kept); the downgrade takes it out again and refuses while 'oracle' rows exist.

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

REVISION = "0017_citation_source_oracle"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_cite")
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


def _check() -> str:
    return _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_citations_source'"
    )[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def _version() -> tuple[uuid.UUID, uuid.UUID]:
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
    return t, v


def _cite(t: uuid.UUID, v: uuid.UUID, key: str, source: str) -> None:
    _run(
        "INSERT INTO citations (id, tenant_id, version_id, cite_key, source, ref) "
        "VALUES (gen_random_uuid(), :t, :v, :k, :s, 'baseline goal g1 (activation), locked')",
        t=t,
        v=v,
        k=key,
        s=source,
    )


def test_chains_on_the_refinement_batch_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == "0016_refinement_batch"
    # 0018_runtime_features chains on it, 0019_citation_confidence on that, the intake
    # lane's 0014_intake on that and the PRD review chain (0014_review,
    # 0014_member_disable, 0014_member_follow_up_retry) on that; one head.
    assert script.get_heads() == ["0045_discussion_inbox"]
    assert script.get_revision("0018_runtime_features").down_revision == REVISION
    assert script.get_revision("0019_citation_confidence").down_revision == "0018_runtime_features"
    assert script.get_revision("0014_intake").down_revision == "0019_citation_confidence"
    assert script.get_revision("0014_review").down_revision == "0018_source_unavailable_items"
    # The sources lane's migrations chain after it: 0016_source_needs_attention,
    # 0016_browse_calls, 0017_item_provenance.
    assert script.get_revision("0016_source_needs_attention").down_revision == "0014_intake"
    assert script.get_revision("0015_specs").down_revision == "0020_feedback_author"


def test_an_oracle_citation_inserts_after_upgrade(scratch_db):
    command.upgrade(_cfg(), "0016_refinement_batch")
    t, v = _version()
    with pytest.raises(IntegrityError):
        _cite(t, v, "o-g1", "oracle")
    command.upgrade(_cfg(), REVISION)
    _cite(t, v, "o-g1", "oracle")
    _cite(t, v, "c1", "slack")
    assert _run("SELECT cite_key, source, ref FROM citations ORDER BY cite_key") == [
        ("c1", "slack", "baseline goal g1 (activation), locked"),
        ("o-g1", "oracle", "baseline goal g1 (activation), locked"),
    ]


def test_extends_the_live_check_and_the_downgrade_refuses_oracle_rows(scratch_db):
    command.upgrade(_cfg(), "0016_refinement_batch")
    # Another lane's source, added after 0001, must survive both ways.
    _run("ALTER TABLE citations DROP CONSTRAINT ck_citations_source")
    _run(
        "ALTER TABLE citations ADD CONSTRAINT ck_citations_source CHECK (source IN "
        "('slack', 'notion', 'gdocs', 'github', 'fireflies', 'upload', 'web', 'other_lane'))"
    )
    command.upgrade(_cfg(), REVISION)
    check = _check()
    for source in ("slack", "fireflies", "web", "other_lane", "oracle"):
        assert f"'{source}'" in check

    t, v = _version()
    _cite(t, v, "o-g1", "oracle")
    # Narrowing would drop what the 'oracle' rows say: refused, loudly, and nothing changes.
    with pytest.raises(Exception, match="oracle"):
        command.downgrade(_cfg(), "0016_refinement_batch")
    assert "'oracle'" in _check()

    _run("DELETE FROM citations WHERE source = 'oracle'")
    command.downgrade(_cfg(), "0016_refinement_batch")
    check = _check()
    assert "'oracle'" not in check and "'other_lane'" in check
