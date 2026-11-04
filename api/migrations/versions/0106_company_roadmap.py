"""One company roadmap that every PRD feeds (one-roadmap-many-prds, owner Nov 4)

``documents.company_roadmap``: the company's one roadmap, at most one not in Trash (a
partial unique index); ``documents.replaced_by``: the PRDs that replace a PRD (ids, in
order), which makes it read-only. The downgrade drops them.

Revision ID: 0106_company_roadmap
Revises: 0105_goal_milestone_plan_date
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0106_company_roadmap"
down_revision: str | None = "0105_goal_milestone_plan_date"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column(
        "documents",
        sa.Column("company_roadmap", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "documents",
        sa.Column(
            "replaced_by",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default="{}",
        ),
    )
    op.create_index(
        "uq_documents_company_roadmap",
        "documents",
        ["tenant_id"],
        unique=True,
        postgresql_where=sa.text("company_roadmap AND deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_index("uq_documents_company_roadmap", table_name="documents")
    op.drop_column("documents", "replaced_by")
    op.drop_column("documents", "company_roadmap")
