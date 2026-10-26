"""Fireflies endpoint: an owner-set GraphQL endpoint URL on a connection

``connections.endpoint_url``: the GraphQL endpoint a Fireflies connection reads, set
only by an Oracle owner (BGD, "Build now, owner-set, guarded"). Nullable, no backfill:
a connection without one reads https://api.fireflies.ai/graphql, as before.

Live-safe: one nullable column, no default, no rewrite.

The downgrade drops the column (connections read the default endpoint again).

Revision ID: 0058_fireflies_endpoint
Revises: 0057_release_archived_briefs
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0058_fireflies_endpoint"
down_revision: str | None = "0057_release_archived_briefs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("connections", sa.Column("endpoint_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("connections", "endpoint_url")
