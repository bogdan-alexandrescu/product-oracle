"""C5 late answers: a feedback item made from an intake answer given after drafting

``feedback_items.intake_question_id`` and ``feedback_items.intake_answer_id``: an answer
given after the intake's draft run started becomes a whole-draft feedback item on the
PRD, linked back to its question and answer. The answer is unique: it makes one item.
Both nullable (every other item has none), no backfill: answers given before this
revision stay counted on the intake page only.

Live-safe: two nullable columns, no default, no rewrite; the unique constraint covers
the new column only, which is empty.

The downgrade drops both columns (the items stay, without their link).

Revision ID: 0055_late_answers
Revises: 0054_reply_opened
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0055_late_answers"
down_revision: str | None = "0054_reply_opened"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "feedback_items",
        sa.Column(
            "intake_question_id",
            sa.Uuid(),
            sa.ForeignKey(
                "stakeholder_questions.id",
                name="fk_feedback_items_intake_question_id_stakeholder_questions",
                ondelete="SET NULL",
            ),
            nullable=True,
        ),
    )
    op.add_column(
        "feedback_items",
        sa.Column(
            "intake_answer_id",
            sa.Uuid(),
            sa.ForeignKey(
                "stakeholder_answers.id",
                name="fk_feedback_items_intake_answer_id_stakeholder_answers",
                ondelete="SET NULL",
            ),
            nullable=True,
        ),
    )
    op.create_unique_constraint(
        "uq_feedback_items_intake_answer_id", "feedback_items", ["intake_answer_id"]
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_constraint("uq_feedback_items_intake_answer_id", "feedback_items", type_="unique")
    op.drop_column("feedback_items", "intake_answer_id")
    op.drop_column("feedback_items", "intake_question_id")
