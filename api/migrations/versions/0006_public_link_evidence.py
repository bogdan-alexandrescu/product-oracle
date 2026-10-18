"""Public-link evidence

The owner, 2026-10-17: commenters can attach evidence from public links (public Notion
pages, Google Docs shared with anyone with the link, plain public web pages) without
connecting an account. ``evidence.kind`` (``notion | google_docs | web``, null for
evidence from a source item or free-standing) says how such evidence is scored;
``evidence_link_snapshots`` keeps each fetch of the page (title, text, fetched_at,
last_modified), the newest being current; ``evidence.note`` says why it is cited.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-18 01:15:22.832587
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "evidence_link_snapshots",
        sa.Column("evidence_id", sa.Uuid(), nullable=False),
        sa.Column("final_url", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_modified", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fetched_by", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["evidence_id"],
            ["evidence.id"],
            name=op.f("fk_evidence_link_snapshots_evidence_id_evidence"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_evidence_link_snapshots_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_evidence_link_snapshots")),
    )
    op.create_index(
        op.f("ix_evidence_link_snapshots_evidence_id"),
        "evidence_link_snapshots",
        ["evidence_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_evidence_link_snapshots_tenant_id"),
        "evidence_link_snapshots",
        ["tenant_id"],
        unique=False,
    )
    op.add_column("evidence", sa.Column("kind", sa.Text(), nullable=True))
    op.add_column("evidence", sa.Column("note", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f("ck_evidence_kind"),
        "evidence",
        "kind IS NULL OR kind IN ('notion', 'google_docs', 'web')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_evidence_kind"), "evidence", type_="check")
    op.drop_column("evidence", "note")
    op.drop_column("evidence", "kind")
    op.drop_index(
        op.f("ix_evidence_link_snapshots_tenant_id"), table_name="evidence_link_snapshots"
    )
    op.drop_index(
        op.f("ix_evidence_link_snapshots_evidence_id"), table_name="evidence_link_snapshots"
    )
    op.drop_table("evidence_link_snapshots")
