"""F6 Weekly alignment report: stored reports, who read them, and the company's Slack install

Adds three tables:

- ``alignment_reports``: one report's content (frozen when built) and Markdown, the week
  and period it covers in the company's time zone, and its Slack post (status, channel,
  Slack's ``ts``, attempts, the next attempt, the error). A partial unique index allows one
  weekly report per company and week, so a second build is impossible;
- ``alignment_report_reads``: who opened which report (the Inbox's Done, per person);
- ``company_integrations``: Oracle's Slack app, installed once per company by an owner
  ("Slack poster", decided 2026-10-20); the bot token is encrypted (oracle.crypto).

Additive: new tables only, no lock on an existing one. The downgrade drops the three
tables; it refuses while a Slack install is stored, because dropping it would keep the
bot token valid at Slack: Disconnect it in Settings > Notifications first (that revokes
it at Slack), then downgrade.

Revision ID: 0020_alignment_reports
Revises: 0014_member_follow_up_retry
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020_alignment_reports"
down_revision: str | None = "0015_specs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "alignment_reports",
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("week_start", sa.Date(), nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("timezone", sa.Text(), nullable=False),
        sa.Column("content", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("markdown", sa.Text(), nullable=False),
        sa.Column("generated_by", sa.Uuid(), nullable=True),
        sa.Column("slack_status", sa.Text(), nullable=False),
        sa.Column("slack_channel_id", sa.Text(), nullable=True),
        sa.Column("slack_channel_name", sa.Text(), nullable=True),
        sa.Column("slack_ts", sa.Text(), nullable=True),
        sa.Column("slack_error", sa.Text(), nullable=True),
        sa.Column("slack_attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("slack_next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("slack_posted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("slack_dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('weekly', 'on_demand')", name=op.f("ck_alignment_reports_kind")
        ),
        sa.CheckConstraint(
            "slack_status IN ('not_configured', 'not_requested', 'pending', 'posted', 'failed')",
            name=op.f("ck_alignment_reports_slack_status"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_alignment_reports_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alignment_reports")),
    )
    op.create_index(
        op.f("ix_alignment_reports_tenant_id"), "alignment_reports", ["tenant_id"], unique=False
    )
    op.create_index(
        "ux_alignment_reports_week",
        "alignment_reports",
        ["tenant_id", "week_start"],
        unique=True,
        postgresql_where=sa.text("kind = 'weekly'"),
    )
    op.create_table(
        "company_integrations",
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("account_id", sa.Text(), nullable=False),
        sa.Column("account_label", sa.Text(), nullable=True),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("scopes", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("installed_by", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("provider IN ('slack')", name=op.f("ck_company_integrations_provider")),
        sa.CheckConstraint(
            "purpose IN ('notifications')", name=op.f("ck_company_integrations_purpose")
        ),
        sa.CheckConstraint(
            "status IN ('active', 'revoked', 'error')", name=op.f("ck_company_integrations_status")
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_company_integrations_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_company_integrations")),
        sa.UniqueConstraint(
            "tenant_id",
            "provider",
            "purpose",
            name=op.f("uq_company_integrations_tenant_id_provider_purpose"),
        ),
    )
    op.create_index(
        op.f("ix_company_integrations_tenant_id"),
        "company_integrations",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "alignment_report_reads",
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "read_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["alignment_reports.id"],
            name=op.f("fk_alignment_report_reads_report_id_alignment_reports"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_alignment_report_reads_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_alignment_report_reads_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alignment_report_reads")),
        sa.UniqueConstraint(
            "report_id", "user_id", name=op.f("uq_alignment_report_reads_report_id_user_id")
        ),
    )
    op.create_index(
        op.f("ix_alignment_report_reads_tenant_id"),
        "alignment_report_reads",
        ["tenant_id"],
        unique=False,
    )


def downgrade() -> None:
    installs = op.get_bind().scalar(sa.text("SELECT count(*) FROM company_integrations"))
    if installs:
        raise RuntimeError(
            f"{installs} company Slack install(s) stored: disconnect Slack in Settings > "
            "Notifications first (that revokes the bot token at Slack), then downgrade"
        )
    op.drop_index(op.f("ix_alignment_report_reads_tenant_id"), table_name="alignment_report_reads")
    op.drop_table("alignment_report_reads")
    op.drop_index(op.f("ix_company_integrations_tenant_id"), table_name="company_integrations")
    op.drop_table("company_integrations")
    op.drop_index(
        "ux_alignment_reports_week",
        table_name="alignment_reports",
        postgresql_where=sa.text("kind = 'weekly'"),
    )
    op.drop_index(op.f("ix_alignment_reports_tenant_id"), table_name="alignment_reports")
    op.drop_table("alignment_reports")
