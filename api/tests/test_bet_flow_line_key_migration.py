"""Migration 0092_bet_flow_line_key (0092_bet_flow_line_key.py): a one-pager bet's drawn flow
moves from the bet's words to the line's own id (qa-simple-prd-1, "Carry the flow over").

Card: protects=an old flow keyed by a bet's words moves to that bet's line (its versions and
comments with it); two bets with the same words each get the flow (the second a copy); a
flow whose words match no current line (a renamed or deleted bet) stays keyed by its words;
the downgrade moves each line's flow back to its words, leaving a copy where the words are
taken; up again changes nothing more; chained on 0090_interview_new_link as the single
head; fails_when=a flow stays on the words of a current bet, is lost, lands on the wrong
line, or the downgrade leaves it on the line; no_claim=the reads (test_simple_line_visuals_api).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import json
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0092_bet_flow_line_key"
PREVIOUS = "0090_interview_new_link"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_bet_flow_line_key")
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


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def words(doc: uuid.UUID, t: str) -> uuid.UUID:
    return uuid.uuid5(doc, "one_pager_line:" + " ".join(t.split()).lower())


def key(doc: uuid.UUID, line_id: str) -> uuid.UUID:
    return uuid.uuid5(doc, "one_pager_line_id:" + line_id)


def _blocks(*bets: str) -> str:
    lines = [{"id": f"bets-{i}", "text": b, "source_keys": ["build"]} for i, b in enumerate(bets, 1)]
    return json.dumps([{"key": "bets", "lines": lines}])


def _world() -> tuple[uuid.UUID, uuid.UUID]:
    t, d, u = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'setup', 'Guided setup', 'draft')",
        d=d, t=t,
    )  # fmt: skip
    for n, (when, blocks) in enumerate(
        (
            ("2026-10-01T10:00:00Z", _blocks("Sample project", "Checklist")),
            ("2026-10-20T10:00:00Z", _blocks("Checklist", "Invites", "  invites ", "A guide")),
        ),
        1,
    ):
        v = uuid.uuid4()
        _run(
            "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
            "content_hash) VALUES (:v, :t, :d, :n, 'x', :h)",
            v=v, t=t, d=d, n=n, h=f"h{n}",
        )  # fmt: skip
        _run(
            "INSERT INTO simple_one_pagers (id, tenant_id, document_id, version_id, "
            "sections_hash, blocks, built_by, built_at) VALUES (gen_random_uuid(), :t, :d, :v, "
            "'s', CAST(:b AS jsonb), 'oracle', CAST(:w AS timestamptz))",
            t=t, d=d, v=v, b=blocks, w=when,
        )  # fmt: skip
    # Old flows keyed by words: two current bets, a renamed bet's ("A tour" is now "A
    # guide") and a deleted bet's ("Sample project").
    for brief in ("Checklist", "Invites", "A tour", "Sample project"):
        vid = uuid.uuid4()
        _run(
            "INSERT INTO simple_visuals (id, tenant_id, subject_kind, subject_id, document_id, "
            "brief) VALUES (:id, :t, 'one_pager_line', :s, :d, :b)",
            id=vid, t=t, s=words(d, brief), d=d, b=brief,
        )  # fmt: skip
        _run(
            "INSERT INTO simple_visual_versions (id, tenant_id, visual_id, number, title, steps, "
            "flow_svg) VALUES (gen_random_uuid(), :t, :v, 1, :title, '[]', '<svg/>')",
            t=t, v=vid, title=f"Flow of {brief}",
        )  # fmt: skip
        _run(
            "INSERT INTO simple_visual_comments (id, tenant_id, visual_id, version_number, body, "
            "author_id) VALUES (gen_random_uuid(), :t, :v, 1, :b, :u)",
            t=t, v=vid, b=f"About {brief}", u=u,
        )  # fmt: skip
    return t, d


def _flows() -> dict[uuid.UUID, tuple[str, str, str]]:
    """Each one-pager line visual's subject: its brief, its drawing's title, its comment."""
    rows = _run(
        "SELECT v.subject_id, v.brief, ver.title, c.body FROM simple_visuals v "
        "JOIN simple_visual_versions ver ON ver.visual_id = v.id "
        "JOIN simple_visual_comments c ON c.visual_id = v.id "
        "WHERE v.subject_kind = 'one_pager_line'"
    )
    out = {r[0]: (r[1], r[2], r[3]) for r in rows}
    assert len(out) == len(rows)
    return out


def flow(brief: str) -> tuple[str, str, str]:
    return (brief, f"Flow of {brief}", f"About {brief}")


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == [REVISION]


def test_flows_move_to_the_line_and_back(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    _, d = _world()
    before = _flows()
    command.upgrade(cfg, REVISION)
    moved = {
        # An old flow: its bet's line.
        key(d, "bets-1"): flow("Checklist"),
        # Two bets with the same words: each its own flow (the second a copy).
        key(d, "bets-2"): flow("Invites"),
        key(d, "bets-3"): flow("Invites"),
        # A renamed bet's and a deleted bet's: their words match no current line.
        words(d, "A tour"): flow("A tour"),
        words(d, "Sample project"): flow("Sample project"),
    }
    assert _flows() == moved
    command.downgrade(cfg, PREVIOUS)
    back = _flows()
    # Back to words; the copy stays on its line (its words are taken).
    assert back == {**before, key(d, "bets-3"): flow("Invites")}
    # Up again: the same as the first time.
    command.upgrade(cfg, REVISION)
    assert _flows() == moved
