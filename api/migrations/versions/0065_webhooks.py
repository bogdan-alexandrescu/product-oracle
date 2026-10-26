"""I1 Outbound webhooks, lane 1: webhooks, their events and deliveries

``webhooks`` (one row per address a company's tool listens at, with its event types and
its signing secret encrypted by ``oracle.crypto``), ``webhook_events`` (captured in the
transaction of the change, ids only) and ``webhook_deliveries`` (filled by the delivery
lane). Two Inbox row kinds join ``notifications.kind``: ``webhook_paused`` (an owner, or
a member change, paused someone's webhook) and ``webhook_url_changed`` (owners hear when an
approver changes where a webhook sends).

Live-safe: three new tables and a wider check constraint (validated against rows that
all pass); nothing else is rewritten.

The downgrade drops the tables (every webhook, event and delivery with them, secrets
included) and the two Inbox row kinds' rows, then narrows the constraint back.

Revision ID: 0065_webhooks
Revises: 0064_feedback_withheld
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0065_webhooks"
down_revision: str | None = "0064_feedback_withheld"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KINDS = (
    "comment",
    "reply",
    "assignment",
    "rereview_requested",
    "campaign",
    "patch_proposed",
    "published",
)
NEW_KINDS = ("webhook_paused", "webhook_url_changed")


def _kinds(kinds: tuple[str, ...]) -> None:
    op.drop_constraint(op.f("ck_notifications_kind"), "notifications", type_="check")
    listed = ", ".join(f"'{k}'" for k in kinds)
    op.create_check_constraint(
        op.f("ck_notifications_kind"), "notifications", f"kind IN ({listed})"
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        "webhook_events",
        sa.Column("public_id", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("subject", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("approvers_only", sa.Boolean(), nullable=False),
        sa.Column("fanned_out_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_webhook_events_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_webhook_events")),
        sa.UniqueConstraint("public_id", name=op.f("uq_webhook_events_public_id")),
    )
    op.create_index(
        "ix_webhook_events_new",
        "webhook_events",
        ["tenant_id", "occurred_at"],
        unique=False,
        postgresql_where=sa.text("fanned_out_at IS NULL"),
    )
    op.create_index(
        op.f("ix_webhook_events_tenant_id"), "webhook_events", ["tenant_id"], unique=False
    )
    op.create_table(
        "webhooks",
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("host", sa.Text(), nullable=False),
        sa.Column("event_types", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("api_version", sa.Text(), nullable=False),
        sa.Column(
            "include_approvers_content", sa.Boolean(), server_default="false", nullable=False
        ),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("paused_reason", sa.Text(), nullable=True),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("secret_hint", sa.Text(), nullable=False),
        sa.Column("previous_ciphertext", sa.LargeBinary(), nullable=True),
        sa.Column("previous_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "secret_rotated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "paused_reason IN ('manual', 'failing', 'gone', 'creator_disabled', 'creator_demoted')",
            name=op.f("ck_webhooks_paused_reason"),
        ),
        sa.CheckConstraint("status IN ('active', 'paused')", name=op.f("ck_webhooks_status")),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 80", name=op.f("ck_webhooks_name")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_webhooks_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_webhooks")),
    )
    op.create_index(
        "ix_webhooks_active",
        "webhooks",
        ["tenant_id"],
        unique=False,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_index(op.f("ix_webhooks_tenant_id"), "webhooks", ["tenant_id"], unique=False)
    op.create_table(
        "webhook_deliveries",
        sa.Column("webhook_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("next_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("response_excerpt", sa.Text(), nullable=True),
        sa.Column("body", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("redelivery_of", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'retrying', 'succeeded', 'failed', 'withheld')",
            name=op.f("ck_webhook_deliveries_status"),
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["webhook_events.id"],
            name=op.f("fk_webhook_deliveries_event_id_webhook_events"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["redelivery_of"],
            ["webhook_deliveries.id"],
            name=op.f("fk_webhook_deliveries_redelivery_of_webhook_deliveries"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_webhook_deliveries_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["webhook_id"],
            ["webhooks.id"],
            name=op.f("fk_webhook_deliveries_webhook_id_webhooks"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_webhook_deliveries")),
    )
    op.create_index(
        "ix_webhook_deliveries_due",
        "webhook_deliveries",
        ["tenant_id", "next_at"],
        unique=False,
        postgresql_where=sa.text("status IN ('pending', 'retrying')"),
    )
    op.create_index(
        op.f("ix_webhook_deliveries_event_id"), "webhook_deliveries", ["event_id"], unique=False
    )
    op.create_index(
        "ix_webhook_deliveries_log",
        "webhook_deliveries",
        ["webhook_id", sa.literal_column("last_at DESC")],
        unique=False,
    )
    op.create_index(
        op.f("ix_webhook_deliveries_tenant_id"), "webhook_deliveries", ["tenant_id"], unique=False
    )
    _kinds(KINDS + NEW_KINDS)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    listed = ", ".join(f"'{k}'" for k in NEW_KINDS)
    op.execute(f"DELETE FROM notifications WHERE kind IN ({listed})")
    _kinds(KINDS)
    op.drop_index(op.f("ix_webhook_deliveries_tenant_id"), table_name="webhook_deliveries")
    op.drop_index("ix_webhook_deliveries_log", table_name="webhook_deliveries")
    op.drop_index(op.f("ix_webhook_deliveries_event_id"), table_name="webhook_deliveries")
    op.drop_index(
        "ix_webhook_deliveries_due",
        table_name="webhook_deliveries",
        postgresql_where=sa.text("status IN ('pending', 'retrying')"),
    )
    op.drop_table("webhook_deliveries")
    op.drop_index(op.f("ix_webhooks_tenant_id"), table_name="webhooks")
    op.drop_index(
        "ix_webhooks_active", table_name="webhooks", postgresql_where=sa.text("status = 'active'")
    )
    op.drop_table("webhooks")
    op.drop_index(op.f("ix_webhook_events_tenant_id"), table_name="webhook_events")
    op.drop_index(
        "ix_webhook_events_new",
        table_name="webhook_events",
        postgresql_where=sa.text("fanned_out_at IS NULL"),
    )
    op.drop_table("webhook_events")
