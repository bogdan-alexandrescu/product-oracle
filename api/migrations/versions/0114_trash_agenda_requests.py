"""Trash for meeting agenda items and requests (port-an-decisions)

Additive. ``product_requests`` gains ``deleted_at``, ``deleted_by``, ``deleted_reason`` and
``trash_entry_id``, all nullable, so every existing row stays live and an old image keeps
writing; a partial index finds the trashed rows the read filter (oracle.trash.filter) leaves
out. ``trash_entries.root_type`` also takes ``agenda_item`` (the removed row is kept in the
entry: the agenda is the meeting's JSON) and ``request``.

Live-safe: adding nullable columns takes a short lock; the wait for it is capped
(LOCK_TIMEOUT). The check constraint is swapped NOT VALID, then validated.

The downgrade drops the columns (anything in Trash comes back) and the agenda item and
request entries, then restores the old check.

Revision ID: 0114_trash_agenda_requests
Revises: 0113_trash_decisions
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0114_trash_agenda_requests"
down_revision: str | None = "0113_trash_decisions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
TABLE = "product_requests"
CHECK = "ck_trash_entries_root_type"
OLD = "'document', 'intake', 'run', 'feature', 'goal', 'decision', 'question'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(TABLE, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(TABLE, sa.Column("deleted_by", sa.Uuid(), nullable=True))
    op.add_column(TABLE, sa.Column("deleted_reason", sa.Text(), nullable=True))
    op.add_column(TABLE, sa.Column("trash_entry_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        f"fk_{TABLE}_trash_entry_id_trash_entries",
        TABLE,
        "trash_entries",
        ["trash_entry_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        f"ix_{TABLE}_trashed",
        TABLE,
        ["tenant_id", "id"],
        postgresql_where=sa.text("deleted_at IS NOT NULL"),
    )
    op.execute(f"ALTER TABLE trash_entries DROP CONSTRAINT IF EXISTS {CHECK}")
    op.execute(
        f"ALTER TABLE trash_entries ADD CONSTRAINT {CHECK} CHECK "
        f"(root_type IN ({OLD}, 'agenda_item', 'request')) NOT VALID"
    )
    op.execute(f"ALTER TABLE trash_entries VALIDATE CONSTRAINT {CHECK}")


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_index(f"ix_{TABLE}_trashed", table_name=TABLE)
    op.drop_constraint(f"fk_{TABLE}_trash_entry_id_trash_entries", TABLE, type_="foreignkey")
    for name in ("trash_entry_id", "deleted_reason", "deleted_by", "deleted_at"):
        op.drop_column(TABLE, name)
    op.execute("DELETE FROM trash_entries WHERE root_type IN ('agenda_item', 'request')")
    op.execute(f"ALTER TABLE trash_entries DROP CONSTRAINT IF EXISTS {CHECK}")
    op.execute(f"ALTER TABLE trash_entries ADD CONSTRAINT {CHECK} CHECK (root_type IN ({OLD}))")
