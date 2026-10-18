"""evidence.added_by: who added a piece of evidence (C2c)

The person who added a public link may remove it; approvers remove any evidence.

Revision ID: 0009
Revises: 0008
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("evidence", sa.Column("added_by", sa.Uuid(), nullable=True))


def downgrade() -> None:
    op.drop_column("evidence", "added_by")
