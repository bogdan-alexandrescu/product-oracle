"""C9 Move and pin: approvers' overrides of the priority ranking

New table ``priority_overrides`` (oracle.priorities.models.PriorityOverride): a move
(directly above another feature) or a pin (at a rank) on the live ranking, or on a
proposed run snapshot (``snapshot_id``), with the person's reason, the evidence they
cited, Oracle's pushback, how Oracle's reading of the reason went (``reason_check``:
status and ms, never text) and whether the change was kept after pushback. Rows are never
deleted: removing or replacing one sets ``removed_at`` (and ``replaced_by``). A partial
unique index keeps one active override per feature per ranking.

Additive: a new table only, nothing backfilled. The downgrade drops it; the live ranking
returns to the formula order at once, and snapshots saved with overrides keep their
stored order.

Revision ID: 0022_priority_overrides
Revises: 0022_priority_snapshot_runs
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022_priority_overrides"
down_revision: str | None = "0022_priority_snapshot_runs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LIVE = "00000000-0000-0000-0000-000000000000"


def upgrade() -> None:
    op.create_table(
        "priority_overrides",
        sa.Column("feature_id", sa.Uuid(), nullable=False),
        sa.Column("snapshot_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("above_feature_id", sa.Uuid(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("evidence_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column(
            "pushback", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column(
            "reason_check",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("""'{"status": "skipped"}'::jsonb"""),
            nullable=False,
        ),
        sa.Column(
            "kept_after_pushback", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_by", sa.Uuid(), nullable=True),
        sa.Column("removed_reason", sa.Text(), nullable=True),
        sa.Column("replaced_by", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("kind IN ('move', 'pin')", name=op.f("ck_priority_overrides_kind")),
        sa.CheckConstraint(
            "length(reason) BETWEEN 1 AND 500", name=op.f("ck_priority_overrides_reason")
        ),
        sa.CheckConstraint(
            "(kind = 'move' AND above_feature_id IS NOT NULL AND position IS NULL) OR "
            "(kind = 'pin' AND position IS NOT NULL AND position >= 1 "
            "AND above_feature_id IS NULL)",
            name=op.f("ck_priority_overrides_target"),
        ),
        sa.CheckConstraint(
            "above_feature_id IS NULL OR above_feature_id <> feature_id",
            name=op.f("ck_priority_overrides_not_self"),
        ),
        sa.ForeignKeyConstraint(
            ["above_feature_id"],
            ["entities.id"],
            name=op.f("fk_priority_overrides_above_feature_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["feature_id"],
            ["entities.id"],
            name=op.f("fk_priority_overrides_feature_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["replaced_by"],
            ["priority_overrides.id"],
            name=op.f("fk_priority_overrides_replaced_by_priority_overrides"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["snapshot_id"],
            ["priority_snapshots.id"],
            name=op.f("fk_priority_overrides_snapshot_id_priority_snapshots"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_priority_overrides_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_priority_overrides")),
    )
    op.create_index(
        op.f("ix_priority_overrides_tenant_id"), "priority_overrides", ["tenant_id"], unique=False
    )
    op.execute(
        "CREATE UNIQUE INDEX ux_priority_overrides_active ON priority_overrides "
        f"(tenant_id, feature_id, coalesce(snapshot_id, '{LIVE}'::uuid)) "
        "WHERE removed_at IS NULL"
    )


def downgrade() -> None:
    op.drop_index("ux_priority_overrides_active", table_name="priority_overrides")
    op.drop_index(op.f("ix_priority_overrides_tenant_id"), table_name="priority_overrides")
    op.drop_table("priority_overrides")
