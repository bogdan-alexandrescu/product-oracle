"""A PRD's place in the company PRD order (prd-order)

Additive. ``documents`` gains ``position``, nullable (1 = first): an owner's Move up / Move
down on the One-pagers list stores it. A PRD without one follows those with one, in the
order of the goal it mainly serves, then by title (oracle.docs.prd_order).

Live-safe: adding a nullable column takes a short lock; the wait for it is capped
(LOCK_TIMEOUT).

The downgrade drops the column (every PRD falls back to the default order).

Revision ID: 0118_document_position
Revises: 0117_removed_tracks
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0118_document_position"
down_revision: str | None = "0117_removed_tracks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("documents", sa.Column("position", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("documents", "position")
