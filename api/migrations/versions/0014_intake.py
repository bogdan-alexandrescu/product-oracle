"""Product Oracle v2 intake (wave 1, lane v2-intake, CR-03)

Additive only. ``intake_proposals`` holds what an intake proposes from an answer (a
research run, a PRD patch) until a person accepts or dismisses it. ``llm_jobs`` gains
``intake_id`` and the ``intake_analysis`` kind, so light extraction runs on the existing
built-in model jobs; an intake job has no document, so ``document_id`` becomes nullable
and a check keeps every job tied to a document or an intake. Existing rows are
untouched. See docs/product-oracle-v2/03-discovery-and-quality.md.

Security review fixes (same lane, same revision):

- Pin stability: a snapshot records the database's transaction snapshot when it is
  taken (``snapshots.txn_snapshot``), every source item version the transaction that
  wrote it (``source_item_versions.xid``), and a deletion its transaction
  (``source_items.deleted_xid``). A pinned read keeps only what had *committed* when the
  pin was taken, so a sync that began before the pin and commits after it never joins
  the pinned set. Rows from before this revision have no xid and count as committed.
- ``knowledge_gaps.status`` gains ``answered_pending_review``: a critical gap answered
  by someone below the owner role waits for review instead of clearing (B4).
- ``knowledge_gaps.rule_key`` (round 3): the category key of a gap the intake engine
  made by rule. A rule-made gap was told from a model-written one by its statement
  text, so rewording a category in code turned rule gaps private (S6). Existing rows
  are backfilled from the statements as they stand at this revision.
- ``knowledge_gaps.importance_basis`` (round 4): where a gap's importance comes from,
  ``brief`` (the engine, from the brief and public facts) or ``person`` (someone set it).
  It is recorded on the gap whatever private findings the intake holds, so setting
  importance changes the same rows either way (S6). Existing rows keep NULL: their
  importance may have been moved by private sources, so reads still derive what others
  see from the brief for them.

The integrator re-chains this revision in merge order (waves.md).

Revision ID: 0014_intake
Revises: 0013
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_intake"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DOCUMENT_JOB_KINDS = "kind IN ('review_comments', 'reporting', 'refinement')"
ALL_JOB_KINDS = "kind IN ('review_comments', 'reporting', 'refinement', 'intake_analysis')"
GAP_STATUSES = (
    "status IN ('unknown', 'under_investigation', 'asked', 'answered', 'validated', "
    "'deferred', 'accepted_risk')"
)
GAP_STATUSES_REVIEW = (
    "status IN ('unknown', 'under_investigation', 'asked', 'answered', "
    "'answered_pending_review', 'validated', 'deferred', 'accepted_risk')"
)
# The rule-made statements at this revision, frozen (the backfill never follows code).
RULE_STATEMENTS = {
    "customer_user": "The primary user or customer segment is not confirmed.",
    "pain_evidence": "There is no confirmed evidence that the pain is real and frequent.",
    "goal_alignment": "No confirmed company goal is linked to this idea.",
    "success_metric": "No success metric with a baseline value and a target is agreed.",
    "differentiation": "Why this beats what competitors or the status quo offer is not stated.",
    "alternatives": "Alternatives (including doing nothing) have not been compared.",
    "constraints": "Technical, legal or organisational constraints are not listed.",
    "blockers": "It is unknown whether anything could stop this from shipping.",
    "economic_benefit": "The expected economic benefit is not estimated.",
    "effort_cost": "Effort and running cost are not estimated.",
    "security_privacy": "Security and privacy impact is not assessed.",
    "ownership": "No team or person owns the outcome.",
    "non_goals": "What is deliberately out of scope is not stated.",
    "release_rollout": "How this is released and rolled back is not planned.",
    "evaluation_criteria": "How quality is evaluated before launch is not defined.",
    "third_party_policy": (
        "Third-party API eligibility, limits, permissions and policies are not checked."
    ),
    "configurability_scaling": "Expected scale and what must be configurable are not known.",
}
XID = "(pg_current_xact_id()::text)::bigint"
TXN_SNAPSHOT = "pg_current_snapshot()::text"


def upgrade() -> None:
    op.create_table(
        "intake_proposals",
        sa.Column("intake_id", sa.Uuid(), nullable=False),
        sa.Column("gap_id", sa.Uuid(), nullable=True),
        sa.Column("question_id", sa.Uuid(), nullable=True),
        sa.Column("answer_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column(
            "detail", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("status", sa.Text(), server_default="proposed", nullable=False),
        sa.Column(
            "result", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_note", sa.Text(), nullable=True),
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
            "kind IN ('research_run', 'prd_patch')", name=op.f("ck_intake_proposals_kind")
        ),
        sa.CheckConstraint(
            "status IN ('proposed', 'accepted', 'dismissed')",
            name=op.f("ck_intake_proposals_status"),
        ),
        sa.ForeignKeyConstraint(
            ["answer_id"],
            ["stakeholder_answers.id"],
            name=op.f("fk_intake_proposals_answer_id_stakeholder_answers"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["gap_id"],
            ["knowledge_gaps.id"],
            name=op.f("fk_intake_proposals_gap_id_knowledge_gaps"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["intake_id"],
            ["product_intakes.id"],
            name=op.f("fk_intake_proposals_intake_id_product_intakes"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["question_id"],
            ["stakeholder_questions.id"],
            name=op.f("fk_intake_proposals_question_id_stakeholder_questions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_intake_proposals_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_intake_proposals")),
    )
    for column in ("answer_id", "gap_id", "intake_id", "question_id", "tenant_id"):
        op.create_index(
            op.f(f"ix_intake_proposals_{column}"), "intake_proposals", [column], unique=False
        )

    op.add_column("llm_jobs", sa.Column("intake_id", sa.Uuid(), nullable=True))
    op.alter_column("llm_jobs", "document_id", existing_type=sa.UUID(), nullable=True)
    op.create_index(op.f("ix_llm_jobs_intake_id"), "llm_jobs", ["intake_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_llm_jobs_intake_id_product_intakes"),
        "llm_jobs",
        "product_intakes",
        ["intake_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_constraint(op.f("ck_llm_jobs_kind"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_kind"), "llm_jobs", ALL_JOB_KINDS)
    op.create_check_constraint(
        op.f("ck_llm_jobs_subject"), "llm_jobs", "document_id IS NOT NULL OR intake_id IS NOT NULL"
    )

    # Pin stability. Added without a default first, so existing rows keep NULL (committed).
    op.add_column("source_item_versions", sa.Column("xid", sa.BigInteger(), nullable=True))
    op.alter_column("source_item_versions", "xid", server_default=sa.text(XID))
    op.add_column("source_items", sa.Column("deleted_xid", sa.BigInteger(), nullable=True))
    op.add_column("snapshots", sa.Column("txn_snapshot", sa.Text(), nullable=True))
    op.alter_column("snapshots", "txn_snapshot", server_default=sa.text(TXN_SNAPSHOT))

    op.drop_constraint(op.f("ck_knowledge_gaps_status"), "knowledge_gaps", type_="check")
    op.create_check_constraint(
        op.f("ck_knowledge_gaps_status"), "knowledge_gaps", GAP_STATUSES_REVIEW
    )

    op.add_column("knowledge_gaps", sa.Column("rule_key", sa.Text(), nullable=True))
    for key, statement in RULE_STATEMENTS.items():
        op.execute(
            sa.text(
                "UPDATE knowledge_gaps SET rule_key = :key WHERE category = :key "
                "AND statement = :statement AND created_by IS NULL AND intake_id IS NOT NULL"
            ).bindparams(key=key, statement=statement)
        )

    op.add_column("knowledge_gaps", sa.Column("importance_basis", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f("ck_knowledge_gaps_importance_basis"),
        "knowledge_gaps",
        "importance_basis IS NULL OR importance_basis IN ('brief', 'person')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_knowledge_gaps_importance_basis"), "knowledge_gaps", type_="check")
    op.drop_column("knowledge_gaps", "importance_basis")
    op.drop_column("knowledge_gaps", "rule_key")
    # A gap waiting for review goes back to answered (what it was before B4).
    op.execute(
        "UPDATE knowledge_gaps SET status = 'answered' WHERE status = 'answered_pending_review'"
    )
    op.drop_constraint(op.f("ck_knowledge_gaps_status"), "knowledge_gaps", type_="check")
    op.create_check_constraint(op.f("ck_knowledge_gaps_status"), "knowledge_gaps", GAP_STATUSES)
    op.drop_column("snapshots", "txn_snapshot")
    op.drop_column("source_items", "deleted_xid")
    op.drop_column("source_item_versions", "xid")

    # Intake jobs have no document: they go with the column.
    op.execute("DELETE FROM llm_jobs WHERE document_id IS NULL OR kind = 'intake_analysis'")
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.drop_constraint(op.f("ck_llm_jobs_kind"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_kind"), "llm_jobs", DOCUMENT_JOB_KINDS)
    op.drop_constraint(
        op.f("fk_llm_jobs_intake_id_product_intakes"), "llm_jobs", type_="foreignkey"
    )
    op.drop_index(op.f("ix_llm_jobs_intake_id"), table_name="llm_jobs")
    op.alter_column("llm_jobs", "document_id", existing_type=sa.UUID(), nullable=False)
    op.drop_column("llm_jobs", "intake_id")
    for column in ("tenant_id", "question_id", "intake_id", "gap_id", "answer_id"):
        op.drop_index(op.f(f"ix_intake_proposals_{column}"), table_name="intake_proposals")
    op.drop_table("intake_proposals")
