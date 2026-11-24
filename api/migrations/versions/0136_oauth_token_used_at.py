"""When an MCP client's access token was last used on /mcp (#1553, Nov 23)

- ``oauth_tokens.used_at``: set when the row's access token is used, at most once a
  minute, so My account can say when each connected client was last used.

The downgrade drops the column.

Revision ID: 0136_oauth_token_used_at
Revises: 0135_feature_comments
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0136_oauth_token_used_at"
down_revision: str | None = "0135_feature_comments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("oauth_tokens", sa.Column("used_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_column("oauth_tokens", "used_at")
