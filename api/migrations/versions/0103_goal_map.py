"""Simple Goal map (build-goal-map)

``focus_areas``: the areas of focus in the owner's order. ``milestone_features``: a
roadmap item serving a track milestone, with expected and measured lift. On
``track_milestones`` (the records Simple Roadmap draws, never a second milestone table)
``goal_id`` and ``waits_on_ids`` (the milestones lane's names for the goal and what it
waits on) and the gate: ``gate_threshold``, ``gate_confirmed_by``, ``gate_confirmed_on``
and ``gate_area_ids``. The reading, 7 days and status are read from the goal.

Revision ID: 0103_goal_map
Revises: 0102_goal_milestone_plan_date
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0103_goal_map"
down_revision: str | None = "0102_goal_milestone_plan_date"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

A = "focus_areas"
L = "milestone_features"
M = "track_milestones"


def _base(t: str) -> list[sa.Column]:
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.create_table(
        A,
        *_base(A),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("lever", sa.Text(), server_default="", nullable=False),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"],
                                name=op.f(f"fk_{A}_tenant_id_tenants"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{A}")),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{A}_tenant_id"), A, ["tenant_id"])
    op.create_table(
        L,
        *_base(L),
        sa.Column("milestone_id", sa.Uuid(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("area_id", sa.Uuid(), nullable=True),
        sa.Column("expected", sa.Text(), server_default="", nullable=False),
        sa.Column("confidence", sa.Text(), server_default="medium", nullable=False),
        sa.Column("released", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("measured", sa.Text(), nullable=True),
        sa.Column("lift", sa.Text(), server_default="not_measured", nullable=False),
        sa.CheckConstraint("lift IN ('helping', 'not_helping', 'not_measured')",
                           name=op.f(f"ck_{L}_lift")),
        sa.CheckConstraint("confidence IN ('high', 'medium', 'low')",
                           name=op.f(f"ck_{L}_confidence")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"],
                                name=op.f(f"fk_{L}_tenant_id_tenants"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["milestone_id"], ["track_milestones.id"],
                                name=op.f(f"fk_{L}_milestone_id_track_milestones"),
                                ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["roadmap_items.id"],
                                name=op.f(f"fk_{L}_item_id_roadmap_items"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["area_id"], ["focus_areas.id"],
                                name=op.f(f"fk_{L}_area_id_focus_areas"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{L}")),
        sa.UniqueConstraint("milestone_id", "item_id", name=op.f(f"uq_{L}_milestone_id_item_id")),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{L}_tenant_id"), L, ["tenant_id"])
    op.create_index("ix_milestone_features_item_id", L, ["item_id"])
    op.add_column(M, sa.Column("goal_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(op.f(f"fk_{M}_goal_id_entities"), M, "entities",
                          ["goal_id"], ["id"], ondelete="SET NULL")  # fmt: skip
    op.create_index(op.f(f"ix_{M}_goal_id"), M, ["goal_id"])
    op.add_column(M, sa.Column("gate_threshold", sa.Numeric(20, 6), nullable=True))
    op.add_column(M, sa.Column("gate_confirmed_by", sa.Text(), nullable=True))
    op.add_column(M, sa.Column("gate_confirmed_on", sa.Date(), nullable=True))
    for col in ("waits_on_ids", "gate_area_ids"):
        op.add_column(
            M, sa.Column(col, postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False)
        )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    for col in ("gate_area_ids", "waits_on_ids", "gate_confirmed_on", "gate_confirmed_by",
                "gate_threshold"):  # fmt: skip
        op.drop_column(M, col)
    op.drop_index(op.f(f"ix_{M}_goal_id"), table_name=M)
    op.drop_constraint(op.f(f"fk_{M}_goal_id_entities"), M, type_="foreignkey")
    op.drop_column(M, "goal_id")
    op.drop_table(L)
    op.drop_table(A)
