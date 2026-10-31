"""When Oracle wrote its chat line (oracle.simple.chat.run_reader)

``simple_chat_reads.answered_at``: the time Oracle's reader wrote its line, shown as the
line's time; the line's own ``edited_at`` stays for a person's edits, so no discussion view
labels Oracle's lines "edited". Null: not answered yet (or answered before this column).

Revision ID: 0095_chat_read_answered_at
Revises: 0094_generation_checks
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0095_chat_read_answered_at"
down_revision: str | None = "0094_generation_checks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "simple_chat_reads", sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("simple_chat_reads", "answered_at")
