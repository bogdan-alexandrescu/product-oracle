"""Carry the flow over (qa-simple-prd-1): a one-pager bet's drawn flow is keyed by the line's
own id, no longer by the bet's words, so editing a bet keeps its flow.

- ``simple_visuals`` of kind ``one_pager_line``: each one keyed by the words of a bet on its
  PRD's newest built one-pager moves to that bet's line (uuid5 of the PRD and
  ``one_pager_line_id:<line id>``, oracle.simple.visuals.line_subject); its versions and
  comments go with it (they hang off the visual's id). Two bets with the same words: the
  first takes the flow, each other one gets a copy (the visual, its versions, comments).
  A flow whose words match no current line (a renamed or deleted bet) stays keyed by its
  words, read as before (oracle.simple.visuals.words_subject).

The downgrade moves each line's flow back to its bet's words on the same page; where those
words are already taken (a copy, or a flow drawn for each), the line's flow stays.

Revision ID: 0092_bet_flow_line_key
Revises: 0090_interview_new_link
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0092_bet_flow_line_key"
down_revision: str | None = "0090_interview_new_link"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _key(doc: uuid.UUID, line_id: str) -> uuid.UUID:
    return uuid.uuid5(doc, "one_pager_line_id:" + line_id)


def _words(doc: uuid.UUID, text: str) -> uuid.UUID:
    return uuid.uuid5(doc, "one_pager_line:" + " ".join(text.split()).lower())


def _pages(bind) -> dict[uuid.UUID, list[tuple[str, str]]]:
    """Each PRD with a bet's visual: its newest built one-pager's bets (line id, words)."""
    rows = bind.execute(
        sa.text(
            "SELECT DISTINCT ON (p.document_id) p.document_id, p.blocks"
            " FROM simple_one_pagers p WHERE p.document_id IN (SELECT document_id"
            " FROM simple_visuals WHERE subject_kind = 'one_pager_line')"
            " ORDER BY p.document_id, p.built_at DESC, p.built_by = 'oracle' DESC, p.id"
        )
    )
    out: dict[uuid.UUID, list[tuple[str, str]]] = {}
    for doc, blocks in rows:
        out[doc] = [
            (str(line["id"]), str(line.get("text") or ""))
            for b in blocks or []
            if isinstance(b, dict) and b.get("key") == "bets"
            for line in b.get("lines") or []
            if isinstance(line, dict) and line.get("id")
        ]
    return out


def _visuals(bind, doc: uuid.UUID) -> dict[uuid.UUID, uuid.UUID]:
    rows = bind.execute(
        sa.text(
            "SELECT subject_id, id FROM simple_visuals"
            " WHERE subject_kind = 'one_pager_line' AND document_id = :d"
        ),
        {"d": doc},
    )
    return {r[0]: r[1] for r in rows}


def _move(bind, vid: uuid.UUID, subject: uuid.UUID) -> None:
    bind.execute(
        sa.text("UPDATE simple_visuals SET subject_id = :s WHERE id = :v"), {"s": subject, "v": vid}
    )


def _copy(bind, vid: uuid.UUID, subject: uuid.UUID) -> None:
    """A copy of the visual for another bet: the visual, its versions and its comments."""
    new = uuid.uuid4()
    bind.execute(
        sa.text(
            "INSERT INTO simple_visuals SELECT (jsonb_populate_record(NULL::simple_visuals,"
            " to_jsonb(v) || jsonb_build_object('id', CAST(:n AS uuid), 'subject_id',"
            " CAST(:s AS uuid)))).* FROM simple_visuals v WHERE v.id = :v"
        ),
        {"n": new, "s": subject, "v": vid},
    )
    for table in ("simple_visual_versions", "simple_visual_comments"):
        bind.execute(
            sa.text(
                f"INSERT INTO {table} SELECT (jsonb_populate_record(NULL::{table}, to_jsonb(x)"
                " || jsonb_build_object('id', gen_random_uuid(), 'visual_id', CAST(:n AS uuid))"
                f")).* FROM {table} x WHERE x.visual_id = :v"
            ),
            {"n": new, "v": vid},
        )


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    bind = op.get_bind()
    for doc, bets in _pages(bind).items():
        have = _visuals(bind, doc)
        moved: dict[uuid.UUID, uuid.UUID] = {}
        for line_id, text in bets:
            key, words = _key(doc, line_id), _words(doc, text)
            if key in have:
                continue
            if words in moved:
                _copy(bind, moved[words], key)
            elif words in have:
                _move(bind, have[words], key)
                moved[words] = have.pop(words)
            else:
                continue
            have[key] = moved[words]


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    bind = op.get_bind()
    for doc, bets in _pages(bind).items():
        have = _visuals(bind, doc)
        for line_id, text in bets:
            key, words = _key(doc, line_id), _words(doc, text)
            if key in have and words not in have:
                _move(bind, have[key], words)
                have[words] = have.pop(key)
