"""The shared draft decision of a pending checkpoint (D8)

Additive. ``checkpoint_actions`` holds one staged or suggested action per item, kind and
field of a checkpoint (``ux_checkpoint_actions_slot``; staging again replaces it), its
kinds the whole backlog's (``ck_checkpoint_actions_kind``: later specs add no migration for
it). ``checkpoints`` gains ``draft_note`` (nullable) and ``draft_revision`` (0 for existing
checkpoints: every draft write bumps it).

Live-safe: a new table, a nullable column and a column with a constant default are
catalog-only changes; nothing is backfilled.

The downgrade drops the table and both columns: staged drafts are lost; decisions already
made are not affected.

Revision ID: 0022_checkpoint_actions
Revises: 0022_code_maps
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022_checkpoint_actions"
down_revision: str | None = "0022_code_maps"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "checkpoint_actions"
# Frozen here as of this revision (oracle.runs.models.ACTION_KINDS, ACTION_STATES).
KINDS = (
    "accept",
    "edit",
    "drop",
    "restore",
    "split",
    "merge",
    "question",
    "waive",
    "look_again",
    "add",
)
STATES = ("staged", "suggested")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.add_column("checkpoints", sa.Column("draft_note", sa.Text(), nullable=True))
    op.add_column(
        "checkpoints",
        sa.Column("draft_revision", sa.Integer(), server_default="0", nullable=False),
    )
    op.create_table(
        TABLE,
        sa.Column("checkpoint_id", sa.Uuid(), nullable=False),
        sa.Column("item_key", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("field", sa.Text(), nullable=True),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("answers", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("state", sa.Text(), server_default="staged", nullable=False),
        sa.Column("question_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),  # fmt: skip
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),  # fmt: skip
        sa.CheckConstraint(_in("kind", KINDS), name=op.f(f"ck_{TABLE}_kind")),
        sa.CheckConstraint(_in("state", STATES), name=op.f(f"ck_{TABLE}_state")),
        sa.ForeignKeyConstraint(
            ["checkpoint_id"],
            ["checkpoints.id"],
            name=op.f(f"fk_{TABLE}_checkpoint_id_checkpoints"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["question_id"],
            ["stakeholder_questions.id"],
            name=op.f(f"fk_{TABLE}_question_id_stakeholder_questions"),
            ondelete="SET NULL",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{TABLE}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{TABLE}")),
    )
    op.create_index(op.f(f"ix_{TABLE}_checkpoint_id"), TABLE, ["checkpoint_id"], unique=False)
    op.create_index(op.f(f"ix_{TABLE}_tenant_id"), TABLE, ["tenant_id"], unique=False)
    op.create_index(
        "ux_checkpoint_actions_slot",
        TABLE,
        ["checkpoint_id", "item_key", "kind", sa.text("coalesce(field, '')")],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ux_checkpoint_actions_slot", table_name=TABLE)
    op.drop_index(op.f(f"ix_{TABLE}_tenant_id"), table_name=TABLE)
    op.drop_index(op.f(f"ix_{TABLE}_checkpoint_id"), table_name=TABLE)
    op.drop_table(TABLE)
    op.drop_column("checkpoints", "draft_revision")
    op.drop_column("checkpoints", "draft_note")
