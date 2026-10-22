"""What happened to an invite: its IAP access and its email (#242, A5)

Additive. ``invites`` gains:

- ``access``: ``granted`` (the invitee holds ``roles/iap.httpsResourceAccessor`` on
  Oracle's backend services), ``pending`` (not granted yet: the grant failed, or the
  invite predates this revision; the Members page offers Retry) or ``skipped`` (no
  backend services configured: local and dev), with ``access_error`` (why it is still
  pending) and ``access_at`` (the last attempt);
- ``email_status``: ``queued`` (a background send owes it), ``sent``, ``failed`` (after
  its one retry) or ``not_sent`` (no sender configured), with ``email_error`` and
  ``email_at`` (when it got that status).

``member_follow_ups`` gains two kinds, ``iap_revoke`` and ``iap_grant`` (an IAP access
change that failed, retried by the tick), and ``email`` (the address it is for).

Live-safe: the two NOT NULL columns have constant server defaults (a catalog-only
change in Postgres 11+); existing invites read ``pending`` and ``not_sent``.

The downgrade drops the columns, and the IAP follow-ups with the kinds.

Revision ID: 0022_invite_delivery
Revises: 0021_feedback_agent_staging
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022_invite_delivery"
down_revision: str | None = "0021_feedback_agent_staging"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "invites", sa.Column("access", sa.Text(), nullable=False, server_default="pending")
    )
    op.add_column("invites", sa.Column("access_error", sa.Text(), nullable=True))
    op.add_column("invites", sa.Column("access_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "invites", sa.Column("email_status", sa.Text(), nullable=False, server_default="not_sent")
    )
    op.add_column("invites", sa.Column("email_error", sa.Text(), nullable=True))
    op.add_column("invites", sa.Column("email_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        op.f("ck_invites_access"), "invites", "access IN ('granted', 'pending', 'skipped')"
    )
    op.create_check_constraint(
        op.f("ck_invites_email_status"),
        "invites",
        "email_status IN ('queued', 'sent', 'failed', 'not_sent')",
    )
    op.add_column("member_follow_ups", sa.Column("email", sa.Text(), nullable=True))
    op.drop_constraint(op.f("ck_member_follow_ups_kind"), "member_follow_ups", type_="check")
    op.create_check_constraint(
        op.f("ck_member_follow_ups_kind"),
        "member_follow_ups",
        "kind IN ('provider_revoke', 'run_cancel', 'iap_revoke', 'iap_grant')",
    )


COLUMNS = ("email_at", "email_error", "email_status", "access_at", "access_error", "access")


def downgrade() -> None:
    op.execute("DELETE FROM member_follow_ups WHERE kind IN ('iap_revoke', 'iap_grant')")
    op.drop_constraint(op.f("ck_member_follow_ups_kind"), "member_follow_ups", type_="check")
    op.create_check_constraint(
        op.f("ck_member_follow_ups_kind"),
        "member_follow_ups",
        "kind IN ('provider_revoke', 'run_cancel')",
    )
    op.drop_column("member_follow_ups", "email")
    op.drop_constraint(op.f("ck_invites_email_status"), "invites", type_="check")
    op.drop_constraint(op.f("ck_invites_access"), "invites", type_="check")
    for column in COLUMNS:
        op.drop_column("invites", column)
