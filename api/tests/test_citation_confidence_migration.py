"""Migration 0019_citation_confidence: citations keep what the writer computed per
citation (the source item it read, its confidence 0-1 or a note, the low-confidence
flag). Additive; the downgrade drops the columns again.

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

REVISION = "0019_citation_confidence"
PREVIOUS = "0018_runtime_features"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_conf")
    .render_as_string(hide_password=False)
)
COLUMNS = ("item_id", "confidence", "confidence_note", "low_confidence")


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
    rows = _run("SELECT column_name FROM information_schema.columns WHERE table_name = 'citations'")
    return {r[0] for r in rows}


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


def _item(t: uuid.UUID) -> uuid.UUID:
    u, s, i = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, :e, 'x', 'owner')",
        u=u,
        t=t,
        e=f"{u.hex}@example.com",
    )
    _run(
        "INSERT INTO sources (id, tenant_id, owner_user_id, kind, name, status) "
        "VALUES (:s, :t, :u, 'github', 'repo', 'active')",
        s=s,
        t=t,
        u=u,
    )
    _run(
        "INSERT INTO source_items (id, tenant_id, source_id, external_id, kind) "
        "VALUES (:i, :t, :s, 'issue-12', 'issue')",
        i=i,
        t=t,
        s=s,
    )
    return i


def _cite(t, v, key: str, **cols) -> None:
    names = "".join(f", {c}" for c in cols)
    values = "".join(f", :{c}" for c in cols)
    _run(
        f"INSERT INTO citations (id, tenant_id, version_id, cite_key, source, ref{names}) "
        f"VALUES (gen_random_uuid(), :t, :v, :k, 'github', 'https://example.com'{values})",
        t=t,
        v=v,
        k=key,
        **cols,
    )


def test_chains_on_the_citation_source_oracle_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    # The intake lane's 0014_intake chains on it and the PRD review chain (0014_review,
    # 0014_member_disable, 0014_member_follow_up_retry) on that; one head.
    assert script.get_heads() == ["0027_outcome_tracking"]
    assert script.get_revision("0014_intake").down_revision == REVISION
    assert script.get_revision("0014_review").down_revision == "0018_source_unavailable_items"


def test_upgrade_adds_the_columns_and_the_downgrade_drops_them(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    t, v = _version()
    _cite(t, v, "old")  # a citation from before: defaults after the upgrade
    assert not _columns() & set(COLUMNS)

    command.upgrade(_cfg(), REVISION)
    assert set(COLUMNS) <= _columns()
    assert _run("SELECT item_id, confidence, confidence_note, low_confidence FROM citations") == [
        (None, None, None, False)
    ]

    item = _item(t)
    _cite(
        t,
        v,
        "c1",
        item_id=item,
        confidence=0.75,
        confidence_note="two sources agree",
        low_confidence=True,
    )
    row = _run(
        "SELECT item_id, confidence, confidence_note, low_confidence FROM citations "
        "WHERE cite_key = 'c1'"
    )[0]
    assert (row[0], float(row[1]), row[2], row[3]) == (item, 0.75, "two sources agree", True)

    # The item is a real foreign key: deleting the item keeps the citation, item_id null.
    _run("DELETE FROM source_items WHERE id = :i", i=item)
    assert _run("SELECT item_id FROM citations WHERE cite_key = 'c1'") == [(None,)]
    with pytest.raises(IntegrityError):
        _cite(t, v, "ghost", item_id=uuid.uuid4())

    command.downgrade(_cfg(), PREVIOUS)
    assert not _columns() & set(COLUMNS)
    assert sorted(r[0] for r in _run("SELECT cite_key FROM citations")) == ["c1", "old"]


@pytest.mark.parametrize("value", [1.5, -0.1])
def test_confidence_outside_0_1_is_refused(scratch_db, value):
    command.upgrade(_cfg(), REVISION)
    t, v = _version()
    with pytest.raises(IntegrityError):
        _cite(t, v, "c1", confidence=value)
