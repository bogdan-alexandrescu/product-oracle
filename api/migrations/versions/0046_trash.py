"""Trash: soft delete of documents, intakes and runs (#482)

Additive. ``trash_entries``: one row per delete (its root, what went with it, who, why,
when it is purged). ``documents``, ``product_intakes`` and ``runs`` gain
``deleted_at``, ``deleted_by``, ``deleted_reason`` and ``trash_entry_id``, all nullable,
so every existing row stays live and an old image keeps writing; a partial index finds
the trashed rows the read filter (oracle.trash.filter) leaves out.

Live-safe: adding nullable columns takes a short lock; the wait for it is capped
(LOCK_TIMEOUT).

The downgrade drops the columns and the table (anything in Trash comes back).

Revision ID: 0046_trash
Revises: 0045_discussion_inbox
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0046_trash"
down_revision: str | None = "0045_discussion_inbox"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"

TABLES = ("documents", "product_intakes", "runs")


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        "trash_entries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("root_type", sa.Text(), nullable=False),
        sa.Column("root_id", sa.Uuid(), nullable=False),
        sa.Column("root", sa.dialects.postgresql.JSONB(), nullable=False),
        sa.Column("items", sa.dialects.postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("deleted_by", sa.Uuid(), nullable=True),
        sa.Column("deleted_by_name", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("published", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("purge_after", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "root_type IN ('document', 'intake', 'run')", name="ck_trash_entries_root_type"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name="fk_trash_entries_tenant_id_tenants",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_trash_entries"),
    )
    op.create_index("ix_trash_entries_tenant_id", "trash_entries", ["tenant_id"])
    op.create_index("ix_trash_entries_purge_after", "trash_entries", ["purge_after"])
    for table in TABLES:
        op.add_column(table, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        op.add_column(table, sa.Column("deleted_by", sa.Uuid(), nullable=True))
        op.add_column(table, sa.Column("deleted_reason", sa.Text(), nullable=True))
        op.add_column(table, sa.Column("trash_entry_id", sa.Uuid(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_trash_entry_id_trash_entries",
            table,
            "trash_entries",
            ["trash_entry_id"],
            ["id"],
            ondelete="SET NULL",
        )
        op.create_index(
            f"ix_{table}_trashed",
            table,
            ["tenant_id", "id"],
            postgresql_where=sa.text("deleted_at IS NOT NULL"),
        )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for table in reversed(TABLES):
        op.drop_index(f"ix_{table}_trashed", table_name=table)
        op.drop_constraint(f"fk_{table}_trash_entry_id_trash_entries", table, type_="foreignkey")
        for name in ("trash_entry_id", "deleted_reason", "deleted_by", "deleted_at"):
            op.drop_column(table, name)
    op.drop_table("trash_entries")
