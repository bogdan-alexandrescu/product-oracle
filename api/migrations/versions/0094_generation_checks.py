"""Quality checks on generated one-pagers and suggestions (oracle.simple.quality)

An answer that fails its checks twice is stored with them: ``simple_one_pagers.checks``
(and ``held``, the failing blocks, shown to owners only, while ``blocks`` keeps the last
good version) and ``simple_goal_suggestions.checks`` (a suggestion with checks is shown to
owners only). Null: it passed (or was built before the checks).

Revision ID: 0094_generation_checks
Revises: 0093_dont_know_open
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0094_generation_checks"
down_revision: str | None = "0093_dont_know_open"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("simple_one_pagers", sa.Column("checks", JSONB))
    op.add_column("simple_one_pagers", sa.Column("held", JSONB))
    op.add_column("simple_goal_suggestions", sa.Column("checks", JSONB))


def downgrade() -> None:
    op.drop_column("simple_goal_suggestions", "checks")
    op.drop_column("simple_one_pagers", "held")
    op.drop_column("simple_one_pagers", "checks")
