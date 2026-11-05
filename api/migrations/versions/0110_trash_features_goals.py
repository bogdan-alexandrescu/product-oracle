"""Trash for roadmap features and goals (trash-features-goals)

Additive. ``roadmap_items`` and ``entities`` (a goal is an entity) gain ``deleted_at``,
``deleted_by``, ``deleted_reason`` and ``trash_entry_id``, all nullable, so every existing
row stays live and an old image keeps writing; a partial index finds the trashed rows the
read filter (oracle.trash.filter) leaves out. ``trash_entries.root_type`` also takes
``feature`` and ``goal``.

Live-safe: adding nullable columns takes a short lock; the wait for it is capped
(LOCK_TIMEOUT). Swapping the check constraint validates it in a second step
(NOT VALID, then VALIDATE), so the table is not locked while it is checked.

The downgrade drops the columns (anything in Trash comes back) and the feature and goal
entries, then restores the old check.

Revision ID: 0110_trash_features_goals
Revises: 0109_audit_import_index
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0110_trash_features_goals"
down_revision: str | None = "0109_audit_import_index"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
TABLES = ("roadmap_items", "entities")
CHECK = "ck_trash_entries_root_type"
# 0046 named it through the naming convention, which prefixed it once more; a database the
# models made carries CHECK. Either is dropped, and CHECK (the models' name) is added.
OLD_CHECKS = ("ck_trash_entries_ck_trash_entries_root_type", CHECK)


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
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
    for name in OLD_CHECKS:
        op.execute(f"ALTER TABLE trash_entries DROP CONSTRAINT IF EXISTS {name}")
    op.execute(
        f"ALTER TABLE trash_entries ADD CONSTRAINT {CHECK} CHECK "
        "(root_type IN ('document', 'intake', 'run', 'feature', 'goal')) NOT VALID"
    )
    op.execute(f"ALTER TABLE trash_entries VALIDATE CONSTRAINT {CHECK}")


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for table in reversed(TABLES):
        op.drop_index(f"ix_{table}_trashed", table_name=table)
        op.drop_constraint(f"fk_{table}_trash_entry_id_trash_entries", table, type_="foreignkey")
        for name in ("trash_entry_id", "deleted_reason", "deleted_by", "deleted_at"):
            op.drop_column(table, name)
    op.execute("DELETE FROM trash_entries WHERE root_type IN ('feature', 'goal')")
    for name in OLD_CHECKS:
        op.execute(f"ALTER TABLE trash_entries DROP CONSTRAINT IF EXISTS {name}")
    op.execute(
        f"ALTER TABLE trash_entries ADD CONSTRAINT {CHECK} CHECK "
        "(root_type IN ('document', 'intake', 'run'))"
    )
