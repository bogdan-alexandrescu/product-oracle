"""API tokens can act for a user

``api_tokens.user_id`` (nullable): a token with a user acts as that user (the user's
role, and the user's own connections and sources), so ``oracle sync`` and the other
per-user calls work with ``ORACLE_API_TOKEN``. Tokens without a user act with their own
role, as before. Deleting the user deletes their tokens.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-17 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("api_tokens", sa.Column("user_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_api_tokens_user_id_users"),
        "api_tokens",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(op.f("ix_api_tokens_user_id"), "api_tokens", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_api_tokens_user_id"), table_name="api_tokens")
    op.drop_constraint(op.f("fk_api_tokens_user_id_users"), "api_tokens", type_="foreignkey")
    op.drop_column("api_tokens", "user_id")
