"""A reversed decision's note on the open drafts that cited it (decisions-reversed-or-trashed)

``simple_drafts.decision_notes``: ``[{"decision_id", "text"}]``, one per decision the
draft cited that its owner reversed since; shown on the draft's next view.

Revision ID: 0102_draft_decision_notes
Revises: 0101_item_shipped
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0102_draft_decision_notes"
down_revision: str | None = "0101_item_shipped"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "simple_drafts",
        sa.Column("decision_notes", JSONB(), nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("simple_drafts", "decision_notes")
