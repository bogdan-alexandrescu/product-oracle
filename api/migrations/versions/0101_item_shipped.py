"""An item already shipped (item-chat-understands, owner Nov 3)

``roadmap_items.shipped``: set when a person marks an item as already shipped from its
talk ("this already runs in our other app"): ``{"note", "on", "by"}``, the note saying
where it runs in their words. A shipped item reads ``done`` (out of planned work, as an
item whose tracker records are all done); Undo clears it.

Revision ID: 0101_item_shipped
Revises: 0100_source_lost_connection
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0101_item_shipped"
down_revision: str | None = "0100_source_lost_connection"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("roadmap_items", sa.Column("shipped", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("roadmap_items", "shipped")
