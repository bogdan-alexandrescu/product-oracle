"""The usage poll's back-off after a 429 (run ticker review)

``claude_sweep_leases.usage_retry_at``: when Anthropic's usage endpoint answered 429,
the time its ``retry-after`` ends. No usage poll of that company's accounts starts
before it, across sweeps and API instances.

Re-chained on 0014_quality at the wave 1 integration (waves.md: 0014_* in merge order).

Revision ID: 0014_usage_retry_at
Revises: 0014_quality
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_usage_retry_at"
down_revision: str | None = "0014_quality"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "claude_sweep_leases",
        sa.Column("usage_retry_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("claude_sweep_leases", "usage_retry_at")
