"""Simple chat-actions (#723): an item's own owner and decider, and a meeting's live notes
and agenda.

- ``roadmap_items.owner_id`` / ``decider_id``: the person the item names as its owner or
  decider (oracle.simple.changes ``set_owner`` / ``set_decider``, through the working draft);
  null: its track's owner and its roadmap's decider, as before.
- ``simple_meetings.notes``: the minutes notes and open questions added during the meeting
  (oracle.simple.chat_actions); ``agenda``: the item taken next and the items skipped.

Revision ID: 0087_simple_chat_actions
Revises: 0086_simple_meetings
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0087_simple_chat_actions"
down_revision: str | None = "0086_simple_meetings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("roadmap_items", sa.Column("owner_id", sa.Uuid(), nullable=True))
    op.add_column("roadmap_items", sa.Column("decider_id", sa.Uuid(), nullable=True))
    op.add_column("simple_meetings", sa.Column("notes", postgresql.JSONB(), nullable=False,
                                               server_default="[]"))  # fmt: skip
    op.add_column("simple_meetings", sa.Column("agenda", postgresql.JSONB(), nullable=False,
                                               server_default="{}"))  # fmt: skip


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_column("simple_meetings", "agenda")
    op.drop_column("simple_meetings", "notes")
    op.drop_column("roadmap_items", "decider_id")
    op.drop_column("roadmap_items", "owner_id")
