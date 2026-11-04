"""An approved roadmap version's plan on its items (approved-roadmap-to-simple, owner Nov 3)

``roadmap_items.date_basis``: the words the version gives for the item's dates
('engineering estimate', 'founder commitment', 'set by <person>'); ``plan_state``:
``shipped`` or ``next_prd`` when the version takes the item off the plan; ``applied``: what
the version wrote (its number and the dates), to tell a person's later change.
``track_milestones.roadmap_version_id`` and ``counts``: a milestone from a roadmap version
and how it counts. Items and milestones from before keep none. The downgrade drops them.

Revision ID: 0103_approved_roadmap_plan
Revises: 0102_draft_decision_notes
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0103_approved_roadmap_plan"
down_revision: str | None = "0102_draft_decision_notes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("roadmap_items", sa.Column("date_basis", sa.Text(), nullable=True))
    op.add_column("roadmap_items", sa.Column("plan_state", sa.Text(), nullable=True))
    op.add_column("roadmap_items", sa.Column("applied", postgresql.JSONB(), nullable=True))
    op.add_column(
        "track_milestones",
        sa.Column(
            "roadmap_version_id",
            sa.Uuid(),
            sa.ForeignKey(
                "document_versions.id",
                name=op.f("fk_track_milestones_roadmap_version_id_document_versions"),
                ondelete="CASCADE",
            ),
            nullable=True,
        ),
    )
    op.add_column("track_milestones", sa.Column("counts", sa.Text(), nullable=True))


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_column("track_milestones", "counts")
    op.drop_column("track_milestones", "roadmap_version_id")
    op.drop_column("roadmap_items", "applied")
    op.drop_column("roadmap_items", "plan_state")
    op.drop_column("roadmap_items", "date_basis")
