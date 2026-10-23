"""A question may be retired: archiving a brief retires its open questions (#307)

Additive. ``ck_stakeholder_questions_status`` also allows ``retired``: an archived brief's
asked or delegated questions leave the Inbox and stay on the brief as history; restoring
the brief asks them again. The check is extended with the additive helpers
(oracle.migration_checks), so values other lanes add to it survive.

One-off data fix: the open questions of briefs archived before this are retired
(:data:`RETIRE_ARCHIVED`, idempotent: a second run matches no row).

Live-safe: dropping and recreating one check on ``stakeholder_questions`` takes a short
lock; the wait for it is capped (LOCK_TIMEOUT) so a busy table fails the migration
instead of queueing every Inbox read behind it.

The downgrade asks the retired questions again (an old image has no such status) and
stops allowing the value.

Revision ID: 0033_question_retired
Revises: 0032_interviews
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0033_question_retired"
down_revision: str | None = "0032_interviews"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_CHECK = ("stakeholder_questions", "ck_stakeholder_questions_status", "status")
STATUSES = ("retired",)
LOCK_TIMEOUT = "5s"
# The open questions (oracle.intake.questions.OPEN) of archived briefs.
RETIRE_ARCHIVED = """
UPDATE stakeholder_questions q SET status = 'retired', updated_at = now()
FROM product_intakes i
WHERE q.intake_id = i.id AND i.status = 'archived' AND q.status IN ('asked', 'delegated')
"""


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
    op.execute(RETIRE_ARCHIVED)


def downgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    op.execute("UPDATE stakeholder_questions SET status = 'asked' WHERE status = 'retired'")
    remove_check_values(*STATUS_CHECK, STATUSES)
    _lock_timeout(before)
