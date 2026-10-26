"""Simple S3a (#723): the change engine's sessions and changes

``simple_sessions``: one person's editing session or a meeting's (at most one open
editing session per person); ``simple_changes``: every change made in Simple, applied,
proposed, accepted, declined or undone (an ``undone`` row reverses ``undoes_id``, at most
one per change). ``roadmap_items`` gains ``cut`` (cut in Simple, false by default). All
tenant-scoped like every table.

Live-safe: two new tables and a column with a constant default (no rewrite).

The downgrade drops the tables and the column (changes and Simple cuts are lost).

Revision ID: 0072_simple_changes
Revises: 0071_simple_roadmap_dates
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0072_simple_changes"
down_revision: str | None = "0071_simple_roadmap_dates"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KINDS = ("editing", "meeting")
STATUSES = ("applied", "proposed", "accepted", "declined", "undone")


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _base(table: str) -> list[sa.Column | sa.Constraint]:
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{table}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "roadmap_items",
        sa.Column("cut", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_table(
        "simple_sessions",
        *_base("simple_sessions"),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("started_by", sa.Uuid(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_change_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(_in("kind", KINDS), name=op.f("ck_simple_sessions_kind")),
    )
    op.create_index(op.f("ix_simple_sessions_tenant_id"), "simple_sessions", ["tenant_id"])
    op.create_index(
        "uq_simple_sessions_open_editing",
        "simple_sessions",
        ["started_by"],
        unique=True,
        postgresql_where=sa.text("kind = 'editing' AND closed_at IS NULL"),
    )
    op.create_table(
        "simple_changes",
        *_base("simple_changes"),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("op", sa.Text(), nullable=False),
        sa.Column("target", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("by", sa.Uuid(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("decision_reason", sa.Text(), nullable=True),
        sa.Column("routed_to", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("undoes_id", sa.Uuid(), nullable=True),
        sa.CheckConstraint(_in("status", STATUSES), name=op.f("ck_simple_changes_status")),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["simple_sessions.id"],
            name=op.f("fk_simple_changes_session_id_simple_sessions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_simple_changes_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["undoes_id"],
            ["simple_changes.id"],
            name=op.f("fk_simple_changes_undoes_id_simple_changes"),
            ondelete="CASCADE",
        ),
    )
    op.create_index(op.f("ix_simple_changes_tenant_id"), "simple_changes", ["tenant_id"])
    op.create_index(op.f("ix_simple_changes_session_id"), "simple_changes", ["session_id"])
    op.create_index(op.f("ix_simple_changes_by"), "simple_changes", ["by"])
    op.create_index("ix_simple_changes_document_at", "simple_changes", ["document_id", "at"])
    op.create_index(
        "uq_simple_changes_undoes",
        "simple_changes",
        ["undoes_id"],
        unique=True,
        postgresql_where=sa.text("undoes_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_table("simple_changes")
    op.drop_table("simple_sessions")
    op.drop_column("roadmap_items", "cut")
