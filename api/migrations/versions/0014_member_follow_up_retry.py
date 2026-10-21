"""A provider revoke a disable owes is retried for 24 hours, then shown to owners (C2)

Additive. ``member_follow_ups`` gains ``next_attempt_at`` (the tick retries a failed
call by time, with a backoff, for 24 hours from the disable, not a fixed number of
ticks), ``dismissed_at`` / ``dismissed_by`` (an owner dismissed it from the Inbox:
its copy of the credential is dropped) and the ``dismissed`` status. A ``failed``
follow-up is one still not done after the 24 hours: it keeps its copy of the
credential and stays in the owners' Inbox (Retry, Dismiss).

Rows a previous revision marked failed have already dropped their copy; they stay
failed and show in the Inbox, where an owner dismisses them.

The integrator re-chains this revision onto the head in merge order.

Revision ID: 0014_member_follow_up_retry
Revises: 0014_member_disable
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_member_follow_up_retry"
down_revision: str | None = "0014_member_disable"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STATUS = "ck_member_follow_ups_status"


def upgrade() -> None:
    op.add_column(
        "member_follow_ups",
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "member_follow_ups", sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("member_follow_ups", sa.Column("dismissed_by", sa.Uuid(), nullable=True))
    op.drop_constraint(op.f(_STATUS), "member_follow_ups", type_="check")
    op.create_check_constraint(
        op.f(_STATUS), "member_follow_ups", "status IN ('pending', 'done', 'failed', 'dismissed')"
    )


def downgrade() -> None:
    # A dismissed revoke was given up on, as a failed one was before this revision.
    op.execute("UPDATE member_follow_ups SET status = 'failed' WHERE status = 'dismissed'")
    op.drop_constraint(op.f(_STATUS), "member_follow_ups", type_="check")
    op.create_check_constraint(
        op.f(_STATUS), "member_follow_ups", "status IN ('pending', 'done', 'failed')"
    )
    op.drop_column("member_follow_ups", "dismissed_by")
    op.drop_column("member_follow_ups", "dismissed_at")
    op.drop_column("member_follow_ups", "next_attempt_at")
