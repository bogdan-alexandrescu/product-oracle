"""H4 Strategy and vision: the vision and strategy document kinds, the strategy stack in
the graph, and stored drift findings.

- ``vision`` and ``strategy`` join the document, template and theme kind checks;
- ``strategy_choice`` joins the entity types (one per focus or stop choice of an approved
  product strategy);
- the ``strategy_draft`` flow and its ``strategy_review`` checkpoint;
- ``strategy_findings``: drift findings, stored so that a waiver survives the next check,
  one per (kind, subject), a null subject included;
- ``strategy_checks``: one row per drift check (what the daily check is timed from, and
  how many findings each opened and resolved).

Every check is widened through ``oracle.migration_checks``, which reads the live values,
so no other lane's value is dropped.

The downgrade refuses while vision or strategy documents exist, unless
``ORACLE_DOWNGRADE_DROP_STRATEGY=1``: then it deletes them, their templates and themes,
strategy_draft runs, and strategy_choice entities (their edges by cascade; roadmap
dependencies on them keep their rows, their upstream nulled).

Revision ID: 0020_strategy
Revises: 0014_member_follow_up_retry
"""

import os
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0020_strategy"
down_revision: str | None = "0014_member_follow_up_retry"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS = ("vision", "strategy")
CHECKS = (
    ("documents", "ck_documents_kind", "kind", KINDS),
    ("templates", "ck_templates_kind", "kind", KINDS),
    ("themes", "ck_themes_kind", "kind", KINDS),
    ("entities", "ck_entities_type", "type", ("strategy_choice",)),
    ("runs", "ck_runs_flow", "flow", ("strategy_draft",)),
    ("checkpoints", "ck_checkpoints_kind", "kind", ("strategy_review",)),
)
FINDING_KINDS = (
    "goal_without_strategy",
    "focus_without_goal",
    "outside_strategy",
    "stopped_but_planned",
    "strategy_review_due",
    "vision_review_due",
    "no_strategy",
)


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _base_columns(table: str) -> list:
    return [
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name=op.f(f"fk_{table}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]  # fmt: skip


def upgrade() -> None:
    for table, name, column, values in CHECKS:
        add_check_values(table, name, column, values)

    now = sa.text("now()")
    op.create_table(
        "strategy_findings",
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column("subject_kind", sa.Text(), nullable=False),
        sa.Column("subject_id", sa.Uuid(), nullable=True),
        sa.Column("subject_ref", sa.Text(), nullable=False),
        # What the subject was when last seen: a waiver lasts until it changes.
        sa.Column("subject_version", sa.Text(), nullable=True),
        sa.Column("strategy_version_id", sa.Uuid(), nullable=True),
        sa.Column(
            "detail", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("waived_by", sa.Uuid(), nullable=True),
        sa.Column("waived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("waive_reason", sa.Text(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), server_default=now, nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=now, nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=now, nullable=False),
        *_base_columns("strategy_findings"),
        sa.CheckConstraint(_in("kind", FINDING_KINDS), name=op.f("ck_strategy_findings_kind")),
        sa.CheckConstraint(
            _in("severity", ("info", "warning", "high")), name=op.f("ck_strategy_findings_severity")
        ),
        sa.CheckConstraint(
            _in("subject_kind", ("entity", "roadmap_item", "document")),
            name=op.f("ck_strategy_findings_subject_kind"),
        ),
        sa.CheckConstraint(
            _in("status", ("open", "resolved", "waived")), name=op.f("ck_strategy_findings_status")
        ),
        sa.ForeignKeyConstraint(
            ["strategy_version_id"], ["document_versions.id"],
            name=op.f("fk_strategy_findings_strategy_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint(
            "tenant_id", "kind", "subject_kind", "subject_id",
            name=op.f("uq_strategy_findings_tenant_id_kind_subject_kind_subject_id"),
            postgresql_nulls_not_distinct=True,
        ),
    )  # fmt: skip
    op.create_index(
        op.f("ix_strategy_findings_tenant_id"), "strategy_findings", ["tenant_id"], unique=False
    )
    op.create_index(
        "ix_strategy_findings_status", "strategy_findings", ["tenant_id", "status"], unique=False
    )

    op.create_table(
        "strategy_checks",
        sa.Column("cause", sa.Text(), nullable=False),
        sa.Column("opened", sa.Integer(), server_default="0", nullable=False),
        sa.Column("resolved", sa.Integer(), server_default="0", nullable=False),
        *_base_columns("strategy_checks"),
    )
    op.create_index(
        op.f("ix_strategy_checks_tenant_id"), "strategy_checks", ["tenant_id"], unique=False
    )


def downgrade() -> None:
    bind = op.get_bind()
    documents = bind.scalar(
        sa.text("SELECT count(*) FROM documents WHERE kind IN ('vision', 'strategy')")
    )
    if documents and os.environ.get("ORACLE_DOWNGRADE_DROP_STRATEGY") != "1":
        raise RuntimeError(
            f"{documents} vision or strategy document(s) exist; the downgrade would delete "
            "them. Back up the database, then set ORACLE_DOWNGRADE_DROP_STRATEGY=1 to delete "
            "them and downgrade."
        )
    op.drop_table("strategy_checks")
    op.drop_table("strategy_findings")
    op.execute("DELETE FROM checkpoints WHERE kind = 'strategy_review'")
    op.execute("DELETE FROM runs WHERE flow = 'strategy_draft'")
    op.execute("DELETE FROM documents WHERE kind IN ('vision', 'strategy')")
    op.execute("DELETE FROM templates WHERE kind IN ('vision', 'strategy')")
    op.execute("DELETE FROM themes WHERE kind IN ('vision', 'strategy')")
    op.execute("DELETE FROM entities WHERE type = 'strategy_choice'")
    for table, name, column, values in reversed(CHECKS):
        remove_check_values(table, name, column, values)
