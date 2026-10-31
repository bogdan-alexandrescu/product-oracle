"""Migration 0095_meeting_chat_key (0095_meeting_chat_key.py): a meeting's chat moves from
the meeting's screen key to its own (``meeting_chat:<id>``), apart from Oracle's Ask panel.

Card: protects=on each meeting screen key the discussion the chat used (the oldest panel
discussion there) moves to the chat's own key when the chat wrote in it, an Ask discussion
the chat adopted included, or when it is the chat's own with no line yet (titled "Meeting
chat"); a newer Ask discussion, a key whose discussions hold no chat line,
another page's chat and an Ask chat stay put; the downgrade puts the keys back; up again
works; chained on 0094_generation_checks, one head; fails_when=a meeting's chat is
left on the screen key (it loses its lines), an Ask-only discussion becomes a chat, or a key
differs after the round trip; no_claim=the chat's behaviour
(test_simple_meeting_chat_own_key).

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

REVISION = "0095_meeting_chat_key"
PREVIOUS = "0094_generation_checks"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_meeting_chat_key")
    .render_as_string(hide_password=False)
)
CHAT = "oracle.simple.chat"
T0 = datetime(2026, 10, 1, 9, tzinfo=UTC)


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


def _thread(t, path: str, title: str, minutes: int, lines: list[str | None]) -> uuid.UUID:
    """A panel discussion on ``path``, ``minutes`` after T0, with one Oracle line per
    ``lines`` entry (its model: the chat's own, a discussion reply's or none)."""
    x, u = uuid.uuid4(), uuid.uuid4()
    _run(
        "INSERT INTO discussions (id, tenant_id, subject_kind, subject, subject_key, title, "
        "visibility, origin, started_by, created_at) VALUES (:x, :t, 'screen', "
        "CAST(:s AS jsonb), :k, :title, 'private', 'panel', :u, :at)",
        x=x, t=t, s=f'{{"path": "{path}"}}', k=f"screen:{path}", title=title, u=u,
        at=T0 + timedelta(minutes=minutes),
    )  # fmt: skip
    for i, model in enumerate(lines):
        _run(
            "INSERT INTO discussion_messages (id, tenant_id, discussion_id, author_kind, body, "
            "model, created_at) VALUES (gen_random_uuid(), :t, :x, 'oracle', 'Noted.', :m, :at)",
            t=t, x=x, m=model, at=T0 + timedelta(minutes=minutes, seconds=i + 1),
        )  # fmt: skip
    return x


def _keys() -> dict[uuid.UUID, str]:
    return dict(_run("SELECT id, subject_key FROM discussions"))


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert len(script.get_heads()) == 1


def test_each_meeting_keeps_its_chat(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t = uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    a, b, c, d, e = (uuid.uuid4() for _ in range(5))
    # A: the chat opened first; an Ask question came later.
    a_chat = _thread(t, f"/simple/meetings/{a}", "Meeting chat", 0, [CHAT])
    a_ask = _thread(t, f"/simple/meetings/{a}", "What is late?", 5, ["claude"])
    # B: an Ask question came first, and the chat adopted its discussion.
    b_chat = _thread(t, f"/simple/meetings/{b}", "What is late?", 0, ["claude", CHAT])
    b_ask = _thread(t, f"/simple/meetings/{b}", "Who owns it?", 5, ["claude"])
    # C: Ask questions only; the chat never wrote.
    c_ask = _thread(t, f"/simple/meetings/{c}", "What is late?", 0, ["claude"])
    c_ask2 = _thread(t, f"/simple/meetings/{c}", "Who owns it?", 5, [CHAT])
    # E: the chat's own discussion, opened with no line yet; an Ask question came later.
    e_chat = _thread(t, f"/simple/meetings/{e}", "Meeting chat", 0, [])
    e_ask = _thread(t, f"/simple/meetings/{e}", "What is late?", 5, ["claude"])
    # The Ask panel on the chat's own page, and a person's Simple Ask chat on the meeting page.
    d_page = _thread(t, f"/simple/meetings/{d}/chat", "What is late?", 0, [CHAT])
    own = _thread(t, f"/simple/ask/{uuid.uuid4()}/simple/meetings/{d}", "Ask Oracle: changes",
                  0, [CHAT])  # fmt: skip
    before = _keys()

    command.upgrade(cfg, REVISION)
    after = _keys()
    assert after[a_chat] == f"meeting_chat:{a}"
    assert after[b_chat] == f"meeting_chat:{b}"
    assert after[e_chat] == f"meeting_chat:{e}"
    for x in (a_ask, b_ask, c_ask, c_ask2, d_page, own, e_ask):
        assert after[x] == before[x], x

    command.downgrade(cfg, PREVIOUS)
    assert _keys() == before
    command.upgrade(cfg, REVISION)
    assert _keys() == after
