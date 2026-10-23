"""G8 Slack bridge: a discussion mirrored to a Slack thread

Additive. ``company_integrations`` (F6) gains ``bot_user_id`` and one active Slack install
per Slack team; three new tables (``discussion_slack_links``, ``slack_outbox``,
``slack_events_seen``); ``discussion_messages`` gains ``slack_ts`` and ``slack_user_id``
(nullable).

Live-safe: the new columns are nullable and the new tables are empty; the wait for a
lock is capped (LOCK_TIMEOUT).

The downgrade drops the three tables, the index and the columns (F6's install row stays).

Revision ID: 0030_slack_bridge
Revises: 0029_discussion_replies
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0030_slack_bridge"
down_revision: str | None = "0029_discussion_replies"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def _tenant(table: str) -> list:
    return [
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name=op.f(f"fk_{table}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]  # fmt: skip


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("company_integrations", sa.Column("bot_user_id", sa.Text(), nullable=True))
    op.create_index(
        "uq_company_integrations_slack_team",
        "company_integrations",
        ["provider", "account_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.add_column("discussion_messages", sa.Column("slack_ts", sa.Text(), nullable=True))
    op.add_column("discussion_messages", sa.Column("slack_user_id", sa.Text(), nullable=True))

    op.create_table(
        "discussion_slack_links",
        sa.Column("discussion_id", sa.Uuid(), nullable=False),
        sa.Column("channel_id", sa.Text(), nullable=False),
        sa.Column("channel_name", sa.Text(), nullable=False),
        sa.Column("thread_ts", sa.Text(), nullable=True),
        sa.Column("linked_by", sa.Uuid(), nullable=False),
        sa.Column("unlinked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("unlinked_by", sa.Uuid(), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        *_tenant("discussion_slack_links"),
        sa.ForeignKeyConstraint(
            ["discussion_id"], ["discussions.id"],
            name=op.f("fk_discussion_slack_links_discussion_id_discussions"), ondelete="CASCADE",
        ),
    )  # fmt: skip
    op.create_index(
        op.f("ix_discussion_slack_links_tenant_id"), "discussion_slack_links", ["tenant_id"]
    )
    op.create_index(
        "uq_discussion_slack_links_live",
        "discussion_slack_links",
        ["discussion_id"],
        unique=True,
        postgresql_where=sa.text("unlinked_at IS NULL"),
    )
    op.create_index(
        "uq_discussion_slack_links_thread",
        "discussion_slack_links",
        ["channel_id", "thread_ts"],
        unique=True,
        postgresql_where=sa.text("unlinked_at IS NULL"),
    )

    op.create_table(
        "slack_outbox",
        sa.Column("link_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("op", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.Text(), server_default="queued", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "next_try_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("slack_ts", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        *_tenant("slack_outbox"),
        sa.CheckConstraint(
            "op IN ('root', 'post', 'update', 'delete', 'close')", name=op.f("ck_slack_outbox_op")
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'sent', 'failed', 'dropped')", name=op.f("ck_slack_outbox_status")
        ),
        sa.ForeignKeyConstraint(
            ["link_id"], ["discussion_slack_links.id"],
            name=op.f("fk_slack_outbox_link_id_discussion_slack_links"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["message_id"], ["discussion_messages.id"],
            name=op.f("fk_slack_outbox_message_id_discussion_messages"), ondelete="SET NULL",
        ),
    )  # fmt: skip
    op.create_index(op.f("ix_slack_outbox_tenant_id"), "slack_outbox", ["tenant_id"])
    op.create_index("ix_slack_outbox_due", "slack_outbox", ["status", "next_try_at"])

    op.create_table(
        "slack_events_seen",
        sa.Column("event_id", sa.Text(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "received_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name=op.f("fk_slack_events_seen_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("event_id", name=op.f("pk_slack_events_seen")),
    )  # fmt: skip


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_table("slack_events_seen")
    op.drop_index("ix_slack_outbox_due", table_name="slack_outbox")
    op.drop_index(op.f("ix_slack_outbox_tenant_id"), table_name="slack_outbox")
    op.drop_table("slack_outbox")
    op.drop_index("uq_discussion_slack_links_thread", table_name="discussion_slack_links")
    op.drop_index("uq_discussion_slack_links_live", table_name="discussion_slack_links")
    op.drop_index(op.f("ix_discussion_slack_links_tenant_id"), table_name="discussion_slack_links")
    op.drop_table("discussion_slack_links")
    op.drop_column("discussion_messages", "slack_user_id")
    op.drop_column("discussion_messages", "slack_ts")
    op.drop_index("uq_company_integrations_slack_team", table_name="company_integrations")
    op.drop_column("company_integrations", "bot_user_id")
