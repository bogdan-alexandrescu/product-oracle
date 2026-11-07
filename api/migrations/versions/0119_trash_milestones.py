"""Goal milestones in Trash (goal-map-editing)

``trash_entries.root_type`` takes "milestone" too: a goal milestone deleted in Simple goes
to Settings > Trash (``track_milestones.deleted_at`` already marks it). The downgrade deletes
milestone entries left in Trash (their milestones stay deleted) and puts the check back.

Revision ID: 0119_trash_milestones
Revises: 0118_document_position
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0119_trash_milestones"
down_revision: str | None = "0118_document_position"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHECK = "ck_trash_entries_root_type"
# The types 0117_removed_tracks left the check with.
OLD = (
    "'document', 'intake', 'run', 'feature', 'goal', 'decision', 'question', 'agenda_item', "
    "'request', 'track'"
)


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(f"ALTER TABLE trash_entries DROP CONSTRAINT IF EXISTS {CHECK}")
    op.execute(
        f"ALTER TABLE trash_entries ADD CONSTRAINT {CHECK} CHECK "
        f"(root_type IN ({OLD}, 'milestone')) NOT VALID"
    )
    op.execute(f"ALTER TABLE trash_entries VALIDATE CONSTRAINT {CHECK}")


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("DELETE FROM trash_entries WHERE root_type = 'milestone'")
    op.execute(f"ALTER TABLE trash_entries DROP CONSTRAINT IF EXISTS {CHECK}")
    op.execute(f"ALTER TABLE trash_entries ADD CONSTRAINT {CHECK} CHECK (root_type IN ({OLD}))")
