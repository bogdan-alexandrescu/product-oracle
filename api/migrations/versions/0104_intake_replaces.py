"""A brief's PRD it replaces (new-prd-from-replaced-prd)

``product_intakes.replaces``: ``{"document_id", "area_name", "area_scope", "item_keys"}``,
the approved PRD a new PRD replaces and the area of it the new PRD covers; null for a
brief that replaces none.

Revision ID: 0104_intake_replaces
Revises: 0103_approved_roadmap_plan
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0104_intake_replaces"
down_revision: str | None = "0103_approved_roadmap_plan"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("product_intakes", sa.Column("replaces", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("product_intakes", "replaces")
