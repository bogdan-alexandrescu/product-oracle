"""Interviews: customer interviews through a private one-time link (C3 lane 1)

New tables ``interviews`` and ``interview_messages`` (oracle.interviews.models).
``product_requests.interview_id`` gets its foreign key (C1 left it bare). ``llm_jobs``
gains ``interview_id`` and the ``interview_guide`` and ``interview_snapshot`` kinds, with
an interview as a job's fourth possible subject; the kinds are added with the additive
helpers (frozen below), so values other lanes add survive.

Downgrade: deletes the interview jobs, clears ``product_requests.interview_id`` (requests
made from interviews keep their text), restores both checks and drops both tables.

Revision ID: 0032_interviews
Revises: 0031_basis_verification
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0032_interviews"
down_revision: str | None = "0031_basis_verification"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
KINDS = ("interview_guide", "interview_snapshot")
SUBJECT_BEFORE = "document_id IS NOT NULL OR intake_id IS NOT NULL OR decision_id IS NOT NULL"
SUBJECT_AFTER = SUBJECT_BEFORE + " OR interview_id IS NOT NULL"


# --- oracle.migration_checks, frozen here as of this revision ----------------------------

_VALUE = re.compile(r"'((?:[^']|'')*)'")


def check_values(table: str, constraint: str) -> list[str]:
    """The values a ``column IN (...)`` check constraint allows now, in its order."""
    definition = op.get_bind().scalar(
        sa.text(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE c.conname = :name AND t.relname = :table AND c.contype = 'c'"
        ),
        {"name": constraint, "table": table},
    )
    if definition is None:
        raise RuntimeError(f"check constraint {constraint} on {table} not found")
    return [v.replace("''", "'") for v in _VALUE.findall(definition)]


def _replace(table: str, constraint: str, column: str, values: list[str]) -> None:
    listed = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    op.drop_constraint(op.f(constraint), table, type_="check")
    op.create_check_constraint(op.f(constraint), table, f"{column} IN ({listed})")


def add_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    now = check_values(table, constraint)
    missing = [v for v in values if v not in now]
    if missing:
        _replace(table, constraint, column, now + missing)


def remove_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    now = check_values(table, constraint)
    kept = [v for v in now if v not in values]
    if kept != now:
        _replace(table, constraint, column, kept)


def upgrade() -> None:
    op.create_table(
        "interviews",
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("intake_id", sa.Uuid(), nullable=True),
        sa.Column("theme_id", sa.Uuid(), nullable=True),
        sa.Column("topic", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("intro", sa.Text(), nullable=True),
        sa.Column(
            "guide", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("guide_job_id", sa.Uuid(), nullable=True),
        sa.Column("interviewee_user_id", sa.Uuid(), nullable=True),
        sa.Column("interviewee_name", sa.Text(), nullable=True),
        sa.Column("interviewee_company", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column("link_token_hash", sa.Text(), nullable=True),
        sa.Column("link_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("link_opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("session_hash", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
        sa.Column("followed_up", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("customer_messages", sa.Integer(), server_default="0", nullable=False),
        sa.Column("turn_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refusals_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refusals", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "snapshot", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("snapshot_job_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind <> 'customer' OR interviewee_name IS NOT NULL",
            name=op.f("ck_interviews_customer"),
        ),
        sa.CheckConstraint(
            "kind <> 'team' OR (intake_id IS NOT NULL AND interviewee_user_id IS NOT NULL)",
            name=op.f("ck_interviews_team"),
        ),
        sa.CheckConstraint("kind IN ('team', 'customer')", name=op.f("ck_interviews_kind")),
        sa.CheckConstraint(
            "status IN ('draft', 'invited', 'in_progress', 'finished', 'expired', 'revoked')",
            name=op.f("ck_interviews_status"),
        ),
        sa.ForeignKeyConstraint(
            ["guide_job_id"],
            ["llm_jobs.id"],
            name=op.f("fk_interviews_guide_job_id_llm_jobs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["intake_id"],
            ["product_intakes.id"],
            name=op.f("fk_interviews_intake_id_product_intakes"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["snapshot_job_id"],
            ["llm_jobs.id"],
            name=op.f("fk_interviews_snapshot_job_id_llm_jobs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_interviews_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["theme_id"],
            ["request_themes.id"],
            name=op.f("fk_interviews_theme_id_request_themes"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_interviews")),
        sa.UniqueConstraint("link_token_hash", name=op.f("uq_interviews_link_token_hash")),
    )
    op.create_index(op.f("ix_interviews_intake_id"), "interviews", ["intake_id"], unique=False)
    op.create_index(op.f("ix_interviews_tenant_id"), "interviews", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_interviews_theme_id"), "interviews", ["theme_id"], unique=False)
    op.create_index(
        "ux_interviews_team",
        "interviews",
        ["intake_id", "interviewee_user_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'team'"),
    )
    op.create_table(
        "interview_messages",
        sa.Column("interview_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("guide_item", sa.Text(), nullable=True),
        sa.Column("question_id", sa.Uuid(), nullable=True),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("usage", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("cost_usd", sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('intro', 'question', 'ack', 'follow_up', 'answer', 'skip', 'closing')",
            name=op.f("ck_interview_messages_kind"),
        ),
        sa.CheckConstraint(
            "role IN ('oracle', 'interviewee')", name=op.f("ck_interview_messages_role")
        ),
        sa.ForeignKeyConstraint(
            ["interview_id"],
            ["interviews.id"],
            name=op.f("fk_interview_messages_interview_id_interviews"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["question_id"],
            ["stakeholder_questions.id"],
            name=op.f("fk_interview_messages_question_id_stakeholder_questions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_interview_messages_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_interview_messages")),
    )
    op.create_index(
        "ix_interview_messages_interview",
        "interview_messages",
        ["interview_id", "created_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_interview_messages_tenant_id"), "interview_messages", ["tenant_id"], unique=False
    )
    op.add_column("llm_jobs", sa.Column("interview_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_llm_jobs_interview_id"), "llm_jobs", ["interview_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_llm_jobs_interview_id_interviews"),
        "llm_jobs",
        "interviews",
        ["interview_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        op.f("fk_product_requests_interview_id_interviews"),
        "product_requests",
        "interviews",
        ["interview_id"],
        ["id"],
        ondelete="SET NULL",
    )
    add_check_values(*KIND_CHECK, KINDS)
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_AFTER)


def downgrade() -> None:
    op.execute(
        "DELETE FROM llm_jobs WHERE interview_id IS NOT NULL "
        "OR kind IN ('interview_guide', 'interview_snapshot')"
    )
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_BEFORE)
    remove_check_values(*KIND_CHECK, KINDS)
    op.execute("UPDATE product_requests SET interview_id = NULL WHERE interview_id IS NOT NULL")
    op.drop_constraint(
        op.f("fk_product_requests_interview_id_interviews"), "product_requests", type_="foreignkey"
    )
    op.drop_constraint(op.f("fk_llm_jobs_interview_id_interviews"), "llm_jobs", type_="foreignkey")
    op.drop_index(op.f("ix_llm_jobs_interview_id"), table_name="llm_jobs")
    op.drop_column("llm_jobs", "interview_id")
    op.drop_index(op.f("ix_interview_messages_tenant_id"), table_name="interview_messages")
    op.drop_index("ix_interview_messages_interview", table_name="interview_messages")
    op.drop_table("interview_messages")
    op.drop_index(
        "ux_interviews_team", table_name="interviews", postgresql_where=sa.text("kind = 'team'")
    )
    op.drop_index(op.f("ix_interviews_theme_id"), table_name="interviews")
    op.drop_index(op.f("ix_interviews_tenant_id"), table_name="interviews")
    op.drop_index(op.f("ix_interviews_intake_id"), table_name="interviews")
    op.drop_table("interviews")
