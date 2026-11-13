"""Outcomes in Trash (outcomes-edit, owner Nov 13: everything can be deleted in the UI)

``outcome_records`` takes the Trash columns (oracle.trash.models.Trashable) and
``trash_entries.root_type`` takes "outcome": an outcome moved to Trash from Plan › Outcomes
leaves every read and count, and Settings › Trash restores it. The downgrade deletes outcome
entries left in Trash with their rows, then drops the columns and puts the check back.

Revision ID: 0131_trash_outcomes
Revises: 0130_simple_change_indexes
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0131_trash_outcomes"
down_revision: str | None = "0130_simple_change_indexes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
TABLE = "outcome_records"
CHECK = "ck_trash_entries_root_type"
# The types 0127_trash_tasks left the check with.
OLD = (
    "'document', 'intake', 'run', 'feature', 'goal', 'decision', 'question', 'agenda_item', "
    "'request', 'track', 'milestone', 'task'"
)


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
        f"(root_type IN ({OLD}, 'outcome')) NOT VALID"
    )
    op.execute(f"ALTER TABLE trash_entries VALIDATE CONSTRAINT {CHECK}")


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute(f"DELETE FROM {TABLE} WHERE deleted_at IS NOT NULL")
    op.execute("DELETE FROM trash_entries WHERE root_type = 'outcome'")
    op.execute(f"ALTER TABLE trash_entries DROP CONSTRAINT IF EXISTS {CHECK}")
    op.execute(f"ALTER TABLE trash_entries ADD CONSTRAINT {CHECK} CHECK (root_type IN ({OLD}))")
    op.drop_index(f"ix_{TABLE}_trashed", table_name=TABLE)
    op.drop_constraint(f"fk_{TABLE}_trash_entry_id_trash_entries", TABLE, type_="foreignkey")
    for column in ("trash_entry_id", "deleted_reason", "deleted_by", "deleted_at"):
        op.drop_column(TABLE, column)
