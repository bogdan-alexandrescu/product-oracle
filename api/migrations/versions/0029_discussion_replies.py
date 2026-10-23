"""Oracle's live replies in a discussion (G2)

Additive. ``discussion_messages`` gains what an Oracle reply records: the model and its
accounting (owners read it; no screen shows cost), the stream's lease and a Stop
request, the attempts, the failure and its reason, the prompt it ran with, and a
pushback (C1b). Every column is nullable or has a default, so an old image keeps
writing people's messages.

Live-safe: adding nullable columns (and one with a constant default) takes a short lock;
the wait for it is capped (LOCK_TIMEOUT).

The downgrade drops the columns.

Revision ID: 0029_discussion_replies
Revises: 0028_tracker_links
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0029_discussion_replies"
down_revision: str | None = "0028_tracker_links"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"

COLUMNS = (
    ("model", sa.Text()),
    ("input_tokens", sa.Integer()),
    ("output_tokens", sa.Integer()),
    ("cost_usd", sa.Numeric(10, 4)),
    ("account_label", sa.Text()),
    ("llm_via", sa.Text()),
    ("error", sa.Text()),
    ("error_reason", sa.Text()),
    ("stream_lease_until", sa.DateTime(timezone=True)),
    ("cancel_requested_at", sa.DateTime(timezone=True)),
    ("prompt", sa.Text()),
    ("pushback", JSONB()),
)


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for name, type_ in COLUMNS:
        op.add_column("discussion_messages", sa.Column(name, type_, nullable=True))
    op.add_column(
        "discussion_messages",
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
    )
    # The tick finds replies nobody streams, and leases that ran out.
    op.create_index(
        "ix_discussion_messages_open_replies",
        "discussion_messages",
        ["status", "created_at"],
        postgresql_where=sa.text("status IN ('pending', 'streaming')"),
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_index("ix_discussion_messages_open_replies", table_name="discussion_messages")
    op.drop_column("discussion_messages", "attempts")
    for name, _type in reversed(COLUMNS):
        op.drop_column("discussion_messages", name)
