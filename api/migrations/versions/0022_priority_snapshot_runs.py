"""Priority order snapshots of a run (C8 Priority order snapshot)

The priority segment's ``priority.yaml`` becomes a ``proposed`` snapshot of the run, its
checkpoint, its PRD (once the draft imports) and the approved PRD scope; approving the
priority stop saves it for that PRD, Request changes discards it, and a re-run's proposal
discards the earlier one. Existing rows become ``saved``: people saved them, with no run.
Readers (the snapshot list, the roadmap's priority order) see saved snapshots only.

``scope_id`` links to ``prd_scopes`` (C6 merged first: ``ON DELETE SET NULL``).

Downgrade deletes proposed and discarded rows, then drops the columns: saved run snapshots
stay as plain snapshots.

Revision ID: 0022_priority_snapshot_runs
Revises: 0022_discussions
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022_priority_snapshot_runs"
down_revision: str | None = "0022_discussions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "priority_snapshots"
# The name 0020_prd_scopes gives this link when it runs after this migration.
SCOPE_FK = "fk_priority_snapshots_scope_id_prd_scopes"
LINKS = (
    ("run_id", "runs"),
    ("checkpoint_id", "checkpoints"),
    ("document_id", "documents"),
)


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("status", sa.Text(), server_default="saved", nullable=False))
    op.create_check_constraint(
        op.f("ck_priority_snapshots_status"),
        TABLE,
        "status IN ('saved', 'proposed', 'discarded')",
    )
    for column, target in LINKS:
        op.add_column(TABLE, sa.Column(column, sa.Uuid(), nullable=True))
        op.create_foreign_key(
            op.f(f"fk_priority_snapshots_{column}_{target}"),
            TABLE,
            target,
            [column],
            ["id"],
            ondelete="SET NULL",
        )
    op.add_column(TABLE, sa.Column("scope_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(SCOPE_FK, TABLE, "prd_scopes", ["scope_id"], ["id"], ondelete="SET NULL")
    op.add_column(
        TABLE,
        sa.Column(
            "check_result",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
    )
    op.add_column(TABLE, sa.Column("decided_by", sa.Uuid(), nullable=True))
    op.add_column(TABLE, sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        "ix_priority_snapshots_document",
        TABLE,
        ["document_id", "status", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM priority_snapshots WHERE status IN ('proposed', 'discarded')"))
    op.drop_index("ix_priority_snapshots_document", table_name=TABLE)
    op.drop_column(TABLE, "decided_at")
    op.drop_column(TABLE, "decided_by")
    op.drop_column(TABLE, "check_result")
    op.drop_constraint(SCOPE_FK, TABLE, type_="foreignkey")
    op.drop_column(TABLE, "scope_id")
    for column, target in reversed(LINKS):
        op.drop_constraint(
            op.f(f"fk_priority_snapshots_{column}_{target}"), TABLE, type_="foreignkey"
        )
        op.drop_column(TABLE, column)
    op.drop_constraint(op.f("ck_priority_snapshots_status"), TABLE, type_="check")
    op.drop_column(TABLE, "status")
