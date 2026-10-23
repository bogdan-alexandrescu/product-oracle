"""Invite message (#203 AC10): the owner's optional note to the invitee

``invites.message``: plain text, at most 500 characters, sent in the invite email and
again by Resend. Additive: existing invites have none.

The downgrade drops the column; open invites lose their message.

Revision ID: 0042_invite_message
Revises: 0041_subgoals
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0042_invite_message"
down_revision: str | None = "0041_subgoals"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("invites", sa.Column("message", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f("ck_invites_message_length"),
        "invites",
        "message IS NULL OR char_length(message) <= 500",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_invites_message_length"), "invites", type_="check")
    op.drop_column("invites", "message")
