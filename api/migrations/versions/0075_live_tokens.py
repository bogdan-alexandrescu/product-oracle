"""Live Ask lane 2 (#710): one-reply live tokens

``live_tokens``: an ``olt_`` token per Ask reply that may read the asker's sources live
(sha256 stored, never the raw token), acting as its person with the ``live:sources``
scope only, for 10 minutes at most and revoked when the reply ends.

Live-safe: one new table.

The downgrade drops the table.

Revision ID: 0075_live_tokens
Revises: 0074_live_reads
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0075_live_tokens"
down_revision: str | None = "0074_live_reads"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        "live_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_live_tokens_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_live_tokens_user_id_users"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["discussion_messages.id"],
            name=op.f("fk_live_tokens_message_id_discussion_messages"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_live_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_live_tokens_token_hash")),
    )
    op.create_index(op.f("ix_live_tokens_tenant_id"), "live_tokens", ["tenant_id"])
    op.create_index(op.f("ix_live_tokens_message_id"), "live_tokens", ["message_id"])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_table("live_tokens")
