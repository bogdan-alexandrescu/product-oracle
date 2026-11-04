"""A PRD goal milestone remembers its plan's date (build-milestones-on-roadmap review)

``track_milestones.plan_date``: the date the PRD's latest approved plan last gave a goal
milestone read from that PRD (``origin_prd_id`` set). Each roadmap read compares the plan's
date with it: when a newer approved version moves the date, the milestone takes it; while it
stays, a date the PRD owner accepted on the roadmap holds. Null for every other row.

Live-safe: one new nullable column. The downgrade drops it.

Revision ID: 0102_goal_milestone_plan_date
Revises: 0101_simple_goal_milestones
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0102_goal_milestone_plan_date"
down_revision: str | None = "0101_simple_goal_milestones"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("track_milestones", sa.Column("plan_date", sa.Date(), nullable=True))
    op.execute(
        "UPDATE track_milestones SET plan_date = target_date "
        "WHERE origin_prd_id IS NOT NULL AND pending_change IS NULL"
    )


def downgrade() -> None:
    op.drop_column("track_milestones", "plan_date")
