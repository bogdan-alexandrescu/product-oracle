"""A request may be filed in the app (#329, New request)

Additive. ``ck_product_requests_channel`` also allows ``in_app``: a person files a request
with New request on the Requests screen. The check is extended with the additive helpers
(oracle.migration_checks), so values other lanes add to it survive.

Live-safe: dropping and recreating one check on ``product_requests`` takes a short lock;
the wait for it is capped (LOCK_TIMEOUT) so a busy table fails the migration instead of
queueing every request read behind it.

The downgrade records the in-app requests as Other (an old image reads them as a request
from elsewhere) and stops allowing the value.

Revision ID: 0027_request_in_app
Revises: 0026_staging
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0027_request_in_app"
down_revision: str | None = "0026_staging"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHANNEL_CHECK = ("product_requests", "ck_product_requests_channel", "channel")
CHANNELS = ("in_app",)
LOCK_TIMEOUT = "5s"


def _lock_timeout(value: str) -> str:
    """Set this transaction's lock wait; returns the one it replaces."""
    bind = op.get_bind()
    before = bind.scalar(sa.text("SELECT current_setting('lock_timeout')"))
    bind.execute(sa.text("SELECT set_config('lock_timeout', :t, true)"), {"t": value})
    return before


def upgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    add_check_values(*CHANNEL_CHECK, CHANNELS)
    _lock_timeout(before)


def downgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    op.execute("UPDATE product_requests SET channel = 'other' WHERE channel = 'in_app'")
    remove_check_values(*CHANNEL_CHECK, CHANNELS)
    _lock_timeout(before)
