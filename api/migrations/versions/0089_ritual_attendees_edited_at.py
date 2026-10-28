"""The walk-fixes review 2: when a ritual's attendee list was last edited.

- ``rituals.attendees_edited_at``: set when an owner edits the attendees. The next review
  lists who was present at the last review held until then (oracle.simple.meetings);
  ``updated_at`` moved with every ``next_due_at`` the scheduler set, which dropped them.
  Null (never edited since) keeps the past attendees.

The downgrade drops the column.

Revision ID: 0089_ritual_attendees_edited_at
Revises: 0088_simple_chat_actions
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0089_ritual_attendees_edited_at"
down_revision: str | None = "0088_simple_chat_actions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("rituals", sa.Column("attendees_edited_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_column("rituals", "attendees_edited_at")
