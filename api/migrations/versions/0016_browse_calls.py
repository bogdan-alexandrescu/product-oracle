"""Browse calls: what browsing a connection for a source picker spent (S5 pickers)

``browse_calls`` counts the provider calls made to browse one connection (the Fireflies
meeting and series lists), so the per-connection budget that protects the person's
provider quota holds across API processes instead of per process.

Revision ID: 0016_browse_calls
Revises: 0016_source_needs_attention
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016_browse_calls"
down_revision: str | None = "0016_source_needs_attention"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "browse_calls",
        sa.Column("connection_id", sa.Uuid(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("calls", sa.Integer(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["connection_id"],
            ["connections.id"],
            name=op.f("fk_browse_calls_connection_id_connections"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_browse_calls_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_browse_calls")),
    )
    op.create_index(
        op.f("ix_browse_calls_connection_id"), "browse_calls", ["connection_id"], unique=False
    )
    op.create_index(op.f("ix_browse_calls_tenant_id"), "browse_calls", ["tenant_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_browse_calls_tenant_id"), table_name="browse_calls")
    op.drop_index(op.f("ix_browse_calls_connection_id"), table_name="browse_calls")
    op.drop_table("browse_calls")
