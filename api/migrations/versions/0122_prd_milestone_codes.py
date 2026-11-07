"""A PRD's goal milestones are coded per PRD, not per goal (item-milestone)

``uq_track_milestones_goal_code`` made a goal milestone's code unique per roadmap and goal,
PRD milestones included: when two PRDs' items served the same goal on the company roadmap,
the second PRD's M1, M2... collided with the first's and were never made (the read inserts
them with ON CONFLICT DO NOTHING), so only one PRD's milestones showed. Now a roadmap's own
milestones stay unique per goal (``origin_prd_id`` null), and a PRD's are unique per roadmap
and PRD (``uq_track_milestones_prd_code``). The read makes the missing ones on its next run.

Live-safe: ``track_milestones`` is small; each index is built under a capped lock wait
(LOCK_TIMEOUT).

The downgrade removes the PRD milestones that would collide again (all but the first per
roadmap, goal and code; the read never makes them again under the old index), then puts the
old index back.

Revision ID: 0122_prd_milestone_codes
Revises: 0121_simple_changes_seq
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0122_prd_milestone_codes"
down_revision: str | None = "0121_simple_changes_seq"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
T = "track_milestones"
GOAL = "uq_track_milestones_goal_code"
PRD = "uq_track_milestones_prd_code"
LIVE = "roadmap_id IS NOT NULL AND deleted_at IS NULL"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_index(GOAL, table_name=T)
    op.create_index(
        GOAL,
        T,
        ["roadmap_id", "goal_id", "code"],
        unique=True,
        postgresql_where=sa.text(f"{LIVE} AND origin_prd_id IS NULL"),
    )
    op.create_index(
        PRD,
        T,
        ["roadmap_id", "origin_prd_id", "code"],
        unique=True,
        postgresql_where=sa.text(f"{LIVE} AND origin_prd_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_index(PRD, table_name=T)
    op.drop_index(GOAL, table_name=T)
    op.execute(
        f"""
        DELETE FROM {T} t USING {T} k
        WHERE t.origin_prd_id IS NOT NULL AND t.roadmap_id IS NOT NULL
          AND t.deleted_at IS NULL AND k.deleted_at IS NULL
          AND k.roadmap_id = t.roadmap_id AND k.code = t.code
          AND k.goal_id = t.goal_id
          AND (k.origin_prd_id IS NULL OR k.id < t.id)
        """
    )
    op.create_index(
        GOAL, T, ["roadmap_id", "goal_id", "code"], unique=True, postgresql_where=sa.text(LIVE)
    )
