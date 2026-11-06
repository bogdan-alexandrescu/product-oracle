"""Simple changes keep the order they were made in (qaC-numfix)

``simple_changes`` gains ``seq``, an identity column: lists of a draft's changes (the
one-pager's number fixes and their Undo) break a tie on ``at`` by it, not by the random id.
Existing rows are numbered as they are stored.

Adding an identity column rewrites the table under a short exclusive lock; the wait for it
is capped (LOCK_TIMEOUT). The downgrade drops the column.

Revision ID: 0113_simple_changes_seq
Revises: 0112_trash_features_goals
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0113_simple_changes_seq"
down_revision: str | None = "0112_trash_features_goals"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "simple_changes",
        sa.Column("seq", sa.BigInteger(), sa.Identity(), nullable=False),
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("simple_changes", "seq")
