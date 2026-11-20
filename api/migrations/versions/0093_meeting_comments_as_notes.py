"""Old meeting comments as comments (fix4-simple-decide review): a comment made in a meeting
before qa-simple-decide-1 was recorded as a meeting decision titled "Comment: ..."; each
becomes its meeting's comment note, leaves the meeting's decisions and is withdrawn. Data
only; the downgrade keeps them as comments.

The move is frozen here as oracle.simple.meetings.comment_decisions_to_notes was at this
revision (#1575), so a later change to the app does not change this migration.

Revision ID: 0093_meeting_comments_as_notes
Revises: 0092_feedback_discussion
"""

import json
import uuid
from collections.abc import Sequence
from typing import Any

from alembic import op
from sqlalchemy import text

revision: str = "0093_meeting_comments_as_notes"
down_revision: str | None = "0092_feedback_discussion"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

COMMENT_PREFIX = "Comment: "


def _comment_decisions_to_notes(conn: Any) -> int:
    """Each "Comment: ..." meeting decision becomes its meeting's comment note (its words,
    who, when), leaves the meeting's decisions and is withdrawn; a second run finds
    nothing. How many moved."""
    rows = conn.execute(text(
        "SELECT l.meeting_id, d.id, d.title, d.approver_id, coalesce(d.decided_at, d.created_at)"
        " FROM simple_meeting_decisions l JOIN decisions d ON d.id = l.decision_id"
        " WHERE d.origin = 'meeting' AND d.title LIKE :p ORDER BY 5"
    ), {"p": COMMENT_PREFIX + "%"}).all()  # fmt: skip
    for meeting_id, decision_id, title, by, at in rows:
        note = {"id": str(uuid.uuid4()), "kind": "comment",
                "text": title.removeprefix(COMMENT_PREFIX).strip()[:1000],
                "by": str(by) if by else None, "at": at.isoformat(), "card_id": None}  # fmt: skip
        conn.execute(
            text("UPDATE simple_meetings SET notes = notes || CAST(:n AS jsonb) WHERE id = :m"),
            {"n": json.dumps([note]), "m": meeting_id},
        )
        conn.execute(text("DELETE FROM simple_meeting_decisions WHERE decision_id = :d"),
                     {"d": decision_id})  # fmt: skip
        conn.execute(text("UPDATE decisions SET status = 'withdrawn' WHERE id = :d"),
                     {"d": decision_id})  # fmt: skip
    return len(rows)


def upgrade() -> None:
    _comment_decisions_to_notes(op.get_bind())


def downgrade() -> None:
    pass
