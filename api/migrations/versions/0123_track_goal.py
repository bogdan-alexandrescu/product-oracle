"""A track's PRD is optional, and a track may be tied to one company goal (tracks-goal)

- ``product_tracks.prd_document_id`` takes null: a track with no PRD (a PRD still has at
  most one track: ``uq_product_tracks_tenant_id`` stays, nulls apart).
- ``product_tracks.goal_id``: the company goal the track replaces as the Roadmap's band
  (owner Nov 9); null when none, and when the goal is deleted.

The downgrade drops ``goal_id`` and deletes the tracks with no PRD (their features go to no
track) before the column takes NOT NULL again.

Revision ID: 0123_track_goal
Revises: 0122_prd_milestone_codes
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0123_track_goal"
down_revision: str | None = "0122_prd_milestone_codes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
T = "product_tracks"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.alter_column(T, "prd_document_id", nullable=True)
    op.add_column(T, sa.Column("goal_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_product_tracks_goal_id_entities", T, "entities", ["goal_id"], ["id"],
        ondelete="SET NULL",
    )  # fmt: skip
    op.create_index("ix_product_tracks_goal_id", T, ["goal_id"])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_index("ix_product_tracks_goal_id", table_name=T)
    op.drop_constraint("fk_product_tracks_goal_id_entities", T, type_="foreignkey")
    op.drop_column(T, "goal_id")
    op.execute(f"DELETE FROM {T} WHERE prd_document_id IS NULL")
    op.alter_column(T, "prd_document_id", nullable=False)
