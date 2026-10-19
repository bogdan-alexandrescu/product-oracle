"""PRD quality and organizational learning (v2 lane v2-quality, CR-08)

Additive only. ``outcome_records`` link what launched (an approved PRD version, a
roadmap item, a validation experiment) to the goal it serves, with the prediction and
whether it held; ``quality_learnings`` keep what the company learned for future module
and question recommendations. ``llm_jobs.kind`` gains ``quality_review`` (light judging
on the built-in model jobs). Evaluation reports and findings are the foundation's tables.
See docs/product-oracle-v2/03b-quality-and-readiness.md.

The integrator re-chains 0014_* revisions in merge order (waves.md).

Revision ID: 0014_quality
Revises: 0013
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_quality"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_JOB_KINDS = ("review_comments", "reporting", "refinement")
NEW_JOB_KINDS = (*OLD_JOB_KINDS, "quality_review")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _set_job_kinds(kinds: tuple[str, ...]) -> None:
    op.drop_constraint(op.f("ck_llm_jobs_kind"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_kind"), "llm_jobs", _in("kind", kinds))


def _common(table: str) -> list:
    return [
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{table}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]


def _fk(table: str, column: str, target: str, ondelete: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column], [f"{target}.id"], name=op.f(f"fk_{table}_{column}_{target}"), ondelete=ondelete
    )


OUTCOME_FKS = (
    ("goal_id", "entities", "CASCADE"),
    ("outcome_entity_id", "entities", "SET NULL"),
    ("document_id", "documents", "SET NULL"),
    ("prd_version_id", "document_versions", "SET NULL"),
    ("roadmap_version_id", "document_versions", "SET NULL"),
    ("experiment_id", "feasibility_experiments", "SET NULL"),
)


def upgrade() -> None:
    _set_job_kinds(NEW_JOB_KINDS)
    t = "outcome_records"
    op.create_table(
        t,
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("goal_id", sa.Uuid(), nullable=False),
        sa.Column("outcome_entity_id", sa.Uuid(), nullable=True),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("prd_version_id", sa.Uuid(), nullable=True),
        sa.Column("roadmap_version_id", sa.Uuid(), nullable=True),
        sa.Column("roadmap_item_key", sa.Text(), nullable=True),
        sa.Column("experiment_id", sa.Uuid(), nullable=True),
        sa.Column("prediction", postgresql.JSONB(), server_default="{}", nullable=False),
        sa.Column("module_keys", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column(
            "gap_categories", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("status", sa.Text(), server_default="tracking", nullable=False),
        sa.Column("observed", sa.Text(), nullable=True),
        sa.Column("assessments", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("evidence_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("assessed_by", sa.Uuid(), nullable=True),
        sa.Column("assessed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        *_common(t),
        sa.CheckConstraint(
            "status IN ('tracking', 'held', 'partially_held', 'not_held', 'inconclusive')",
            name=op.f(f"ck_{t}_status"),
        ),
        *(_fk(t, column, target, ondelete) for column, target, ondelete in OUTCOME_FKS),
    )
    for column in ("tenant_id", *(c for c, _, _ in OUTCOME_FKS)):
        op.create_index(op.f(f"ix_{t}_{column}"), t, [column], unique=False)

    t = "quality_learnings"
    op.create_table(
        t,
        sa.Column("outcome_id", sa.Uuid(), nullable=True),
        sa.Column("statement", sa.Text(), nullable=False),
        sa.Column("applies_to", sa.Text(), nullable=False),
        sa.Column("target", sa.Text(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("weight", sa.Integer(), server_default="1", nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("retired_reason", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("retired_by", sa.Uuid(), nullable=True),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        *_common(t),
        sa.CheckConstraint(
            "applies_to IN ('module', 'question_category', 'criterion')",
            name=op.f(f"ck_{t}_applies_to"),
        ),
        sa.CheckConstraint(
            "direction IN ('recommend_more', 'recommend_less', 'note')",
            name=op.f(f"ck_{t}_direction"),
        ),
        sa.CheckConstraint("status IN ('active', 'retired')", name=op.f(f"ck_{t}_status")),
        sa.CheckConstraint("weight >= 1 AND weight <= 3", name=op.f(f"ck_{t}_weight")),
        _fk(t, "outcome_id", "outcome_records", "SET NULL"),
    )
    for column in ("tenant_id", "outcome_id"):
        op.create_index(op.f(f"ix_{t}_{column}"), t, [column], unique=False)


def downgrade() -> None:
    for column in ("tenant_id", "outcome_id"):
        op.drop_index(op.f(f"ix_quality_learnings_{column}"), table_name="quality_learnings")
    op.drop_table("quality_learnings")
    for column in ("tenant_id", *(c for c, _, _ in OUTCOME_FKS)):
        op.drop_index(op.f(f"ix_outcome_records_{column}"), table_name="outcome_records")
    op.drop_table("outcome_records")
    # Model reviews go with their kind; their evaluation reports stay (evaluator llm_job).
    op.execute("DELETE FROM llm_jobs WHERE kind = 'quality_review'")
    _set_job_kinds(OLD_JOB_KINDS)
