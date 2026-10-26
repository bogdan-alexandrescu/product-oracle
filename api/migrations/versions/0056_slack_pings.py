"""Slack pings (C1, G8 §4): the Slack outbox also carries a ping to one member

``slack_outbox`` gains ``recipient_id`` (the member a ping is for) and the op ``ping``; a
ping has no mirrored thread, so ``link_id`` becomes nullable, and a check keeps every other
op tied to its thread. Which pings a member gets is their ``slack_pings`` preference
(``user_preferences``, no schema change).

Live-safe: one nullable column, a dropped NOT NULL, and checks every existing row passes
(each has a link and no recipient); the wait for a lock is capped (LOCK_TIMEOUT).

The downgrade deletes the pings, then restores the columns and checks.

Revision ID: 0056_slack_pings
Revises: 0055_deal_competitor
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0056_slack_pings"
down_revision: str | None = "0055_deal_competitor"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
TARGET = (
    "(op = 'ping' AND link_id IS NULL AND recipient_id IS NOT NULL)"
    " OR (op <> 'ping' AND link_id IS NOT NULL AND recipient_id IS NULL)"
)


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("slack_outbox", sa.Column("recipient_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_slack_outbox_recipient_id_users"), "slack_outbox", "users",
        ["recipient_id"], ["id"], ondelete="CASCADE",
    )  # fmt: skip
    op.alter_column("slack_outbox", "link_id", nullable=True)
    add_check_values("slack_outbox", "ck_slack_outbox_op", "op", ("ping",))
    op.create_check_constraint(op.f("ck_slack_outbox_target"), "slack_outbox", TARGET)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM slack_outbox WHERE op = 'ping'")
    op.drop_constraint(op.f("ck_slack_outbox_target"), "slack_outbox", type_="check")
    remove_check_values("slack_outbox", "ck_slack_outbox_op", "op", ("ping",))
    op.alter_column("slack_outbox", "link_id", nullable=False)
    op.drop_constraint(op.f("fk_slack_outbox_recipient_id_users"), "slack_outbox")
    op.drop_column("slack_outbox", "recipient_id")
