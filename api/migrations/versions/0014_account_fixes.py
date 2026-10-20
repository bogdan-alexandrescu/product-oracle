"""Account management, review fixes: personal tokens expire; an overrun Resume is recorded

Additive. ``api_tokens`` gains ``expires_at`` (a personal token's expiry, chosen when it
is created: 30 days, 90 days, a year or never; NULL never expires, so existing tokens
behave as before). ``runs`` gains ``resumed_by``, ``resumed_at`` and
``resumed_from_ceiling_usd``: an overrun Resume is a spend approval (C2), and a
demotion or disable of the owner who gave it voids it while its next segment has not
been submitted, restoring the ceiling it replaced. No constraint is rebuilt.

The integrator re-chains this revision onto the head in merge order.

Revision ID: 0014_account_fixes
Revises: 0014_account_management
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_account_fixes"
down_revision: str | None = "0014_account_management"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("api_tokens", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("runs", sa.Column("resumed_by", sa.Uuid(), nullable=True))
    op.add_column("runs", sa.Column("resumed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("runs", sa.Column("resumed_from_ceiling_usd", sa.Numeric(12, 4), nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "resumed_from_ceiling_usd")
    op.drop_column("runs", "resumed_at")
    op.drop_column("runs", "resumed_by")
    op.drop_column("api_tokens", "expires_at")
