"""A roadmap item's picked quarter (roadmap-dates, QA Nov 14)

``roadmap_items.picked_quarter``: the first day of the quarter Quick Add put the item in
(null: added to a column or a goal, or imported). An undated item is estimated inside it
until Oracle suggests dates (oracle.simple.dates.resolve_by_dates).

Revision ID: 0132_roadmap_picked_quarter
Revises: 0131_trash_outcomes
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0132_roadmap_picked_quarter"
down_revision: str | None = "0131_trash_outcomes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("roadmap_items", sa.Column("picked_quarter", sa.Date(), nullable=True))


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_column("roadmap_items", "picked_quarter")
