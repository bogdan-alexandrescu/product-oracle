"""When an owner removed an expired API token (qa4-settings-39)

``api_tokens.removed_at``: set by ``POST /v1/api-tokens/{token_id}/remove``. The row is
kept, hidden from every list, so approvals and decisions made with it keep its name.

Revision ID: 0096_api_token_removed_at
Revises: 0095_chat_read_answered_at
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0096_api_token_removed_at"
down_revision: str | None = "0095_chat_read_answered_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("api_tokens", sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("api_tokens", "removed_at")
