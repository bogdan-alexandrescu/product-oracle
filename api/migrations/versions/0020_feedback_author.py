"""Feedback items keep who raised them (D13 General feedback)

Additive. ``feedback_items`` gains ``author_id`` (nullable, no foreign key: a user id or
an API token id, as on ``comments.author_id``). A whole-draft ("general") item has no
comment or verdict to carry its author, so the item carries it; new comment and verdict
items fill it too. Existing items are filled from their comment's author or their
verdict's reviewer; those with neither stay null.

Live-safe: the nullable column is a catalog-only change; the backfill touches only items
that have a comment or a verdict.

The downgrade drops the column: the comment and verdict items keep their author on the
comment and the verdict.

Revision ID: 0020_feedback_author
Revises: 0014_member_follow_up_retry
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020_feedback_author"
down_revision: str | None = "0014_member_follow_up_retry"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("feedback_items", sa.Column("author_id", sa.Uuid(), nullable=True))
    op.execute(
        "UPDATE feedback_items f SET author_id = c.author_id FROM comments c "
        "WHERE f.comment_id = c.id AND f.author_id IS NULL"
    )
    op.execute(
        "UPDATE feedback_items f SET author_id = r.reviewer_id FROM section_reviews r "
        "WHERE f.section_review_id = r.id AND f.author_id IS NULL"
    )


def downgrade() -> None:
    op.drop_column("feedback_items", "author_id")
