"""The order Simple's changes were written in (build-feature-panel review 3)

``simple_changes.seq``: a number that grows with each row written, so two changes with one
``at`` (a frozen clock, a batch sharing one now) are read back in the order they were
written, not by their random ids. Rows from before get theirs in table order. The
downgrade drops it.

Revision ID: 0104_simple_change_seq
Revises: 0103_approved_roadmap_plan
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0104_simple_change_seq"
down_revision: str | None = "0103_approved_roadmap_plan"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column(
        "simple_changes",
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=False), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("simple_changes", "seq")
