"""#636 re-review: a late answer's feedback item withheld while its finding is not shared

``feedback_items.withheld_at``: set while a kept late-answer item withholds its quote (its
finding went back to private or to counts after someone acted on it). While it is set,
every output leaves out the text its suggestion took from the quote: the suggestion's
text, edited text and rationale, and its pushback reason. Cleared when the finding is
shared from summary up again.

Backfill: the items already kept with the withheld summary (late_answers.WITHHELD) get
their ``updated_at``.

Live-safe: one nullable column, no default, no rewrite; the backfill touches only items
made from late answers (0055), a handful.

The downgrade drops the column (the summary stays withheld; the suggestions read in full).

Revision ID: 0056_feedback_withheld
Revises: 0055_late_answers
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0056_feedback_withheld"
down_revision: str | None = "0055_late_answers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
# late_answers.WITHHELD when this revision was written.
WITHHELD = "Answered after drafting started (withheld while its finding is not shared in full)"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "feedback_items", sa.Column("withheld_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute(
        sa.text(
            "UPDATE feedback_items SET withheld_at = updated_at"
            " WHERE intake_answer_id IS NOT NULL AND summary = :withheld"
        ).bindparams(withheld=WITHHELD)
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("feedback_items", "withheld_at")
