"""Per-item read failures on a source (Google Drive picker, drive.file)

``sources.unavailable_items``: the allowlisted items the last completed sync could not
read, ``[{"external_id": ..., "reason": ...}]``. A Google Doc that was unshared or whose
access was removed is reported here, per item, instead of failing the whole source.

Revision ID: 0016_source_unavailable_items
Revises: 0014_blockers_snapshot
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0016_source_unavailable_items"
down_revision: str | None = "0014_blockers_snapshot"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sources",
        sa.Column(
            "unavailable_items",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
    )


def downgrade() -> None:
    op.drop_column("sources", "unavailable_items")
