"""H11 Autonomy: what Oracle did on its own account (``oracle_actions``)

Additive: one new table, empty on creation, so nothing existing is locked or scanned. A
row is written by ``oracle.autonomy.acted`` and read by the Inbox's "Oracle did" rows;
``opened_by`` keeps who opened it across reloads. The ``autonomy`` company setting needs
no schema change (``tenant_settings`` holds it).

The downgrade drops the table: the record of what Oracle did on its own goes (the audit
events stay).

Revision ID: 0020_autonomy
Revises: 0014_member_follow_up_retry
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020_autonomy"
down_revision: str | None = "0014_member_follow_up_retry"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "oracle_actions"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("responsibility", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column(
            "subject", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("undo", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("notify_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("opened_by", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("undone_by", sa.Uuid(), nullable=True),
        sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("audit_event_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_oracle_actions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["audit_event_id"],
            ["audit_events.id"],
            name=op.f("fk_oracle_actions_audit_event_id_audit_events"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oracle_actions")),
    )
    op.create_index(op.f("ix_oracle_actions_tenant_id"), TABLE, ["tenant_id"])
    op.create_index("ix_oracle_actions_recent", TABLE, ["tenant_id", sa.text("created_at DESC")])


def downgrade() -> None:
    op.drop_index("ix_oracle_actions_recent", table_name=TABLE)
    op.drop_index(op.f("ix_oracle_actions_tenant_id"), table_name=TABLE)
    op.drop_table(TABLE)
