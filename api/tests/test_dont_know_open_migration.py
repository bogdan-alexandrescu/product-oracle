"""Migration 0093_dont_know_open: a brief question whose latest answer is "I don't know"
is open again (owner 2026-10-29, qa-work-2).

Card: protects=such a question answered before reads asked, or delegated when it was
delegated first, or retired on an archived brief; one with a real answer after its "I don't
know" stays answered; the downgrade marks the reopened ones answered again; up twice
changes nothing more; chained on 0092_bet_flow_line_key as the single head; fails_when=an
"I don't know" question stays answered, a real answer is reopened, or the delegate is lost;
no_claim=new answers (test_intake_idk_open).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0093_dont_know_open"
PREVIOUS = "0092_bet_flow_line_key"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_dont_know_open")
    .render_as_string(hide_password=False)
)
T0 = datetime(2026, 10, 20, 9, 0, tzinfo=UTC)


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


def _question(t, intake, *kinds: str) -> uuid.UUID:
    q = uuid.uuid4()
    _run(
        "INSERT INTO stakeholder_questions (id, tenant_id, intake_id, category, prompt, status) "
        "VALUES (:q, :t, :i, 'general', 'Which metric?', 'answered')",
        q=q,
        t=t,
        i=intake,
    )
    for n, kind in enumerate(kinds):
        _run(
            "INSERT INTO stakeholder_answers (id, tenant_id, question_id, kind, body, created_at) "
            "VALUES (:a, :t, :q, :k, 'Some words', :at)",
            a=uuid.uuid4(),
            t=t,
            q=q,
            k=kind,
            at=T0 + timedelta(minutes=n),
        )
    return q


def _status() -> dict[uuid.UUID, str]:
    return dict(_run("SELECT id, status FROM stakeholder_questions"))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == [REVISION]


def test_dont_know_questions_open_again_and_back(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t, live, archived = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    for i, status in ((live, "awaiting_answers"), (archived, "archived")):
        _run(
            "INSERT INTO product_intakes (id, tenant_id, title, brief, status) "
            "VALUES (:i, :t, 'Brief', 'A brief', :s)",
            i=i,
            t=t,
            s=status,
        )
    unsure = _question(t, live, "dont_know")
    handed = _question(t, live, "delegate", "dont_know")
    real = _question(t, live, "dont_know", "answer")
    shelved = _question(t, archived, "dont_know")

    command.upgrade(cfg, REVISION)
    expected = {unsure: "asked", handed: "delegated", real: "answered", shelved: "retired"}
    assert _status() == expected
    command.downgrade(cfg, PREVIOUS)
    assert _status() == {
        unsure: "answered",
        handed: "answered",
        real: "answered",
        shelved: "retired",
    }
    command.upgrade(cfg, REVISION)
    assert _status() == expected
