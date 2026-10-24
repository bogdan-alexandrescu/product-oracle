"""H10 Reasoned no (#515): when the member who asked opened the answer

``request_replies.opened_at``: set when the member who asked opens Answer to your request
in their Inbox; the row ends then, not 14 days after they were told (owner 2026-10-24,
Train N item 3). Nullable, with no backfill: a reply told before this revision stays
unopened until its asker opens it.

Live-safe: one nullable column, no default, no rewrite.

The downgrade drops the column (the opened marks go with it).

Revision ID: 0054_reply_opened
Revises: 0053_web_tools
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0054_reply_opened"
down_revision: str | None = "0053_web_tools"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "request_replies", sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("request_replies", "opened_at")
