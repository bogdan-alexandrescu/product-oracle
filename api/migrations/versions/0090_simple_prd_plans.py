"""plan-model: a PRD's plan as data (oracle.simple.plan).

- ``simple_prd_plans``: one row per PRD, its plan read from its approved version (the
  milestones, features, goals and holidays as JSON), its status and source.
- ``roadmap_date_suggestions.slice_code``: a date to confirm per slice (F-05a), so the open
  suggestion is unique per item and slice.
- ``prd_plan`` joins the ``llm_jobs`` kinds.

The downgrade drops the table, the column (with every slice's suggestion) and the kind.

Revision ID: 0090_simple_prd_plans
Revises: 0090_goal_suggestion_people
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0090_simple_prd_plans"
down_revision: str | None = "0090_goal_suggestion_people"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
T = "simple_prd_plans"
S = "roadmap_date_suggestions"
OPEN = "uq_roadmap_date_suggestions_open"


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.create_table(
        T,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="none", nullable=False),
        sa.Column("source", sa.Text(), nullable=True),
        sa.Column("data", postgresql.JSONB(), server_default="{}", nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('ready', 'reading', 'failed', 'none')", name=op.f(f"ck_{T}_status")
        ),
        sa.CheckConstraint(
            "source IS NULL OR source IN ('prd', 'oracle')", name=op.f(f"ck_{T}_source")
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"],
                                name=op.f(f"fk_{T}_tenant_id_tenants"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["document_id"], ["documents.id"],
                                name=op.f(f"fk_{T}_document_id_documents"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["version_id"], ["document_versions.id"],
                                name=op.f(f"fk_{T}_version_id_document_versions"),
                                ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{T}")),
        sa.UniqueConstraint("document_id", name=op.f(f"uq_{T}_document_id")),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{T}_tenant_id"), T, ["tenant_id"])
    op.add_column(S, sa.Column("slice_code", sa.Text(), nullable=True))
    op.drop_index(OPEN, table_name=S)
    op.create_index(
        OPEN,
        S,
        ["item_id", sa.text("coalesce(slice_code, '')")],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
    )
    add_check_values(*KIND_CHECK, ("prd_plan",))


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("DELETE FROM llm_jobs WHERE kind = 'prd_plan'")
    remove_check_values(*KIND_CHECK, ("prd_plan",))
    op.execute(f"DELETE FROM {S} WHERE slice_code IS NOT NULL")
    op.drop_index(OPEN, table_name=S)
    op.create_index(OPEN, S, ["item_id"], unique=True,
                    postgresql_where=sa.text("status = 'open'"))  # fmt: skip
    op.drop_column(S, "slice_code")
    op.drop_table(T)
