"""feedback-discussion: a General item made from a Discuss thread keeps its thread.

``feedback_items.discussion_id`` (one item per thread): the thread's first message is the
item's summary, so editing it updates the item, and deleting it or making the thread
private withdraws the item; resolving the item closes the thread.

Revision ID: 0092_feedback_discussion
Revises: 0092_bet_flow_line_key
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0092_feedback_discussion"
down_revision: str | None = "0092_bet_flow_line_key"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("feedback_items", sa.Column("discussion_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_feedback_items_discussion_id_discussions",
        "feedback_items",
        "discussions",
        ["discussion_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_unique_constraint(
        "uq_feedback_items_discussion_id", "feedback_items", ["discussion_id"]
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_constraint("uq_feedback_items_discussion_id", "feedback_items", type_="unique")
    op.drop_constraint(
        "fk_feedback_items_discussion_id_discussions", "feedback_items", type_="foreignkey"
    )
    op.drop_column("feedback_items", "discussion_id")
