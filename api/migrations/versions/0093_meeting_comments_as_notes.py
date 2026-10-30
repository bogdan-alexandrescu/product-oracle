"""Old meeting comments as comments (fix4-simple-decide review): a comment made in a meeting
before qa-simple-decide-1 was recorded as a meeting decision titled "Comment: ..."; each
becomes its meeting's comment note, leaves the meeting's decisions and is withdrawn
(oracle.simple.meetings.comment_decisions_to_notes). Data only; the downgrade keeps them as
comments.

Revision ID: 0093_meeting_comments_as_notes
Revises: 0092_feedback_discussion
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0093_meeting_comments_as_notes"
down_revision: str | None = "0092_feedback_discussion"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    from oracle.simple.meetings import comment_decisions_to_notes

    comment_decisions_to_notes(op.get_bind())


def downgrade() -> None:
    pass
