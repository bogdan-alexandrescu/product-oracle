"""When a ritual's occurrence last failed to prepare (inbox-ritual-seen review, Nov 10)

- ``ritual_occurrences.failed_at``: set on the ritual clock each time the occurrence becomes
  ``failed``; its owners' Inbox row is new until they open the occurrence after it. Existing
  failed occurrences take their ``updated_at``.

Revision ID: 0129_ritual_failed_at
Revises: 0128_track_order
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0129_ritual_failed_at"
down_revision: str | None = "0128_track_order"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

T = "ritual_occurrences"


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column(T, sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(f"UPDATE {T} SET failed_at = updated_at WHERE status = 'failed'")


def downgrade() -> None:
    op.drop_column(T, "failed_at")
