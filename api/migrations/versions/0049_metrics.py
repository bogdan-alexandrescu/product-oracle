"""H5 Metrics review

Adds three tables:

- ``metrics``: the company's weekly metrics (output or input, unit, good direction,
  owner, source ``posthog``/``manual``/``api``, definition versions, pull state);
- ``metric_values``: one value per metric per week (a Monday), with the definition
  version it was read under;
- ``metric_variances``: a week outside the normal range, its possible causes and its
  explanation.

``goal_measurements`` gains ``metric_id`` (a weekly value read from a linked metric).
``company_integrations`` gains ``config`` (PostHog's host and project id), and its
provider and purpose checks gain ``posthog`` and ``metrics``, extended from what the
database holds (oracle.migration_checks). The runs' flow check gains ``metrics_variance``
(the weekly metrics review's explanation run, lane 2). The Slack team index becomes
Slack's only: two companies may read the same PostHog project.

Live-safe: new tables, a nullable column and one with a constant default; the wait for
the short locks is capped (LOCK_TIMEOUT).

The downgrade deletes the PostHog connections, drops the three tables and both columns,
and restores the checks and the index; ``metrics_variance`` leaves the flow check only
while no run uses it.

Revision ID: 0049_metrics
Revises: 0048_scope_review
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0049_metrics"
down_revision: str | None = "0048_scope_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
PROVIDER_CHECK = ("company_integrations", "ck_company_integrations_provider", "provider")
PURPOSE_CHECK = ("company_integrations", "ck_company_integrations_purpose", "purpose")
PROVIDERS = ("posthog",)
PURPOSES = ("metrics",)
FLOW_CHECK = ("runs", "ck_runs_flow", "flow")
FLOWS = ("metrics_variance",)
SLACK_TEAM = "uq_company_integrations_slack_team"


def _base() -> list[sa.Column]:
    return [
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
    ]  # fmt: skip


def _slack_team_index(where: str) -> None:
    op.create_index(
        SLACK_TEAM,
        "company_integrations",
        ["provider", "account_id"],
        unique=True,
        postgresql_where=sa.text(where),
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        "metrics",
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("unit", sa.Text(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("goal_id", sa.Uuid(), nullable=True),
        sa.Column("drives_metric_id", sa.Uuid(), nullable=True),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("query", sa.Text(), nullable=True),
        sa.Column("threshold_pct", sa.Numeric(6, 2), nullable=True),
        sa.Column("definition_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("definitions", JSONB(), server_default="[]", nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("last_pulled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failing_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_pull_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        *_base(),
        sa.CheckConstraint("kind IN ('output', 'input')", name=op.f("ck_metrics_kind")),
        sa.CheckConstraint("direction IN ('up', 'down')", name=op.f("ck_metrics_direction")),
        sa.CheckConstraint(
            "source IN ('posthog', 'manual', 'api')", name=op.f("ck_metrics_source")
        ),
        sa.CheckConstraint(
            "status IN ('active', 'paused', 'error', 'archived')", name=op.f("ck_metrics_status")
        ),
        sa.CheckConstraint(
            "threshold_pct IS NULL OR threshold_pct BETWEEN 1 AND 500",
            name=op.f("ck_metrics_threshold_pct"),
        ),
        sa.CheckConstraint(
            "(kind = 'input') = (drives_metric_id IS NOT NULL)", name=op.f("ck_metrics_drives")
        ),
        sa.CheckConstraint("kind = 'output' OR goal_id IS NULL", name=op.f("ck_metrics_goal")),
        sa.CheckConstraint(
            "(source = 'posthog') = (query IS NOT NULL)", name=op.f("ck_metrics_query")
        ),
        sa.ForeignKeyConstraint(
            ["goal_id"], ["entities.id"], name=op.f("fk_metrics_goal_id_entities"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["drives_metric_id"], ["metrics.id"],
            name=op.f("fk_metrics_drives_metric_id_metrics"), ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name=op.f("fk_metrics_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_metrics")),
    )  # fmt: skip
    op.create_index(op.f("ix_metrics_tenant_id"), "metrics", ["tenant_id"])
    op.create_index(op.f("ix_metrics_goal_id"), "metrics", ["goal_id"])
    op.create_index(op.f("ix_metrics_drives_metric_id"), "metrics", ["drives_metric_id"])
    op.create_index(
        "ux_metrics_title", "metrics", ["tenant_id", sa.text("lower(title)")], unique=True,
        postgresql_where=sa.text("status <> 'archived'"),
    )  # fmt: skip
    op.create_index(
        "ux_metrics_goal", "metrics", ["tenant_id", "goal_id"], unique=True,
        postgresql_where=sa.text("goal_id IS NOT NULL AND status <> 'archived'"),
    )  # fmt: skip

    op.create_table(
        "metric_values",
        sa.Column("metric_id", sa.Uuid(), nullable=False),
        sa.Column("week_start", sa.Date(), nullable=False),
        sa.Column("value", sa.Numeric(20, 6), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("definition_version", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("recorded_by", sa.Uuid(), nullable=True),
        sa.Column(
            "recorded_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        *_base(),
        sa.CheckConstraint(
            "source IN ('posthog', 'manual', 'api')", name=op.f("ck_metric_values_source")
        ),
        sa.CheckConstraint(
            "extract(isodow FROM week_start) = 1", name=op.f("ck_metric_values_monday")
        ),
        sa.ForeignKeyConstraint(
            ["metric_id"], ["metrics.id"], name=op.f("fk_metric_values_metric_id_metrics"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name=op.f("fk_metric_values_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_metric_values")),
        sa.UniqueConstraint(
            "metric_id", "week_start", name=op.f("uq_metric_values_metric_id_week_start")
        ),
    )  # fmt: skip
    op.create_index(op.f("ix_metric_values_tenant_id"), "metric_values", ["tenant_id"])
    op.create_index(op.f("ix_metric_values_metric_id"), "metric_values", ["metric_id"])

    op.create_table(
        "metric_variances",
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("metric_id", sa.Uuid(), nullable=False),
        sa.Column("week_start", sa.Date(), nullable=False),
        sa.Column("value", sa.Numeric(20, 6), nullable=False),
        sa.Column("previous", sa.Numeric(20, 6), nullable=False),
        sa.Column("band_low", sa.Numeric(20, 6), nullable=True),
        sa.Column("band_high", sa.Numeric(20, 6), nullable=True),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("possible_causes", JSONB(), server_default="[]", nullable=False),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("explanation", sa.Text(), nullable=True),
        sa.Column("explained_by", sa.Uuid(), nullable=True),
        sa.Column("explained_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("find_out_by", sa.Date(), nullable=True),
        sa.Column("noise_reason", sa.Text(), nullable=True),
        sa.Column("oracle_draft", sa.Text(), nullable=True),
        sa.Column("oracle_confidence", sa.Text(), nullable=True),
        sa.Column("oracle_refs", JSONB(), server_default="[]", nullable=False),
        sa.Column("oracle_run_id", sa.Uuid(), nullable=True),
        sa.Column("occurrence_id", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        *_base(),
        sa.CheckConstraint(
            "direction IN ('better', 'worse')", name=op.f("ck_metric_variances_direction")
        ),
        sa.CheckConstraint(
            "status IN ('open', 'explained', 'unknown', 'noise')",
            name=op.f("ck_metric_variances_status"),
        ),
        sa.CheckConstraint(
            "oracle_confidence IS NULL OR oracle_confidence IN ('high', 'medium', 'low')",
            name=op.f("ck_metric_variances_oracle_confidence"),
        ),
        sa.ForeignKeyConstraint(
            ["metric_id"], ["metrics.id"], name=op.f("fk_metric_variances_metric_id_metrics"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["oracle_run_id"], ["runs.id"], name=op.f("fk_metric_variances_oracle_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["occurrence_id"], ["ritual_occurrences.id"],
            name=op.f("fk_metric_variances_occurrence_id_ritual_occurrences"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name=op.f("fk_metric_variances_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_metric_variances")),
        sa.UniqueConstraint(
            "metric_id", "week_start", name=op.f("uq_metric_variances_metric_id_week_start")
        ),
    )  # fmt: skip
    op.create_index(op.f("ix_metric_variances_tenant_id"), "metric_variances", ["tenant_id"])
    op.create_index(op.f("ix_metric_variances_metric_id"), "metric_variances", ["metric_id"])
    op.create_index(
        op.f("ix_metric_variances_oracle_run_id"), "metric_variances", ["oracle_run_id"]
    )
    op.create_index(
        op.f("ix_metric_variances_occurrence_id"), "metric_variances", ["occurrence_id"]
    )

    op.add_column("goal_measurements", sa.Column("metric_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_goal_measurements_metric_id_metrics"), "goal_measurements", "metrics",
        ["metric_id"], ["id"], ondelete="SET NULL",
    )  # fmt: skip
    op.add_column(
        "company_integrations",
        sa.Column("config", JSONB(), server_default="{}", nullable=False),
    )
    add_check_values(*PROVIDER_CHECK, PROVIDERS)
    add_check_values(*PURPOSE_CHECK, PURPOSES)
    add_check_values(*FLOW_CHECK, FLOWS)
    op.drop_index(SLACK_TEAM, table_name="company_integrations")
    _slack_team_index("status = 'active' AND provider = 'slack'")


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM company_integrations WHERE provider = 'posthog'")
    op.drop_index(SLACK_TEAM, table_name="company_integrations")
    _slack_team_index("status = 'active'")
    remove_check_values(*PURPOSE_CHECK, PURPOSES)
    remove_check_values(*PROVIDER_CHECK, PROVIDERS)
    in_use = op.get_bind().scalar(
        sa.text("SELECT EXISTS (SELECT 1 FROM runs WHERE flow = 'metrics_variance')")
    )
    if not in_use:
        remove_check_values(*FLOW_CHECK, FLOWS)
    op.drop_column("company_integrations", "config")
    op.drop_constraint(
        op.f("fk_goal_measurements_metric_id_metrics"), "goal_measurements", type_="foreignkey"
    )
    op.drop_column("goal_measurements", "metric_id")
    op.drop_table("metric_variances")
    op.drop_table("metric_values")
    op.drop_table("metrics")
