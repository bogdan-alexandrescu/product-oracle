"""When a sync that has not finished last stored something (#249)

Additive. ``sources`` gains ``partly_synced_at``: set when a sync commits a checkpoint
before it finishes (a rate limit stops it, the next sync resumes), cleared when a sync
finishes. ``last_synced_at`` stays the last finished sync, so a source whose first sync
stopped part way reads "partly synced", not "never synced".

Live-safe: a nullable column without a default (a catalog-only change); existing sources
read null.

Revision ID: 0023_source_partial_sync
Revises: 0022_invite_delivery
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0023_source_partial_sync"
down_revision: str | None = "0022_invite_delivery"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sources", sa.Column("partly_synced_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    op.drop_column("sources", "partly_synced_at")
