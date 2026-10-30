"""Carry the flow over (qa-simple-prd-1): a one-pager bet's drawn flow is keyed by the line's
own id, no longer by the bet's words, so editing a bet keeps its flow.

- ``simple_visuals`` of kind ``one_pager_line``: each one keyed by the words of a bet on its
  PRD's published one-pager (the latest approved version's newest build; with none
  approved, the latest version not in review: oracle.simple.one_pager.published) moves to
  that bet's line (uuid5 of the PRD and ``one_pager_line_id:<line id>``,
  oracle.simple.visuals.line_subject); its versions and comments go with it (they hang off
  the visual's id). Two bets with the same words: the first takes the flow, each other one
  gets a copy (the visual, its versions, comments). A flow keyed by the words an open
  working draft gave a bet stays keyed by those words: it was drawn from unpublished words,
  so it never goes to the bet's line, which who reads only the published page reads
  (oracle.simple.visuals.bet_line finds it by the draft's words for who sees the draft); a
  copy of the line's own flow there (the downgrade's) goes. A flow whose words match no
  current line (a renamed or deleted bet) stays keyed by its words, read as before
  (oracle.simple.visuals.words_subject).

The downgrade moves each line's flow (its key carried across builds: ``flow_key``, else
the line id) back to its bet's words on the same page, and copies it to the words an open
working draft gives the bet, unless a flow is already keyed by them (who sees the draft
reads it by those). A line's flow that is
a copy of the one its words hold goes; one drawn for the line itself stays.

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


def _pages(bind) -> dict[uuid.UUID, list[tuple[str, str, str | None]]]:
    """Each PRD with a bet's visual: its published one-pager's bets (the line's key, its
    words, the words an open working draft gives it)."""
    rows = bind.execute(
        sa.text(
            "SELECT DISTINCT ON (p.document_id) p.document_id, p.blocks,"
            " (SELECT d.overlay FROM simple_drafts d WHERE d.document_id = p.document_id"
            "  AND d.status IN ('working', 'submitted') ORDER BY d.created_at DESC LIMIT 1)"
            " FROM simple_one_pagers p JOIN document_versions v ON v.id = p.version_id"
            " WHERE p.document_id IN (SELECT document_id FROM simple_visuals"
            "  WHERE subject_kind = 'one_pager_line')"
            " AND v.id NOT IN (SELECT version_id FROM simple_drafts"
            "  WHERE status = 'submitted' AND version_id IS NOT NULL)"
            " ORDER BY p.document_id, v.approved_at IS NOT NULL DESC, v.number DESC,"
            " p.built_at DESC, p.built_by = 'oracle' DESC, p.id"
        )
    )
    out: dict[uuid.UUID, list[tuple[str, str, str | None]]] = {}
    for doc, blocks, overlay in rows:
        edited = (overlay or {}).get("lines") or {} if isinstance(overlay, dict) else {}
        out[doc] = [
            (
                str(line.get("flow_key") or line["id"]),
                str(line.get("text") or ""),
                edited.get(line["id"]) or None,
            )
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


def _same(bind, a: uuid.UUID, b: uuid.UUID) -> bool:
    """Visual ``a`` is a copy of ``b`` (``_copy``): the same row but its id and subject,
    the same drawings and comments."""
    return bool(
        bind.scalar(
            sa.text(
                "SELECT (SELECT to_jsonb(v) - 'id' - 'subject_id' FROM simple_visuals v"
                "  WHERE v.id = :a) = (SELECT to_jsonb(v) - 'id' - 'subject_id'"
                "  FROM simple_visuals v WHERE v.id = :b)"
                " AND (SELECT array_agg(x.number || x.title ORDER BY x.number)"
                "  FROM simple_visual_versions x WHERE x.visual_id = :a)"
                " IS NOT DISTINCT FROM (SELECT array_agg(x.number || x.title ORDER BY x.number)"
                "  FROM simple_visual_versions x WHERE x.visual_id = :b)"
                " AND (SELECT count(*) FROM simple_visual_comments c WHERE c.visual_id = :a)"
                " = (SELECT count(*) FROM simple_visual_comments c WHERE c.visual_id = :b)"
            ),
            {"a": a, "b": b},
        )
    )


def _drop(bind, vid: uuid.UUID) -> None:
    for table in ("simple_visual_comments", "simple_visual_versions"):
        bind.execute(sa.text(f"DELETE FROM {table} WHERE visual_id = :v"), {"v": vid})
    bind.execute(sa.text("DELETE FROM simple_visuals WHERE id = :v"), {"v": vid})


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    bind = op.get_bind()
    for doc, bets in _pages(bind).items():
        have = _visuals(bind, doc)
        moved: dict[uuid.UUID, uuid.UUID] = {}
        for line_key, text, _ in bets:
            key, words = _key(doc, line_key), _words(doc, text)
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
        # The words a working draft gave a bet: a flow drawn from them stays keyed by them
        # (who sees the draft reads it by them; on the bet's line, who reads only the
        # published page would read a drawing of words they may not see). Only the copy the
        # downgrade left of the line's own flow goes.
        for line_key, text, draft in bets:
            key, words = _key(doc, line_key), _words(doc, draft or "")
            if not draft or words == _words(doc, text) or words not in have:
                continue
            if key in have and _same(bind, have[words], have[key]):
                _drop(bind, have.pop(words))


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    bind = op.get_bind()
    for doc, bets in _pages(bind).items():
        have = _visuals(bind, doc)
        for line_key, text, draft in bets:
            key, words = _key(doc, line_key), _words(doc, text)
            if key not in have:
                continue
            if words not in have:
                _move(bind, have[key], words)
                have[words] = have.pop(key)
            elif _same(bind, have[key], have[words]):
                _drop(bind, have.pop(key))
            else:
                continue
            said = _words(doc, draft or "")
            if draft and said not in have:
                _copy(bind, have[words], said)
                have[said] = have[words]
