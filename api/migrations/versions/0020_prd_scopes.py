"""PRD scopes (C6 Feature set and PRD scope): prd_scopes and prd_scope_items

Additive. A run's feature-set segment writes ``feature_set.yaml``; when it ends Oracle
checks the file and writes a proposed scope (``prd_scopes``) with one row per feature and
requirement (``prd_scope_items``). Approving the feature-set checkpoint approves it; the
priority order, the PRD draft and the document's next drafts read it
(oracle.runs.feature_set). Existing runs, checkpoints and documents are untouched: a run
that stopped at the feature set before this has no scope and approves as before.

When pick C8 Priority order snapshot has already created ``priority_snapshots.scope_id``,
this also links it to ``prd_scopes`` (``ON DELETE SET NULL``); otherwise C8's own
migration adds that link.

Downgrade drops both tables (and that link, when this added it).

Revision ID: 0020_prd_scopes
Revises: 0014_member_follow_up_retry
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020_prd_scopes"
down_revision: str | None = "0014_member_follow_up_retry"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PRIORITY_FK = "fk_priority_snapshots_scope_id_prd_scopes"


def _has_priority_scope_column() -> bool:
    return bool(
        op.get_bind().scalar(
            sa.text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'priority_snapshots' "
                "AND column_name = 'scope_id'"
            )
        )
    )


def _has_priority_fk() -> bool:
    return bool(
        op.get_bind().scalar(
            sa.text("SELECT 1 FROM pg_constraint WHERE conname = :n"), {"n": PRIORITY_FK}
        )
    )


def upgrade() -> None:
    op.create_table(
        "prd_scopes",
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("segment_seq", sa.Integer(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("checkpoint_id", sa.Uuid(), nullable=True),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="proposed", nullable=False),
        sa.Column(
            "check_result",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("approved_by", sa.Uuid(), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
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
            "status IN ('proposed', 'approved', 'superseded')", name=op.f("ck_prd_scopes_status")
        ),
        sa.ForeignKeyConstraint(
            ["checkpoint_id"],
            ["checkpoints.id"],
            name=op.f("fk_prd_scopes_checkpoint_id_checkpoints"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_prd_scopes_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_prd_scopes_run_id_runs"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_prd_scopes_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_prd_scopes")),
        sa.UniqueConstraint(
            "run_id",
            "segment_seq",
            "attempt",
            name=op.f("uq_prd_scopes_run_id_segment_seq_attempt"),
        ),
    )
    op.create_index("ix_prd_scopes_document", "prd_scopes", ["document_id", "status"], unique=False)
    op.create_index(op.f("ix_prd_scopes_tenant_id"), "prd_scopes", ["tenant_id"], unique=False)
    op.create_table(
        "prd_scope_items",
        sa.Column("scope_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column(
            "acceptance",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.Column("proposal_id", sa.Uuid(), nullable=True),
        sa.Column(
            "goals", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("depends_on", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("blocker_keys", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("confidence", sa.Numeric(precision=4, scale=3), nullable=True),
        sa.Column("evidence_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("decision", sa.Text(), nullable=False),
        sa.Column("decision_reason", sa.Text(), nullable=True),
        sa.Column("origin", sa.Text(), server_default="agent", nullable=False),
        sa.Column("flags", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
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
            "(kind = 'feature' AND decision IN ('include', 'exclude', 'defer')) OR "
            "(kind = 'requirement' AND decision IN ('keep', 'cut'))",
            name=op.f("ck_prd_scope_items_decision"),
        ),
        sa.CheckConstraint(
            "decision IN ('include', 'exclude', 'defer', 'keep', 'cut')",
            name=op.f("ck_prd_scope_items_decision_values"),
        ),
        sa.CheckConstraint(
            "kind IN ('feature', 'requirement')", name=op.f("ck_prd_scope_items_kind")
        ),
        sa.CheckConstraint("origin IN ('agent', 'person')", name=op.f("ck_prd_scope_items_origin")),
        sa.ForeignKeyConstraint(
            ["entity_id"],
            ["entities.id"],
            name=op.f("fk_prd_scope_items_entity_id_entities"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["prd_scope_items.id"],
            name=op.f("fk_prd_scope_items_parent_id_prd_scope_items"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["proposal_id"],
            ["proposals.id"],
            name=op.f("fk_prd_scope_items_proposal_id_proposals"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["scope_id"],
            ["prd_scopes.id"],
            name=op.f("fk_prd_scope_items_scope_id_prd_scopes"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_prd_scope_items_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_prd_scope_items")),
        sa.UniqueConstraint(
            "scope_id", "kind", "key", name=op.f("uq_prd_scope_items_scope_id_kind_key")
        ),
    )
    op.create_index(
        op.f("ix_prd_scope_items_scope_id"), "prd_scope_items", ["scope_id"], unique=False
    )
    op.create_index(
        op.f("ix_prd_scope_items_tenant_id"), "prd_scope_items", ["tenant_id"], unique=False
    )
    if _has_priority_scope_column() and not _has_priority_fk():
        op.create_foreign_key(
            PRIORITY_FK,
            "priority_snapshots",
            "prd_scopes",
            ["scope_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    if _has_priority_fk():
        op.drop_constraint(PRIORITY_FK, "priority_snapshots", type_="foreignkey")
    op.drop_index(op.f("ix_prd_scope_items_tenant_id"), table_name="prd_scope_items")
    op.drop_index(op.f("ix_prd_scope_items_scope_id"), table_name="prd_scope_items")
    op.drop_table("prd_scope_items")
    op.drop_index(op.f("ix_prd_scopes_tenant_id"), table_name="prd_scopes")
    op.drop_index("ix_prd_scopes_document", table_name="prd_scopes")
    op.drop_table("prd_scopes")
