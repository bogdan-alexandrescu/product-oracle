"""Simple S5 (#723): one-pagers.

- ``simple_one_pagers``: one built one-pager per PRD version and hash of its mapped
  sections (oracle.simple.one_pager): its blocks and lines, each line with its source
  section keys; rebuilt (a new row) when a mapped section changes.
- ``one_pager`` joins the ``llm_jobs`` kinds (widened through oracle.migration_checks).

The downgrade deletes the ``one_pager`` jobs and drops the table.

Revision ID: 0079_simple_one_pagers
Revises: 0078_simple_drafts
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0079_simple_one_pagers"
down_revision: str | None = "0078_simple_drafts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    t = "simple_one_pagers"
    op.create_table(
        t,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=False),
        sa.Column("sections_hash", sa.Text(), nullable=False),
        sa.Column("blocks", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("built_by", sa.Text(), server_default="extract", nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column(
            "built_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "built_by IN ('extract', 'oracle')", name=op.f("ck_simple_one_pagers_built_by")
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_simple_one_pagers_tenant_id_tenants"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_simple_one_pagers_document_id_documents"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["document_versions.id"],
            name=op.f("fk_simple_one_pagers_version_id_document_versions"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.PrimaryKeyConstraint("id", name=op.f("pk_simple_one_pagers")),
        sa.UniqueConstraint(
            "version_id",
            "sections_hash",
            name=op.f("uq_simple_one_pagers_version_id_sections_hash"),
        ),
    )
    op.create_index(op.f("ix_simple_one_pagers_tenant_id"), t, ["tenant_id"])
    op.create_index(op.f("ix_simple_one_pagers_document_id"), t, ["document_id"])
    add_check_values(*KIND_CHECK, ("one_pager",))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM llm_jobs WHERE kind = 'one_pager'")
    remove_check_values(*KIND_CHECK, ("one_pager",))
    op.drop_table("simple_one_pagers")
