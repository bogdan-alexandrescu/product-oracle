"""A chat card made as a redo of an earlier draft (chat-latest-card fix round 2, owner Nov 5)

``simple_chat_cards.redo_of``: the earlier open draft this card offers again because the
person asked to change it ("make it April instead", "no, ..."), as the card's builder
decided; it takes that draft's topic and so replaces it. Null: the card is its own topic
(a new record) or its record's. The downgrade drops it.

Revision ID: 0115_chat_card_redo_of
Revises: 0114_audit_import_index
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0115_chat_card_redo_of"
down_revision: str | None = "0114_audit_import_index"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column(
        "simple_chat_cards",
        sa.Column(
            "redo_of",
            sa.Uuid(),
            sa.ForeignKey("simple_chat_cards.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("simple_chat_cards", "redo_of")
