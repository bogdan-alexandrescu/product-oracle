"""I1 Outbound webhooks, review of #637: where each delivery went and what it sent

``webhook_deliveries.host``: the host the delivery was sent to, so the log still shows
where past deliveries went after a webhook's URL changes. ``webhook_deliveries.headers``:
the headers sent, the signature truncated (spec-I1 "Delivery log"). Both nullable, with
no backfill: a delivery made before this revision shows neither.

Live-safe: two nullable columns, no default, no rewrite.

The downgrade drops both columns (the hosts and headers kept go with them).

Revision ID: 0056_webhook_delivery_sent
Revises: 0055_webhooks
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0056_webhook_delivery_sent"
down_revision: str | None = "0055_webhooks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("webhook_deliveries", sa.Column("host", sa.Text(), nullable=True))
    op.add_column(
        "webhook_deliveries",
        sa.Column("headers", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("webhook_deliveries", "headers")
    op.drop_column("webhook_deliveries", "host")
