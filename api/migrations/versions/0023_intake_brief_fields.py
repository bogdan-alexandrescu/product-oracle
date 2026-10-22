"""C4 One New PRD door: the brief's goals, out-of-scope lines, template, theme and the
O1d answers on product_intakes.

Additive: every existing intake gets empty lists and answers and no template or theme.
The downgrade drops the five columns.

Revision ID: 0023_intake_brief_fields
Revises: 0022_updates
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0023_intake_brief_fields"
down_revision: str | None = "0022_updates"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "product_intakes",
        sa.Column("goal_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
    )
    op.add_column(
        "product_intakes",
        sa.Column("out_of_scope", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
    )
    op.add_column("product_intakes", sa.Column("draft_template", sa.Text(), nullable=True))
    op.add_column("product_intakes", sa.Column("draft_theme", sa.Text(), nullable=True))
    op.add_column(
        "product_intakes",
        sa.Column(
            "prd_answers",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
    )


def downgrade() -> None:
    for column in ("prd_answers", "draft_theme", "draft_template", "out_of_scope", "goal_ids"):
        op.drop_column("product_intakes", column)
