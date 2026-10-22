"""H2 Cadence engine: rituals, their occurrences and who read each pre-read

New tables ``rituals``, ``ritual_occurrences`` and ``ritual_reads``
(oracle.rituals.models), and the ``ritual_summary`` flow (Oracle's written summary of a
pre-read), widened through ``oracle.migration_checks`` so no other lane's value is
dropped. The company settings ``company_timezone`` and ``ritual_summaries`` need no
schema: their defaults live in code.

Downgrade: deletes ritual_summary runs, narrows the flow check, drops the three tables
and the two settings keys.

Revision ID: 0026_rituals
Revises: 0025_goal_fields
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0026_rituals"
down_revision: str | None = "0025_goal_fields"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FLOW_CHECK = ("runs", "ck_runs_flow", "flow", ("ritual_summary",))


def _common(table: str) -> list:
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


def _updated_at() -> sa.Column:
    return sa.Column(
        "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def upgrade() -> None:
    add_check_values(*FLOW_CHECK)
    op.create_table(
        "rituals",
        _updated_at(),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("builtin", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("schedule", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("duration_min", sa.Integer(), nullable=False),
        sa.Column("prep_hours", sa.Integer(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("attendee_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}",
                  nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("next_due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        *_common("rituals"),
        sa.CheckConstraint("duration_min BETWEEN 5 AND 480", name=op.f("ck_rituals_duration_min")),
        sa.CheckConstraint("prep_hours BETWEEN 0 AND 168", name=op.f("ck_rituals_prep_hours")),
        sa.CheckConstraint("status IN ('active', 'paused')", name=op.f("ck_rituals_status")),
    )  # fmt: skip
    op.create_index(op.f("ix_rituals_tenant_id"), "rituals", ["tenant_id"], unique=False)
    op.create_index(
        "ux_rituals_builtin_kind", "rituals", ["tenant_id", "kind"], unique=True,
        postgresql_where=sa.text("builtin"),
    )  # fmt: skip
    op.create_index(
        "ix_rituals_due", "rituals", ["tenant_id", "next_due_at"], unique=False,
        postgresql_where=sa.text("status = 'active'"),
    )  # fmt: skip
    op.create_table(
        "ritual_occurrences",
        _updated_at(),
        sa.Column("ritual_id", sa.Uuid(), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("period_to", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.Text(), server_default="scheduled", nullable=False),
        sa.Column("pre_read", postgresql.JSONB(astext_type=sa.Text()), server_default="{}",
                  nullable=False),
        sa.Column("pre_read_built_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("skip_reason", sa.Text(), nullable=True),
        sa.Column("decision_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}",
                  nullable=False),
        sa.Column("held_by", sa.Uuid(), nullable=True),
        sa.Column("held_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("summary_run_id", sa.Uuid(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("summary_state", sa.Text(), server_default="none", nullable=False),
        sa.Column("summary_note", sa.Text(), nullable=True),
        *_common("ritual_occurrences"),
        sa.ForeignKeyConstraint(
            ["ritual_id"], ["rituals.id"], name=op.f("fk_ritual_occurrences_ritual_id_rituals"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["summary_run_id"], ["runs.id"],
            name=op.f("fk_ritual_occurrences_summary_run_id_runs"), ondelete="SET NULL",
        ),
        sa.UniqueConstraint("ritual_id", "due_at",
                            name=op.f("uq_ritual_occurrences_ritual_id_due_at")),
        sa.CheckConstraint(
            "status IN ('scheduled', 'ready', 'held', 'skipped', 'missed', 'failed')",
            name=op.f("ck_ritual_occurrences_status"),
        ),
        sa.CheckConstraint(
            "summary_state IN ('none', 'running', 'ready', 'failed', 'not_started')",
            name=op.f("ck_ritual_occurrences_summary_state"),
        ),
    )  # fmt: skip
    for column in ("tenant_id", "ritual_id", "summary_run_id"):
        op.create_index(
            op.f(f"ix_ritual_occurrences_{column}"), "ritual_occurrences", [column], unique=False
        )
    op.create_table(
        "ritual_reads",
        sa.Column("occurrence_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
                  nullable=False),
        *_common("ritual_reads"),
        sa.ForeignKeyConstraint(
            ["occurrence_id"], ["ritual_occurrences.id"],
            name=op.f("fk_ritual_reads_occurrence_id_ritual_occurrences"), ondelete="CASCADE",
        ),
        sa.UniqueConstraint("occurrence_id", "user_id",
                            name=op.f("uq_ritual_reads_occurrence_id_user_id")),
    )  # fmt: skip
    op.create_index(op.f("ix_ritual_reads_tenant_id"), "ritual_reads", ["tenant_id"], unique=False)


def downgrade() -> None:
    op.drop_table("ritual_reads")
    op.drop_table("ritual_occurrences")
    op.drop_table("rituals")
    op.execute("DELETE FROM runs WHERE flow = 'ritual_summary'")
    remove_check_values(*FLOW_CHECK)
    op.execute("DELETE FROM tenant_settings WHERE key IN ('company_timezone', 'ritual_summaries')")
