"""G3 + H1 (#187, #193): a discussion change of kind ``decision``

``discussion_changes.kind`` gains ``decision``: a discussion proposes a decision, which lands
as a proposed decision in the log. The kind CHECK is replaced by one that also allows it.

Live-safe: the new check only widens the old one; it is added NOT VALID and validated in
the same transaction (every existing row already passes), under a short lock timeout.

The downgrade deletes the ``decision`` changes and restores the old check.

Revision ID: 0055_discussion_decision_change
Revises: 0054_reply_opened
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0055_discussion_decision_change"
down_revision: str | None = "0054_reply_opened"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
TABLE = "discussion_changes"
NAME = f"ck_{TABLE}_kind"
OLD = (
    "section_edit", "goal_measure", "entity_edit", "conflict_pick", "answer", "ask_person",
    "basis_record", "item_horizon", "item_outcome", "item_drop", "item_dependency",
    "item_date_remove", "item_split", "item_merge", "scope_feature", "scope_requirement",
    "priority_move", "priority_pin",
)  # fmt: skip
NEW = (*OLD, "decision")


def _in(values: Sequence[str]) -> str:
    return "kind IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def _replace(values: Sequence[str]) -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute(f"ALTER TABLE {TABLE} DROP CONSTRAINT {NAME}")
    op.execute(f"ALTER TABLE {TABLE} ADD CONSTRAINT {NAME} CHECK ({_in(values)}) NOT VALID")
    op.execute(f"ALTER TABLE {TABLE} VALIDATE CONSTRAINT {NAME}")


def upgrade() -> None:
    _replace(NEW)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute(f"DELETE FROM {TABLE} WHERE kind = 'decision'")
    _replace(OLD)
