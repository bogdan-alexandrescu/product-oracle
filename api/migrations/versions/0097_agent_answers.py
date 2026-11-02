"""AQ1 Cards atop the review: answers to the questions a run's agents asked at a stop

``agent_answers``: one row per stop and question (its id in the segment's
``agent_questions.yaml``), with the option, an optional note, who and when. The downgrade
drops the table with every answer.

Revision ID: 0097_agent_answers
Revises: 0096_api_token_removed_at
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0097_agent_answers"
down_revision: str | None = "0096_api_token_removed_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

T = "agent_answers"


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.create_table(
        T,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("checkpoint_id", sa.Uuid(), nullable=False),
        sa.Column("question_key", sa.Text(), nullable=False),
        sa.Column("option", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("answered_by", sa.Uuid(), nullable=True),
        sa.Column(
            "answered_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"],
                                name=op.f(f"fk_{T}_tenant_id_tenants"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["checkpoint_id"], ["checkpoints.id"],
                                name=op.f(f"fk_{T}_checkpoint_id_checkpoints"),
                                ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{T}")),
        sa.UniqueConstraint("checkpoint_id", "question_key",
                            name=op.f(f"uq_{T}_checkpoint_id_question_key")),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{T}_tenant_id"), T, ["tenant_id"])
    op.create_index(op.f(f"ix_{T}_checkpoint_id"), T, ["checkpoint_id"])


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_table(T)
