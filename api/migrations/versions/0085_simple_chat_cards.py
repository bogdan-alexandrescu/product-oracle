"""Simple S9 (#723): change by chat.

- ``simple_chat_cards``: the change cards Oracle answers a chat request with (in a
  meeting's thread or a person's Ask panel), each the exact change-engine op it would
  make; nothing is written until an allowed person applies it (oracle.simple.chat).

The downgrade drops the table.

Revision ID: 0085_simple_chat_cards
Revises: 0080_simple_one_pagers
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0085_simple_chat_cards"
down_revision: str | None = "0084_simple_visuals"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
T = "simple_chat_cards"


def _fk(col: str, table: str, ondelete: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [col], [f"{table}.id"], name=op.f(f"fk_{T}_{col}_{table}"), ondelete=ondelete
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        T,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("discussion_id", sa.Uuid(), nullable=True),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("meeting_id", sa.Uuid(), nullable=True),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("op", sa.Text(), nullable=False),
        sa.Column("target", postgresql.JSONB(), nullable=False),
        sa.Column("before", postgresql.JSONB(), nullable=False),
        sa.Column("after", postgresql.JSONB(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=True),
        sa.Column("preview", postgresql.JSONB(), nullable=True),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("change_id", sa.Uuid(), nullable=True),
        sa.Column("decision_id", sa.Uuid(), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('open', 'applied', 'proposed', 'discarded', 'undone')",
            name=op.f(f"ck_{T}_status"),
        ),
        _fk("tenant_id", "tenants", "CASCADE"),
        _fk("discussion_id", "discussions", "CASCADE"),
        _fk("message_id", "discussion_messages", "CASCADE"),
        _fk("change_id", "simple_changes", "SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{T}")),
    )
    op.create_index(op.f(f"ix_{T}_tenant_id"), T, ["tenant_id"])
    op.create_index(op.f(f"ix_{T}_discussion_id"), T, ["discussion_id"])
    op.create_index(op.f(f"ix_{T}_meeting_id"), T, ["meeting_id"])
    op.create_index("ix_simple_chat_cards_message", T, ["message_id"])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_table(T)
