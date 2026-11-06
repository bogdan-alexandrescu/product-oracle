"""A feature made part of another (feature-parts)

Additive. ``roadmap_items`` gains ``parent_key``, nullable: the key of the item (of the same
roadmap) the feature is part of (any depth, never a loop), set by Simple's ``set_parent`` change
(oracle.simple.changes). Every existing row stays a feature of its own and an old image
keeps writing.

Live-safe: adding a nullable column takes a short lock; the wait for it is capped
(LOCK_TIMEOUT). The downgrade drops the column (every part is a feature of its own again).

Revision ID: 0120_feature_parts
Revises: 0119_trash_milestones
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0120_feature_parts"
down_revision: str | None = "0119_trash_milestones"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("roadmap_items", sa.Column("parent_key", sa.Text(), nullable=True))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("roadmap_items", "parent_key")
