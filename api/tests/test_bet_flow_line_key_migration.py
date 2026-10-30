"""Migration 0092_bet_flow_line_key (0092_bet_flow_line_key.py): a one-pager bet's drawn flow
moves from the bet's words to the line's own id (qa-simple-prd-1, "Carry the flow over").

Card: protects=an old flow keyed by a bet's words moves to that bet's line (its versions and
comments with it); two bets with the same words each get the flow (the second a copy); a
flow whose words match no current line (a renamed or deleted bet) stays keyed by its words;
a flow keyed by the words an open working draft gave a bet stays on them (drawn from
unpublished words: never on the published bet's line); the downgrade moves each line's
flow back to its words, leaving a copy where the words are taken; up again changes nothing
more; chained on 0092_rituals_wait_for_goal as the single head; fails_when=a flow stays on
the words of a current bet, is lost, lands on the wrong line, a draft's words' flow lands
on the published bet's line, or the downgrade leaves it on the line; no_claim=the reads
(test_simple_line_visuals_api).

Sync on purpose (Alembic runs its own event loop); its own scratch database."""

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0092_bet_flow_line_key"
PREVIOUS = "0092_rituals_wait_for_goal"
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


def _blocks(*bets: str, keys: dict[str, str] | None = None) -> str:
    lines = [
        {"id": f"bets-{i}", "text": b, "source_keys": ["build"]} for i, b in enumerate(bets, 1)
    ]
    for x in lines:
        if (keys or {}).get(x["id"]):
            x["flow_key"] = keys[x["id"]]
    return json.dumps([{"key": "bets", "lines": lines}])


def _flow(t: uuid.UUID, d: uuid.UUID, subject: uuid.UUID, brief: str) -> None:
    vid = uuid.uuid4()
    _run(
        "INSERT INTO simple_visuals (id, tenant_id, subject_kind, subject_id, document_id, "
        "brief) VALUES (:id, :t, 'one_pager_line', :s, :d, :b)",
        id=vid, t=t, s=subject, d=d, b=brief,
    )  # fmt: skip
    _run(
        "INSERT INTO simple_visual_versions (id, tenant_id, visual_id, number, title, steps, "
        "flow_svg) VALUES (gen_random_uuid(), :t, :v, 1, :title, '[]', '<svg/>')",
        t=t, v=vid, title=f"Flow of {brief}",
    )  # fmt: skip
    _run(
        "INSERT INTO simple_visual_comments (id, tenant_id, visual_id, version_number, body, "
        "author_id) VALUES (gen_random_uuid(), :t, :v, 1, :b, :u)",
        t=t, v=vid, b=f"About {brief}", u=uuid.uuid4(),
    )  # fmt: skip


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
            (datetime(2026, 10, 1, 10, tzinfo=UTC), _blocks("Sample project", "Checklist")),
            (
                datetime(2026, 10, 20, 10, tzinfo=UTC),
                _blocks("Checklist", "Invites", "  invites ", "A guide"),
            ),
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
            "'s', CAST(:b AS jsonb), 'oracle', :w)",
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
    # Back to words; the copy goes (its words hold the flow): a clean round trip.
    assert back == before
    # Up again: the same as the first time.
    command.upgrade(cfg, REVISION)
    assert _flows() == moved


def test_the_published_page_its_keys_and_the_draft(scratch_db):
    """The published page is read, not the newest build (a later version not approved);
    a line's carried key is moved back on the way down; a flow keyed by the words an open
    working draft gives a bet stays on those words both ways (drawn from unpublished
    words, it never reaches the published bet's line)."""
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    t, d, u = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'setup', 'Guided setup', 'draft')",
        d=d, t=t,
    )  # fmt: skip
    pages = (
        (1, datetime(2026, 10, 1, 10, tzinfo=UTC), datetime(2026, 10, 1, 10, tzinfo=UTC),
         _blocks("Invites", "Checklist", "A guide", keys={"bets-3": "carried"})),
        (2, None, datetime(2026, 10, 20, 10, tzinfo=UTC), _blocks("Checklist", "Invites")),
    )  # fmt: skip
    for n, approved, when, blocks in pages:
        v = uuid.uuid4()
        _run(
            "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
            "content_hash, approved_at) VALUES (:v, :t, :d, :n, 'x', :h, :a)",
            v=v, t=t, d=d, n=n, h=f"h{n}", a=approved,
        )  # fmt: skip
        _run(
            "INSERT INTO simple_one_pagers (id, tenant_id, document_id, version_id, "
            "sections_hash, blocks, built_by, built_at) VALUES (gen_random_uuid(), :t, :d, :v, "
            "'s', CAST(:b AS jsonb), 'oracle', :w)",
            t=t, d=d, v=v, b=blocks, w=when,
        )  # fmt: skip
    _run(
        "INSERT INTO simple_drafts (id, tenant_id, document_id, status, overlay, created_by) "
        "VALUES (gen_random_uuid(), :t, :d, 'working', CAST(:o AS jsonb), :u)",
        t=t, d=d, u=u, o=json.dumps({"lines": {"bets-1": "Invites for teams"}}),
    )  # fmt: skip
    # Old flows: one by a published bet's words, one by the words the draft gave a bet.
    _flow(t, d, words(d, "Checklist"), "Checklist")
    _flow(t, d, words(d, "Invites for teams"), "Invites")
    command.upgrade(cfg, REVISION)
    # The draft's words' flow was drawn from unpublished words: it stays keyed by them
    # (read by who sees the draft), never moved to the bet's line on the published page.
    moved = {
        key(d, "bets-2"): flow("Checklist"),
        words(d, "Invites for teams"): flow("Invites"),
    }
    assert _flows() == moved
    # A bet whose key was carried over from an earlier build.
    _flow(t, d, key(d, "carried"), "A guide")
    command.downgrade(cfg, PREVIOUS)
    assert _flows() == {
        words(d, "Checklist"): flow("Checklist"),
        words(d, "Invites for teams"): flow("Invites"),
        words(d, "A guide"): flow("A guide"),
    }
    command.upgrade(cfg, REVISION)
    assert _flows() == {**moved, key(d, "carried"): flow("A guide")}
