"""Feedback items an approver staged for the agents (D12 One Build next draft)

Additive. ``feedback_items`` gains ``staged_for_agents_at`` and ``staged_for_agents_by``
(nullable; the second a user id or an API token id, no foreign key, as on
``feedback_items.author_id``). An open item with ``staged_for_agents_at`` set is Staged:
the next draft goes to the agents with it. A draft's resolutions that close the item
clear both.

Live-safe: two nullable columns are a catalog-only change; nothing is backfilled.

The downgrade drops both columns: items staged for the agents return to Open.

Revision ID: 0021_feedback_agent_staging
Revises: 0020_prd_scopes
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021_feedback_agent_staging"
down_revision: str | None = "0020_prd_scopes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "feedback_items",
        sa.Column("staged_for_agents_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("feedback_items", sa.Column("staged_for_agents_by", sa.Uuid(), nullable=True))


def downgrade() -> None:
    op.drop_column("feedback_items", "staged_for_agents_by")
    op.drop_column("feedback_items", "staged_for_agents_at")
