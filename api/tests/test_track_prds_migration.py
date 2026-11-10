"""Migration 0124_track_prds (tracks-goal, owner Nov 9): a track holds many PRDs.

Card: protects=every track's PRD becomes its first linked PRD in ``track_prds`` and the
one-PRD column goes; the downgrade puts the column back from each track's first linked PRD
(a track holding several keeps the oldest), and a tracks with no PRD keeps none;
fails_when=the backfill loses a track's PRD, the column stays, or the downgrade loses the
first PRD or fails on a track with several. Sync on purpose (Alembic runs its own loop)."""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0124_track_prds"
PREVIOUS = "0123_track_goal"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_track_prds")
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


def _columns(table: str) -> set[str]:
    rows = _run("SELECT column_name FROM information_schema.columns WHERE table_name = :t", t=table)
    return {r[0] for r in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == [REVISION]


def test_upgrade_backfills_and_downgrade_restores(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    tenant, first, second, third = (uuid.uuid4() for _ in range(4))
    track, empty = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=tenant)
    for doc, slug in ((first, "first"), (second, "second"), (third, "third")):
        _run(
            "INSERT INTO documents (id, tenant_id, slug, title, kind, status) "
            "VALUES (:d, :t, :s, :s, 'prd', 'draft')",
            d=doc, t=tenant, s=slug,
        )  # fmt: skip
    _run(
        "INSERT INTO product_tracks (id, tenant_id, prd_document_id, title) "
        "VALUES (:k, :t, :d, 'Checkout')",
        k=track, t=tenant, d=first,
    )  # fmt: skip
    _run(
        "INSERT INTO product_tracks (id, tenant_id, prd_document_id, title) "
        "VALUES (:k, :t, NULL, 'Search')",
        k=empty, t=tenant,
    )  # fmt: skip

    command.upgrade(_cfg(), REVISION)
    assert "prd_document_id" not in _columns("product_tracks")
    assert _run("SELECT track_id, prd_document_id, state FROM track_prds") == [
        (track, first, "linked")
    ]
    # Two PRDs on one track, after the first; and a PRD a person took off a track.
    _run(
        "INSERT INTO track_prds (id, tenant_id, prd_document_id, track_id, state, created_at) "
        "VALUES (gen_random_uuid(), :t, :d, :k, 'linked', now() + interval '1 hour')",
        t=tenant, d=second, k=track,
    )  # fmt: skip
    _run(
        "INSERT INTO track_prds (id, tenant_id, prd_document_id, state) "
        "VALUES (gen_random_uuid(), :t, :d, 'off')",
        t=tenant, d=third,
    )  # fmt: skip

    command.downgrade(_cfg(), PREVIOUS)
    assert "track_prds" not in {r[0] for r in _run("SELECT tablename FROM pg_tables")}
    rows = dict(_run("SELECT id, prd_document_id FROM product_tracks"))
    assert rows == {track: first, empty: None}

    command.upgrade(_cfg(), REVISION)
    assert _run("SELECT track_id, prd_document_id FROM track_prds") == [(track, first)]
