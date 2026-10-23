"""The structured review a send-back delivers (D4)

Additive. ``checkpoints.review`` (JSONB, nullable) holds the ``review.yaml`` a send-back
built from the shared draft (oracle.runs.review_file), set in the decision's transaction.
Existing checkpoints keep their note and have no review.

Live-safe: adding a nullable column with no default is a catalog change; the wait for
its lock is capped (LOCK_TIMEOUT) so a busy table fails the migration instead of queueing
every run read behind it.

The downgrade drops the column; decisions keep their notes.

Revision ID: 0025_checkpoint_review
Revises: 0024_segment_skipped
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0025_checkpoint_review"
down_revision: str | None = "0024_segment_skipped"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "5s"


def _lock_timeout(value: str) -> str:
    """Set this transaction's lock wait; returns the one it replaces."""
    bind = op.get_bind()
    before = bind.scalar(sa.text("SELECT current_setting('lock_timeout')"))
    bind.execute(sa.text("SELECT set_config('lock_timeout', :t, true)"), {"t": value})
    return before


def upgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    op.add_column("checkpoints", sa.Column("review", postgresql.JSONB(), nullable=True))
    _lock_timeout(before)


def downgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    op.drop_column("checkpoints", "review")
    _lock_timeout(before)
