"""Bring a date in (build-fit-a-date review 2): a resized item waits on a new estimate.

- ``roadmap_items.estimate_pending``: the approved re-plan sliced or split the item, so its
  date on the roadmap's version waits on a new estimate from its owner; the board, the
  Gantt and Priorities say "Estimate pending".
- ``estimate_requested`` joins ``notifications.kind``: the owner's Inbox line asking for it.

Live-safe: a column with a constant default and a wider check constraint.

The downgrade deletes the ``estimate_requested`` notifications and drops the column.

Revision ID: 0110_roadmap_estimate_pending
Revises: 0109_intake_replaces
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0110_roadmap_estimate_pending"
down_revision: str | None = "0109_intake_replaces"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("notifications", "ck_notifications_kind", "kind")


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "roadmap_items",
        sa.Column("estimate_pending", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    add_check_values(*KIND_CHECK, ("estimate_requested",))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM notifications WHERE kind = 'estimate_requested'")
    remove_check_values(*KIND_CHECK, ("estimate_requested",))
    op.drop_column("roadmap_items", "estimate_pending")
