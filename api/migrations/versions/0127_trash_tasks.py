"""Dropped item tasks in Trash (feature-panel, owner Nov 10)

``trash_entries.root_type`` takes "task" too: a roadmap item task dropped in Simple goes to
Settings > Trash, where it is restored from (``roadmap_item_tasks.status`` "dropped" already
keeps it off the item). The downgrade deletes task entries left in Trash (their tasks stay
dropped) and puts the check back.

Revision ID: 0127_trash_tasks
Revises: 0126_milestone_track
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0127_trash_tasks"
down_revision: str | None = "0126_milestone_track"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHECK = "ck_trash_entries_root_type"
# The types 0119_trash_milestones left the check with.
OLD = (
    "'document', 'intake', 'run', 'feature', 'goal', 'decision', 'question', 'agenda_item', "
    "'request', 'track', 'milestone'"
)


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(f"ALTER TABLE trash_entries DROP CONSTRAINT IF EXISTS {CHECK}")
    op.execute(
        f"ALTER TABLE trash_entries ADD CONSTRAINT {CHECK} CHECK "
        f"(root_type IN ({OLD}, 'task')) NOT VALID"
    )
    op.execute(f"ALTER TABLE trash_entries VALIDATE CONSTRAINT {CHECK}")


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("DELETE FROM trash_entries WHERE root_type = 'task'")
    op.execute(f"ALTER TABLE trash_entries DROP CONSTRAINT IF EXISTS {CHECK}")
    op.execute(f"ALTER TABLE trash_entries ADD CONSTRAINT {CHECK} CHECK (root_type IN ({OLD}))")
