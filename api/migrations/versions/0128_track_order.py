"""The company's tracks keep one order (track-order, owner Nov 9)

On ``product_tracks``: ``position``, a track's place in the company's track order (1 = first;
null: after every placed one, oldest first). Backfilled per company oldest first, so today's
order (newest last) is kept until someone moves one. The downgrade drops it.

Revision ID: 0128_track_order
Revises: 0127_trash_tasks
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0128_track_order"
down_revision: str | None = "0127_trash_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("product_tracks", sa.Column("position", sa.Integer(), nullable=True))
    op.execute(
        """
        UPDATE product_tracks AS t SET position = n.place
        FROM (
            SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS place
            FROM product_tracks
        ) AS n
        WHERE t.id = n.id
        """
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("product_tracks", "position")
