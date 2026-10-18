"""Built-in model jobs

The owner, 2026-10-17 (questions C1c): review comments, reporting and refinement run in
Oracle as jobs on the Claude account pool, each optional per document. ``llm_jobs`` is
the job queue and its record (status, input, output, the account that ran it, tokens,
cost, error and the pool's reason when no account could take it); ``llm_suggestions``
holds what a review-comments job drafts for each feedback item (classification, group,
suggested text or answer, a C1b pushback) until an approver accepts, edits or dismisses
it; ``documents.disabled_llm_jobs`` lists the job kinds an owner turned off.

(Planned as 0007 on 0006; 0007 went to the Claude account pool first, so this is 0008.)

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-18 03:12:50.088142
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "llm_jobs",
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=True),
        sa.Column("section_key", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "input", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("output", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("account_label", sa.Text(), nullable=True),
        sa.Column("via", sa.Text(), nullable=True),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Numeric(precision=10, scale=4), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("error_reason", sa.Text(), nullable=True),
        sa.Column("next_reset_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("requested_by", sa.Uuid(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
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
            "kind IN ('review_comments', 'reporting', 'refinement')", name=op.f("ck_llm_jobs_kind")
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')",
            name=op.f("ck_llm_jobs_status"),
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_llm_jobs_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_llm_jobs_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["document_versions.id"],
            name=op.f("fk_llm_jobs_version_id_document_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_llm_jobs")),
    )
    op.create_index(
        "ix_llm_jobs_document_status", "llm_jobs", ["document_id", "status"], unique=False
    )
    op.create_index(
        "ix_llm_jobs_status_created", "llm_jobs", ["status", "created_at"], unique=False
    )
    op.create_index(op.f("ix_llm_jobs_tenant_id"), "llm_jobs", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_llm_jobs_version_id"), "llm_jobs", ["version_id"], unique=False)
    op.create_table(
        "llm_suggestions",
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("feedback_item_id", sa.Uuid(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("classification", sa.Text(), nullable=False),
        sa.Column("group_key", sa.Text(), nullable=True),
        sa.Column("duplicate_of", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("section_key", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("edited_text", sa.Text(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("pushback", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("override_reason", sa.Text(), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applied_in_version", sa.Integer(), nullable=True),
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
            "classification IN ('question', 'change_request', 'factual_correction', "
            "'approval', 'other')",
            name=op.f("ck_llm_suggestions_classification"),
        ),
        sa.CheckConstraint(
            "kind IN ('section_text', 'answer', 'none', 'duplicate')",
            name=op.f("ck_llm_suggestions_kind"),
        ),
        sa.CheckConstraint(
            "status IN ('open', 'accepted', 'dismissed', 'applied', 'superseded')",
            name=op.f("ck_llm_suggestions_status"),
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_llm_suggestions_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["duplicate_of"],
            ["feedback_items.id"],
            name=op.f("fk_llm_suggestions_duplicate_of_feedback_items"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["feedback_item_id"],
            ["feedback_items.id"],
            name=op.f("fk_llm_suggestions_feedback_item_id_feedback_items"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["llm_jobs.id"],
            name=op.f("fk_llm_suggestions_job_id_llm_jobs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_llm_suggestions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_llm_suggestions")),
    )
    op.create_index(
        "ix_llm_suggestions_document_status",
        "llm_suggestions",
        ["document_id", "status"],
        unique=False,
    )
    op.create_index(
        op.f("ix_llm_suggestions_feedback_item_id"),
        "llm_suggestions",
        ["feedback_item_id"],
        unique=False,
    )
    op.create_index(op.f("ix_llm_suggestions_job_id"), "llm_suggestions", ["job_id"], unique=False)
    op.create_index(
        op.f("ix_llm_suggestions_tenant_id"), "llm_suggestions", ["tenant_id"], unique=False
    )
    op.add_column(
        "documents",
        sa.Column(
            "disabled_llm_jobs", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_column("documents", "disabled_llm_jobs")
    op.drop_index(op.f("ix_llm_suggestions_tenant_id"), table_name="llm_suggestions")
    op.drop_index(op.f("ix_llm_suggestions_job_id"), table_name="llm_suggestions")
    op.drop_index(op.f("ix_llm_suggestions_feedback_item_id"), table_name="llm_suggestions")
    op.drop_index("ix_llm_suggestions_document_status", table_name="llm_suggestions")
    op.drop_table("llm_suggestions")
    op.drop_index(op.f("ix_llm_jobs_version_id"), table_name="llm_jobs")
    op.drop_index(op.f("ix_llm_jobs_tenant_id"), table_name="llm_jobs")
    op.drop_index("ix_llm_jobs_status_created", table_name="llm_jobs")
    op.drop_index("ix_llm_jobs_document_status", table_name="llm_jobs")
    op.drop_table("llm_jobs")
