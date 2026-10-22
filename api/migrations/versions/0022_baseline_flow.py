"""The Build the baseline flow (B1)

Additive. ``ck_runs_flow`` also allows ``baseline``: one segment, the baseline segment of
Baseline to PRD, writing no document. The check is extended with the additive helpers
(oracle.migration_checks), so values other lanes add to it survive.

Live-safe: dropping and recreating one check on ``runs`` takes a short lock; the wait
for it is capped (LOCK_TIMEOUT) so a busy table fails the migration instead of queueing
every run read behind it.

The downgrade deletes the ``baseline`` runs (their segments and checkpoints go with them;
entities, edges and proposals they wrote stay, their run_id set to null) and stops
allowing the value.

Revision ID: 0022_baseline_flow
Revises: 0022_invite_delivery
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0022_baseline_flow"
down_revision: str | None = "0022_invite_delivery"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FLOW_CHECK = ("runs", "ck_runs_flow", "flow")
FLOWS = ("baseline",)
LOCK_TIMEOUT = "5s"


def _lock_timeout(value: str) -> str:
    """Set this transaction's lock wait; returns the one it replaces."""
    bind = op.get_bind()
    before = bind.scalar(sa.text("SELECT current_setting('lock_timeout')"))
    bind.execute(sa.text("SELECT set_config('lock_timeout', :t, true)"), {"t": value})
    return before


def upgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    add_check_values(*FLOW_CHECK, FLOWS)
    _lock_timeout(before)


def downgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    op.execute("DELETE FROM runs WHERE flow = 'baseline'")
    remove_check_values(*FLOW_CHECK, FLOWS)
    _lock_timeout(before)
