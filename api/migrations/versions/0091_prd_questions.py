"""prd-questions: a PRD's open questions as decisions (oracle.simple.questions).

- ``decisions.prd_question`` (the PRD's code, recommendation, what it blocks) and
  ``decisions.due_on``; ``prd`` joins the decisions' origins.
- ``prd_questions`` joins the ``llm_jobs`` kinds.

The downgrade drops the PRD's questions, the columns and both values.

Revision ID: 0091_prd_questions
Revises: 0090_whole_prd_stale_cleared
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0091_prd_questions"
down_revision: str | None = "0090_whole_prd_stale_cleared"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
ORIGIN_CHECK = ("decisions", "ck_decisions_origin", "origin")


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("decisions", sa.Column("prd_question", postgresql.JSONB(), nullable=True))
    op.add_column("decisions", sa.Column("due_on", sa.Date(), nullable=True))
    add_check_values(*ORIGIN_CHECK, ("prd",))
    add_check_values(*KIND_CHECK, ("prd_questions",))


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("DELETE FROM llm_jobs WHERE kind = 'prd_questions'")
    remove_check_values(*KIND_CHECK, ("prd_questions",))
    op.execute("DELETE FROM decisions WHERE origin = 'prd'")
    remove_check_values(*ORIGIN_CHECK, ("prd",))
    op.drop_column("decisions", "due_on")
    op.drop_column("decisions", "prd_question")
