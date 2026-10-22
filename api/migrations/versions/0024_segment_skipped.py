"""A run segment may be skipped (C4 "Use the current baseline")

Additive. ``ck_run_segments_status`` also allows ``skipped``: the baseline segment of a
Baseline to PRD run that reused the current baseline (B1 "Reuse base") is recorded
skipped at no cost and never runs. The check is extended with the additive helpers
(oracle.migration_checks), so values other lanes add to it survive.

Live-safe: dropping and recreating one check on ``run_segments`` takes a short lock; the
wait for it is capped (LOCK_TIMEOUT) so a busy table fails the migration instead of
queueing every run read behind it.

The downgrade records the skipped segments as succeeded (an old image reads them as a
finished segment with no files) and stops allowing the value.

Revision ID: 0024_segment_skipped
Revises: 0023_intake_brief_fields
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0024_segment_skipped"
down_revision: str | None = "0023_intake_brief_fields"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_CHECK = ("run_segments", "ck_run_segments_status", "status")
STATUSES = ("skipped",)
LOCK_TIMEOUT = "5s"


def _lock_timeout(value: str) -> str:
    """Set this transaction's lock wait; returns the one it replaces."""
    bind = op.get_bind()
    before = bind.scalar(sa.text("SELECT current_setting('lock_timeout')"))
    bind.execute(sa.text("SELECT set_config('lock_timeout', :t, true)"), {"t": value})
    return before


def upgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    add_check_values(*STATUS_CHECK, STATUSES)
    _lock_timeout(before)


def downgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    op.execute("UPDATE run_segments SET status = 'succeeded' WHERE status = 'skipped'")
    remove_check_values(*STATUS_CHECK, STATUSES)
    _lock_timeout(before)
