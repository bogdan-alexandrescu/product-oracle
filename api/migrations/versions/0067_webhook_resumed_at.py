"""#642 review: when a webhook was last resumed

``webhooks.resumed_at``: set when a person resumes a paused webhook. A webhook's failing
count starts again there: it reads active until a delivery fails after the resume, and
the 72 hours before a failing pause run from the resume, not from the old failures.
Nullable, with no backfill: a webhook never resumed counts every failure, as before.

Live-safe: one nullable column, no default, no rewrite.

The downgrade drops the column (the resume marks go with it).

Revision ID: 0067_webhook_resumed_at
Revises: 0066_webhook_delivery_sent
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0067_webhook_resumed_at"
down_revision: str | None = "0066_webhook_delivery_sent"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("webhooks", sa.Column("resumed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("webhooks", "resumed_at")
