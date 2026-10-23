"""Migration 0020_question_subjects (C2 Questions to people): a question is about an
intake, a document (section), a run checkpoint item or a baseline entity; ``general`` is
a question category (questions only, gaps keep their 17); asked questions with no
person go to their intake's author. The downgrade drops the columns, the subject check
and the index, and restores the 17-category check, refusing while ``general``
questions exist.

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

REVISION = "0020_question_subjects"
PREVIOUS = "0020_requests"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_qsub")
    .render_as_string(hide_password=False)
)
COLUMNS = {"checkpoint_id", "item_ref", "entity_id"}


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
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'stakeholder_questions'"
    )
    return {r[0] for r in rows}


def _indexes() -> set[str]:
    rows = _run("SELECT indexname FROM pg_indexes WHERE tablename = 'stakeholder_questions'")
    return {r[0] for r in rows}


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def _company() -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """A company, an author and an intake of theirs."""
    t, u, i = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'author@example.com', 'x', 'commenter')",
        u=u,
        t=t,
    )
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief, author_id, status) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers retype addresses.', :u, "
        "'awaiting_answers')",
        i=i,
        t=t,
        u=u,
    )
    return t, u, i


def _question(t, status: str, *, intake=None, asked_to=None, category="success_metric", **cols):
    q = uuid.uuid4()
    names = "".join(f", {c}" for c in cols)
    values = "".join(f", :{c}" for c in cols)
    _run(
        "INSERT INTO stakeholder_questions (id, tenant_id, intake_id, category, prompt, "
        f"status, asked_to{names}) VALUES (:q, :t, :i, :c, 'Which metric?', :s, :a{values})",
        q=q,
        t=t,
        i=intake,
        c=category,
        s=status,
        a=asked_to,
        **cols,
    )
    return q


def _asked_to(q: uuid.UUID):
    return _run("SELECT asked_to FROM stakeholder_questions WHERE id = :q", q=q)[0][0]


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0041_trash"]


def test_upgrade_moves_asked_questions_to_the_author_and_adds_subjects(scratch_db):
    """protects=no asked question reaches nobody after the deploy; fails_when=an asked or
    delegated question keeps asked_to null; no_claim=drafts (the engine sets them when it
    asks)."""
    command.upgrade(_cfg(), PREVIOUS)
    t, author, intake = _company()
    someone = uuid.uuid4()
    asked = _question(t, "asked", intake=intake)
    delegated = _question(t, "delegated", intake=intake)
    draft = _question(t, "draft", intake=intake)
    answered = _question(t, "answered", intake=intake)
    kept = _question(t, "asked", intake=intake, asked_to=someone)
    # Every existing row has a subject (the engine always sets intake_id): the check holds.
    assert _run(
        "SELECT count(*) FROM stakeholder_questions WHERE intake_id IS NULL AND document_id IS NULL"
    ) == [(0,)]
    assert not COLUMNS & _columns()

    command.upgrade(_cfg(), REVISION)
    assert COLUMNS <= _columns()
    assert "ix_stakeholder_questions_asked_to" in _indexes()
    assert _asked_to(asked) == author and _asked_to(delegated) == author
    assert _asked_to(draft) is None and _asked_to(answered) is None
    assert _asked_to(kept) == someone

    # 'general' is a question category now; never a gap's.
    _question(t, "asked", intake=intake, category="general", asked_to=author)
    with pytest.raises(IntegrityError, match="ck_knowledge_gaps_category"):
        _run(
            "INSERT INTO knowledge_gaps (id, tenant_id, intake_id, category, statement, "
            "importance, knowledge_state, status) VALUES (gen_random_uuid(), :t, :i, "
            "'general', 'x', 'high', 'unknown', 'unknown')",
            t=t,
            i=intake,
        )
    # A question with no subject is refused.
    with pytest.raises(IntegrityError, match="ck_stakeholder_questions_subject"):
        _question(t, "asked", category="general", asked_to=author)
    # An entity subject; deleting the entity deletes its questions.
    e = uuid.uuid4()
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, status, origin) "
        "VALUES (:e, :t, 'goal', 'activation', 'Activation', 'confirmed', 'user')",
        e=e,
        t=t,
    )
    about = _question(t, "asked", category="general", asked_to=author, entity_id=e)
    _run("DELETE FROM entities WHERE id = :e", e=e)
    assert _run("SELECT count(*) FROM stakeholder_questions WHERE id = :q", q=about) == [(0,)]


def test_downgrade_refuses_while_general_questions_exist(scratch_db):
    """protects=the 17-category check comes back intact; fails_when=the downgrade drops a
    general question's category silently; no_claim=the data move (not undone)."""
    command.upgrade(_cfg(), REVISION)
    t, author, intake = _company()
    general = _question(t, "asked", intake=intake, category="general", asked_to=author)
    with pytest.raises(RuntimeError, match="general"):
        command.downgrade(_cfg(), PREVIOUS)
    assert COLUMNS <= _columns()

    _run("DELETE FROM stakeholder_questions WHERE id = :q", q=general)
    command.downgrade(_cfg(), PREVIOUS)
    assert not COLUMNS & _columns()
    assert "ix_stakeholder_questions_asked_to" not in _indexes()
    with pytest.raises(IntegrityError, match="ck_stakeholder_questions_category"):
        _question(t, "asked", intake=intake, category="general")
    # No subject check any more (as before).
    _question(t, "asked", category="success_metric")
