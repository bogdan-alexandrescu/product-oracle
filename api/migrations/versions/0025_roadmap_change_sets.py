"""Roadmap change sets: edits to the approved plan, proposed as a new version (#346)

New table ``roadmap_change_sets`` (oracle.roadmap.models.RoadmapChangeSet): a draft set of
changes (add, move, defer, cut with a reason, reorder) opened on a roadmap's approved
version; proposing it imports the next roadmap version for the decider. A later proposal while one
waits supersedes it (``superseded_by_version_id``). A partial unique index keeps one draft
per roadmap.

Additive: a new table only, nothing backfilled. The downgrade drops it; proposed versions
stay as ordinary roadmap versions.

Revision ID: 0025_roadmap_change_sets
Revises: 0024_segment_skipped
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0025_roadmap_change_sets"
down_revision: str | None = "0024_segment_skipped"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "roadmap_change_sets"
INDEXED = (
    "tenant_id",
    "roadmap_document_id",
    "base_version_id",
    "proposed_version_id",
    "superseded_by_version_id",
)


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("roadmap_document_id", sa.Uuid(), nullable=False),
        sa.Column("base_version_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column(
            "changes", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("proposed_version_id", sa.Uuid(), nullable=True),
        sa.Column("superseded_by_version_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
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
            "status IN ('draft', 'proposed', 'discarded', 'superseded')",
            name=op.f("ck_roadmap_change_sets_status"),
        ),
        sa.ForeignKeyConstraint(
            ["roadmap_document_id"],
            ["documents.id"],
            name=op.f("fk_roadmap_change_sets_roadmap_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["base_version_id"],
            ["document_versions.id"],
            name=op.f("fk_roadmap_change_sets_base_version_id_document_versions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["proposed_version_id"],
            ["document_versions.id"],
            name=op.f("fk_roadmap_change_sets_proposed_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["superseded_by_version_id"],
            ["document_versions.id"],
            name=op.f("fk_roadmap_change_sets_superseded_by_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_roadmap_change_sets_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_roadmap_change_sets")),
    )
    for column in INDEXED:
        op.create_index(op.f(f"ix_{TABLE}_{column}"), TABLE, [column], unique=False)
    op.create_index(
        "ux_roadmap_change_sets_draft",
        TABLE,
        ["roadmap_document_id"],
        unique=True,
        postgresql_where=sa.text("status = 'draft'"),
    )


def downgrade() -> None:
    op.drop_index("ux_roadmap_change_sets_draft", table_name=TABLE)
    for column in INDEXED:
        op.drop_index(op.f(f"ix_{TABLE}_{column}"), table_name=TABLE)
    op.drop_table(TABLE)
