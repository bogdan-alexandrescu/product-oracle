"""A roadmap milestone sits on a track (tb-mk: the milestone panel's Track field)

On ``track_milestones`` and ``roadmap_key_dates``: ``home_track_id``, the track the milestone
sits on (null: none; ``track_id`` is a track's own milestone's), set null when the track goes. No
backfill. The downgrade drops it.

Revision ID: 0126_milestone_track
Revises: 0125_milestone_kinds
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0126_milestone_track"
down_revision: str | None = "0125_milestone_kinds"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
TABLES = ("track_milestones", "roadmap_key_dates")


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for t in TABLES:
        op.add_column(t, sa.Column("home_track_id", sa.Uuid(), nullable=True))
        op.create_foreign_key(
            op.f(f"fk_{t}_home_track_id_product_tracks"),
            t,
            "product_tracks",
            ["home_track_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for t in TABLES:
        op.drop_constraint(op.f(f"fk_{t}_home_track_id_product_tracks"), t, type_="foreignkey")
        op.drop_column(t, "home_track_id")
