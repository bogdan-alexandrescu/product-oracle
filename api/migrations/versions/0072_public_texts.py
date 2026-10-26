"""O5 lane 2: the public-safe variant of a roadmap (spec-O5 §2)

- ``roadmap_public_texts``: one public text per (roadmap document, item key), so a text
  carries over between versions while its item exists. Oracle drafts (the ``public_text``
  job), a person approves or excludes each one;
- ``roadmap_public_checks``: a person's check of the exact Public page of one
  publication, with the item keys it showed and the hash of its content;
- ``documents.public_title`` and ``documents.public_intro``: the Public page's own title
  and intro (the internal title is never shown);
- ``public_text`` joins the ``llm_jobs`` kinds (widened through oracle.migration_checks).

Live-safe: new tables, two nullable columns, one check widened.

The downgrade deletes the ``public_text`` jobs and drops the tables and columns.

Revision ID: 0072_public_texts
Revises: 0071_roadmap_audience
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0072_public_texts"
down_revision: str | None = "0071_roadmap_audience"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
KINDS = ("public_text",)
TEXTS = "roadmap_public_texts"
CHECKS = "roadmap_public_checks"


def _fk(table: str, column: str, target: str, ondelete: str | None) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column], [f"{target}.id"], name=op.f(f"fk_{table}_{column}_{target}"), ondelete=ondelete
    )


def _base(table: str) -> list:
    return [
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        _fk(table, "tenant_id", "tenants", "CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]  # fmt: skip


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("documents", sa.Column("public_title", sa.Text(), nullable=True))
    op.add_column("documents", sa.Column("public_intro", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f("ck_documents_public_title"),
        "documents",
        "public_title IS NULL OR char_length(public_title) BETWEEN 1 AND 120",
    )
    op.create_check_constraint(
        op.f("ck_documents_public_intro"),
        "documents",
        "public_intro IS NULL OR char_length(public_intro) <= 600",
    )
    op.create_table(
        TEXTS,
        *_base(TEXTS),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("item_key", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column("stage", sa.Text(), nullable=False),
        sa.Column("announced_quarter", sa.Text(), nullable=True),
        sa.Column("changelog_url", sa.Text(), nullable=True),
        sa.Column("state", sa.Text(), server_default="draft", nullable=False),
        sa.Column("drafted_by", sa.Text(), nullable=False),
        sa.Column("approved_by", sa.Uuid(), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checked_warnings", postgresql.ARRAY(sa.Text()), server_default="{}",
                  nullable=False),
        sa.Column("source_hash", sa.Text(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 80", name=op.f(f"ck_{TEXTS}_title")),
        sa.CheckConstraint("char_length(description) <= 280",
                           name=op.f(f"ck_{TEXTS}_description")),
        sa.CheckConstraint("stage IN ('exploring', 'planned', 'in_progress', 'shipped')",
                           name=op.f(f"ck_{TEXTS}_stage")),
        sa.CheckConstraint("announced_quarter ~ '^[0-9]{4}-Q[1-4]$'",
                           name=op.f(f"ck_{TEXTS}_announced_quarter")),
        sa.CheckConstraint("state IN ('draft', 'approved', 'excluded')",
                           name=op.f(f"ck_{TEXTS}_state")),
        sa.CheckConstraint("state <> 'approved' OR approved_at IS NOT NULL",
                           name=op.f(f"ck_{TEXTS}_approved")),
        _fk(TEXTS, "document_id", "documents", "CASCADE"),
        sa.UniqueConstraint(
            "document_id", "item_key", name=op.f(f"uq_{TEXTS}_document_id_item_key")
        ),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{TEXTS}_tenant_id"), TEXTS, ["tenant_id"])
    op.create_table(
        CHECKS,
        *_base(CHECKS),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=False),
        sa.Column("publication_id", sa.Uuid(), nullable=False),
        sa.Column("checked_by", sa.Uuid(), nullable=False),
        sa.Column(
            "checked_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("shown_item_keys", postgresql.ARRAY(sa.Text()), server_default="{}",
                  nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        _fk(CHECKS, "document_id", "documents", "CASCADE"),
        _fk(CHECKS, "version_id", "document_versions", "CASCADE"),
        _fk(CHECKS, "publication_id", "document_publications", "CASCADE"),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{CHECKS}_tenant_id"), CHECKS, ["tenant_id"])
    op.create_index(
        "ix_roadmap_public_checks_publication", CHECKS, ["publication_id", "checked_at"]
    )
    add_check_values(*KIND_CHECK, KINDS)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM llm_jobs WHERE kind = 'public_text'")
    remove_check_values(*KIND_CHECK, KINDS)
    op.drop_table(CHECKS)
    op.drop_table(TEXTS)
    op.drop_constraint(op.f("ck_documents_public_intro"), "documents", type_="check")
    op.drop_constraint(op.f("ck_documents_public_title"), "documents", type_="check")
    op.drop_column("documents", "public_intro")
    op.drop_column("documents", "public_title")
