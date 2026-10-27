"""Simple (#723), Remind on a one-pager (owner, 2026-10-26).

- ``simple_drafts.reminders``: when each waiting reviewer of a submitted draft was last
  reminded (``{user_id: iso time}``), so Remind nudges a reviewer at most once a day.
- ``review_reminder`` joins ``notifications.kind``: the Inbox nudge "<name> is waiting for
  your review of <PRD>".

Live-safe: a column with a constant default and a wider check constraint.

The downgrade deletes the ``review_reminder`` notifications and drops the column.

Revision ID: 0081_simple_review_reminders
Revises: 0080_simple_one_pagers
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0081_simple_review_reminders"
down_revision: str | None = "0080_simple_one_pagers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("notifications", "ck_notifications_kind", "kind")


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "simple_drafts",
        sa.Column(
            "reminders",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
    )
    add_check_values(*KIND_CHECK, ("review_reminder",))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM notifications WHERE kind = 'review_reminder'")
    remove_check_values(*KIND_CHECK, ("review_reminder",))
    op.drop_column("simple_drafts", "reminders")
