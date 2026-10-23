"""Discussion rows in the Inbox (G6)

New table ``discussion_inbox_items``: one row per person invited into a discussion (by a
mention, or by the starter of a private one) and per message that mentions someone
already in it. ``done_at`` is set when they read past it (``POST
/v1/discussions/{id}/read``) or dismiss it; a removed participant's rows are deleted.
The "changes proposed" rows are derived on read and stored nowhere.

``stakeholder_questions`` gains ``discussion_id``: the discussion a question was asked
from (C2's ``ask_person``), nullable, set to NULL when the discussion is deleted.

Additive and live-safe: a new table, and one nullable column (a short lock, its wait
capped by LOCK_TIMEOUT). Nothing is backfilled.

The downgrade drops the table and the column: the Inbox goes back to its other rows.

Revision ID: 0030_discussion_inbox
Revises: 0029_discussion_replies
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030_discussion_inbox"
down_revision: str | None = "0029_discussion_replies"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
TABLE = "discussion_inbox_items"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        TABLE,
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("discussion_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("by_user_id", sa.Uuid(), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('invited', 'mentioned')", name=op.f("ck_discussion_inbox_items_kind")
        ),
        sa.ForeignKeyConstraint(
            ["discussion_id"],
            ["discussions.id"],
            name=op.f("fk_discussion_inbox_items_discussion_id_discussions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["discussion_messages.id"],
            name=op.f("fk_discussion_inbox_items_message_id_discussion_messages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_discussion_inbox_items_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_discussion_inbox_items_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discussion_inbox_items")),
    )
    op.create_index(op.f("ix_discussion_inbox_items_tenant_id"), TABLE, ["tenant_id"])
    op.create_index(
        "uq_discussion_inbox_invited",
        TABLE,
        ["user_id", "discussion_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'invited'"),
    )
    op.create_index(
        "uq_discussion_inbox_mentioned",
        TABLE,
        ["user_id", "message_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'mentioned'"),
    )
    op.create_index(
        "ix_discussion_inbox_open",
        TABLE,
        ["user_id"],
        postgresql_where=sa.text("done_at IS NULL"),
    )
    op.add_column(
        "stakeholder_questions",
        sa.Column("discussion_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_stakeholder_questions_discussion_id_discussions"),
        "stakeholder_questions",
        "discussions",
        ["discussion_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_constraint(
        op.f("fk_stakeholder_questions_discussion_id_discussions"),
        "stakeholder_questions",
        type_="foreignkey",
    )
    op.drop_column("stakeholder_questions", "discussion_id")
    op.drop_index("ix_discussion_inbox_open", table_name=TABLE)
    op.drop_index("uq_discussion_inbox_mentioned", table_name=TABLE)
    op.drop_index("uq_discussion_inbox_invited", table_name=TABLE)
    op.drop_index(op.f("ix_discussion_inbox_items_tenant_id"), table_name=TABLE)
    op.drop_table(TABLE)
