"""S4 Freshness (A2 §8): the run ticker's hourly per-source sync and its backoff

``sources.sync_failures``: background syncs that failed in a row (0 after one completes,
or after a Sync now that completes). ``sources.next_sync_at``: the earliest a background
sync may try the source again (a failure's backoff, a rate limit's retry time); null when
nothing holds it back.

Live-safe: a nullable column and an integer column with a constant default (no rewrite).

The downgrade drops both columns (only the backoff state goes).

Revision ID: 0055_source_sync
Revises: 0054_reply_opened
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0055_source_sync"
down_revision: str | None = "0054_reply_opened"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "sources",
        sa.Column("sync_failures", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("sources", sa.Column("next_sync_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("sources", "next_sync_at")
    op.drop_column("sources", "sync_failures")
