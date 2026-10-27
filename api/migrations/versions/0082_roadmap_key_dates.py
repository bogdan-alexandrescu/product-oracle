"""Simple roadmap-plus (#723): a roadmap's key dates

``roadmap_key_dates``: each roadmap's published key dates (a name, a day and an optional
note: a conference, a product launch, a board meeting). Owners' and the decider's changes
wait in the roadmap's working draft (``simple_drafts.overlay["key_dates"]``) and are
written here when the draft's version is approved (oracle.simple.key_dates). Tenant-scoped
like every table.

Live-safe: a new table.

The downgrade drops it (the key dates are lost).

Revision ID: 0082_roadmap_key_dates
Revises: 0080_simple_one_pagers
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0082_roadmap_key_dates"
down_revision: str | None = "0081_simple_review_reminders"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
T = "roadmap_key_dates"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        T,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("roadmap_document_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("on_date", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{T}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["roadmap_document_id"],
            ["documents.id"],
            name=op.f(f"fk_{T}_roadmap_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{T}")),
    )
    op.create_index(op.f(f"ix_{T}_tenant_id"), T, ["tenant_id"])
    op.create_index(op.f(f"ix_{T}_roadmap_document_id"), T, ["roadmap_document_id"])


def downgrade() -> None:
    op.drop_table(T)
