"""Old goal milestones carried onto the company roadmap (old-milestones, owner Nov 4)

``track_milestones.carried_to_id``: the company roadmap's copy of a goal milestone carried
from an older per-PRD roadmap (its history link); ``carry_dropped_at``: when an owner
dropped an old milestone none of whose items were left, so it is not carried. The
downgrade drops both.

Revision ID: 0113_goal_milestone_carried
Revises: 0112_trash_features_goals
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0113_goal_milestone_carried"
down_revision: str | None = "0112_trash_features_goals"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column(
        "track_milestones",
        sa.Column(
            "carried_to_id",
            sa.Uuid(),
            sa.ForeignKey("track_milestones.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_track_milestones_carried_to_id", "track_milestones", ["carried_to_id"])
    op.add_column(
        "track_milestones", sa.Column("carry_dropped_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("track_milestones", "carry_dropped_at")
    op.drop_index("ix_track_milestones_carried_to_id", table_name="track_milestones")
    op.drop_column("track_milestones", "carried_to_id")
