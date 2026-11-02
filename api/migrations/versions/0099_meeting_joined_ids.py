"""Who has joined a Simple review meeting (walkc-meeting r2, 5a)

``simple_meetings.joined_ids``: the presenter at the start, then each person who presses
Join. An invited attendee who has not joined reads "invited, not joined yet" on the
meeting's screen, never "here". Existing meetings count every attendee as joined, as
they read before.

Revision ID: 0099_meeting_joined_ids
Revises: 0098_draft_added_reviewers
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0099_meeting_joined_ids"
down_revision: str | None = "0098_draft_added_reviewers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "simple_meetings",
        sa.Column("joined_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
    )
    op.execute("UPDATE simple_meetings SET joined_ids = attendee_ids")


def downgrade() -> None:
    op.drop_column("simple_meetings", "joined_ids")
