"""Comments on a feature (#1553)

- ``feature_comments``: one row per comment a person left on a feature in its panel, on the
  feature's roadmap and ``item_key`` (so on every row of it, in every version, and back from
  Trash with it). ``deleted_at`` hides a deleted one.

The downgrade drops the table.

Revision ID: 0134_feature_comments
Revises: 0133_null_run_cost
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0134_feature_comments"
down_revision: str | None = "0133_null_run_cost"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

T = "feature_comments"


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.create_table(
        T,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("roadmap_document_id", sa.Uuid(), nullable=False),
        sa.Column("item_key", sa.Text(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_feature_comments")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE",
                                name=op.f("fk_feature_comments_tenant_id_tenants")),
        sa.ForeignKeyConstraint(["roadmap_document_id"], ["documents.id"], ondelete="CASCADE",
                                name=op.f("fk_feature_comments_roadmap_document_id_documents")),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{T}_tenant_id"), T, ["tenant_id"])
    op.create_index("ix_feature_comments_feature", T, ["roadmap_document_id", "item_key"])


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_table(T)
