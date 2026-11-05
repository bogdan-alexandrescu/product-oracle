"""Simple roadmap milestones per goal (build-milestones-on-roadmap)

``track_milestones`` gains what a goal milestone on the Simple roadmap needs, reusing
Oracle's existing milestone model rather than a second table (another lane reads the same
milestones): ``roadmap_id`` (the Simple roadmap document it sits on; null for a track
milestone), ``goal_id`` (nullable), ``code`` ("M1".. numbered per goal on that roadmap),
``counts_when`` (the rule for when it counts), ``progress`` (on_track/at_risk/not_started/
met; the existing ``status`` column keeps its own planned/done/dropped semantics),
``origin_prd_id`` (the PRD document it is read from, nullable), ``pending_change`` (a
proposed date/counts_when waiting on the PRD owner's decision), ``item_ids`` (the items it
waits on, as uuids of Simple roadmap items; ``item_keys`` stays for track milestones) and
``deleted_at`` (soft delete; restore clears it).

``track_id`` becomes nullable: a goal milestone has a roadmap, not a track. The
``dated_needs_basis`` check (a dated track milestone needs a verified basis, O4) is relaxed
for rows with ``roadmap_id`` set: a goal milestone's date needs no basis, same as a key
date.

Live-safe: new nullable columns, a widened nullability, and a check swapped for one that
accepts everything the old one did, plus more.

The downgrade drops the added columns and restores ``track_id`` NOT NULL and the original
check (deleting any goal milestone row first: a track milestone needs ``track_id``).

Revision ID: 0104_simple_goal_milestones
Revises: 0103_approved_roadmap_plan
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0104_simple_goal_milestones"
down_revision: str | None = "0103_approved_roadmap_plan"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

T = "track_milestones"
PROGRESS_CHECK = "ck_track_milestones_progress"
DATED_CHECK = "ck_track_milestones_dated_needs_basis"


def upgrade() -> None:
    op.add_column(T, sa.Column("roadmap_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f(f"fk_{T}_roadmap_id_documents"), T, "documents", ["roadmap_id"], ["id"],
        ondelete="SET NULL",
    )  # fmt: skip
    op.create_index(op.f(f"ix_{T}_roadmap_id"), T, ["roadmap_id"])
    op.add_column(T, sa.Column("goal_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f(f"fk_{T}_goal_id_entities"), T, "entities", ["goal_id"], ["id"], ondelete="SET NULL",
    )  # fmt: skip
    op.create_index(op.f(f"ix_{T}_goal_id"), T, ["goal_id"])
    op.add_column(T, sa.Column("code", sa.Text(), nullable=True))
    op.add_column(T, sa.Column("counts_when", sa.Text(), nullable=False, server_default=""))
    op.add_column(T, sa.Column("progress", sa.Text(), nullable=False, server_default="not_started"))
    op.add_column(T, sa.Column("origin_prd_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f(f"fk_{T}_origin_prd_id_documents"), T, "documents", ["origin_prd_id"], ["id"],
        ondelete="SET NULL",
    )  # fmt: skip
    op.create_index(op.f(f"ix_{T}_origin_prd_id"), T, ["origin_prd_id"])
    op.add_column(T, sa.Column("pending_change", postgresql.JSONB(), nullable=True))
    op.add_column(
        T,
        sa.Column("item_ids", postgresql.ARRAY(sa.Uuid()), nullable=False, server_default="{}"),
    )
    op.add_column(T, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.alter_column(T, "track_id", nullable=True)
    op.create_check_constraint(
        op.f(PROGRESS_CHECK),
        T,
        "progress IN ('on_track', 'at_risk', 'not_started', 'met')",
    )
    op.drop_constraint(op.f(DATED_CHECK), T, type_="check")
    op.create_check_constraint(
        op.f(DATED_CHECK),
        T,
        "roadmap_id IS NOT NULL OR target_date IS NULL OR cardinality(basis_ids) > 0",
    )
    op.create_index(
        "uq_track_milestones_goal_code",
        T,
        ["roadmap_id", "goal_id", "code"],
        unique=True,
        postgresql_where=sa.text("roadmap_id IS NOT NULL AND deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_track_milestones_goal_code", table_name=T)
    op.drop_constraint(op.f(DATED_CHECK), T, type_="check")
    op.create_check_constraint(
        op.f(DATED_CHECK), T, "target_date IS NULL OR cardinality(basis_ids) > 0"
    )
    op.execute(f"DELETE FROM {T} WHERE track_id IS NULL")
    op.alter_column(T, "track_id", nullable=False)
    op.drop_constraint(op.f(PROGRESS_CHECK), T, type_="check")
    op.drop_column(T, "deleted_at")
    op.drop_column(T, "item_ids")
    op.drop_column(T, "pending_change")
    op.drop_index(op.f(f"ix_{T}_origin_prd_id"), table_name=T)
    op.drop_constraint(op.f(f"fk_{T}_origin_prd_id_documents"), T, type_="foreignkey")
    op.drop_column(T, "origin_prd_id")
    op.drop_column(T, "progress")
    op.drop_column(T, "counts_when")
    op.drop_column(T, "code")
    op.drop_index(op.f(f"ix_{T}_goal_id"), table_name=T)
    op.drop_constraint(op.f(f"fk_{T}_goal_id_entities"), T, type_="foreignkey")
    op.drop_column(T, "goal_id")
    op.drop_index(op.f(f"ix_{T}_roadmap_id"), table_name=T)
    op.drop_constraint(op.f(f"fk_{T}_roadmap_id_documents"), T, type_="foreignkey")
    op.drop_column(T, "roadmap_id")
