"""Live Ask lane 1 (#710): live reads of a person's own Fireflies connection

``live_reads``: one row per live tool call (the tool, the connection's label at read
time, the item id, the status, the time; no source text, no query text, no key).
``browse_calls.kind``: live calls are counted in the picker's budget table as ``live``;
every existing row is a picker's (``browse``, the default). ``live_tokens`` is lane 2's.

Live-safe: one new table and a column with a constant default.

The downgrade drops the table and the column.

Revision ID: 0074_live_reads
Revises: 0073_share_links
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0074_live_reads"
down_revision: str | None = "0073_share_links"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "browse_calls",
        sa.Column("kind", sa.Text(), server_default="browse", nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_browse_calls_kind"), "browse_calls", "kind IN ('browse', 'live')"
    )
    op.create_table(
        "live_reads",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("connection_id", sa.Uuid(), nullable=True),
        sa.Column("tool", sa.Text(), nullable=False),
        sa.Column("source_label", sa.Text(), nullable=False),
        sa.Column("ref_n", sa.Integer(), nullable=True),
        sa.Column("item_id", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "read_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('ok', 'cached', 'error')", name=op.f("ck_live_reads_status")
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_live_reads_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["discussion_messages.id"],
            name=op.f("fk_live_reads_message_id_discussion_messages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["connection_id"],
            ["connections.id"],
            name=op.f("fk_live_reads_connection_id_connections"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_live_reads")),
    )
    op.create_index(op.f("ix_live_reads_tenant_id"), "live_reads", ["tenant_id"])
    op.create_index(op.f("ix_live_reads_message_id"), "live_reads", ["message_id"])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_table("live_reads")
    op.drop_constraint(op.f("ck_browse_calls_kind"), "browse_calls", type_="check")
    op.drop_column("browse_calls", "kind")
