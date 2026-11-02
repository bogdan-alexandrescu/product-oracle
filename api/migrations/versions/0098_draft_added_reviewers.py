"""The people a Simple draft's sender added as reviewers (build-review)

``simple_drafts.added_reviewers``: ``[{"id": user id, "approved_at": iso time | null}]``,
in the order they were named, set by ``POST /v1/simple/drafts/{id}/submit`` with
``reviewer_ids``. The draft waits on each until they approve, after the PRD's own required
reviewers; cleared when the draft returns to working.

Revision ID: 0098_draft_added_reviewers
Revises: 0097_agent_answers
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0098_draft_added_reviewers"
down_revision: str | None = "0097_agent_answers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "simple_drafts",
        sa.Column("added_reviewers", JSONB(), nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("simple_drafts", "added_reviewers")
