"""Who removed what and when, and tracks in Trash (removed-tracks)

- ``entities.archived_at`` / ``archived_by``: when a goal was archived in Simple and by
  whom (cleared when it comes back).
- ``track_milestones.deleted_by``: who removed a goal milestone (``deleted_at`` is when).
- ``product_tracks``: the Trash columns (``deleted_at``, ``deleted_by``,
  ``deleted_reason``, ``trash_entry_id``) and its trashed index; ``trash_entries.root_type``
  takes "track".

The downgrade drops them and puts the root type check back (a track entry left in Trash
must be restored or purged first).

Revision ID: 0110_removed_tracks
Revises: 0109_audit_import_index
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.sql.elements import conv

revision: str = "0110_removed_tracks"
down_revision: str | None = "0109_audit_import_index"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "product_tracks"
# A name taken as given (no naming convention), as op.f() does.
OLD_CHECK = conv("ck_trash_entries_ck_trash_entries_root_type")


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("entities", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("entities", sa.Column("archived_by", sa.Uuid(), nullable=True))
    op.add_column("track_milestones", sa.Column("deleted_by", sa.Uuid(), nullable=True))
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
    # 0046 named it ck_trash_entries_ck_trash_entries_root_type (the naming convention
    # prefixed its full name); the new one carries the name the model gives it.
    op.drop_constraint(OLD_CHECK, "trash_entries", type_="check")
    op.create_check_constraint(
        op.f("ck_trash_entries_root_type"),
        "trash_entries",
        "root_type IN ('document', 'intake', 'run', 'track')",
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_constraint(op.f("ck_trash_entries_root_type"), "trash_entries", type_="check")
    op.create_check_constraint(
        OLD_CHECK, "trash_entries", "root_type IN ('document', 'intake', 'run')"
    )
    op.drop_index(f"ix_{TABLE}_trashed", table_name=TABLE)
    op.drop_constraint(f"fk_{TABLE}_trash_entry_id_trash_entries", TABLE, type_="foreignkey")
    for name in ("trash_entry_id", "deleted_reason", "deleted_by", "deleted_at"):
        op.drop_column(TABLE, name)
    op.drop_column("track_milestones", "deleted_by")
    op.drop_column("entities", "archived_by")
    op.drop_column("entities", "archived_at")
