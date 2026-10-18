"""themes.slide_css: a company theme's own slide CSS (O1g)

Present mode and the deck PDF apply it after the shared slide layout. Null for built-in
themes, which keep their slide variants in code, and for company themes that use the
shared layout in their own colours and fonts.

Revision ID: 0011
Revises: 0010
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("themes", sa.Column("slide_css", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("themes", "slide_css")
