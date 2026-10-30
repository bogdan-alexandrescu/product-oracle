"""An "I don't know" answer leaves its brief question open (owner 2026-10-29, qa-work-2)

Data only, no schema change. A question whose latest answer is "I don't know" was set
``answered``; it now stays open until someone gives a real answer
(oracle.intake.answers.EFFECTS). This reopens those questions so every count agrees:
``delegated`` if it was delegated before, else ``asked``; on an archived brief it is
``retired`` as the brief's other open questions are (0033). Idempotent: a second run
matches no row.

The downgrade marks them answered again, as an old image counts them, the retired ones
too (an old image never retires an answered question).

Revision ID: 0093_dont_know_open
Revises: 0093_meeting_comments_as_notes
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0093_dont_know_open"
down_revision: str | None = "0093_meeting_comments_as_notes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The latest answer of each question.
LATEST = """
SELECT DISTINCT ON (question_id) question_id, kind
FROM stakeholder_answers
ORDER BY question_id, created_at DESC, id DESC
"""
REOPEN = f"""
UPDATE stakeholder_questions q SET updated_at = now(), status = CASE
    WHEN i.status = 'archived' THEN 'retired'
    WHEN EXISTS (
        SELECT 1 FROM stakeholder_answers d WHERE d.question_id = q.id AND d.kind = 'delegate'
    ) THEN 'delegated'
    ELSE 'asked' END
FROM ({LATEST}) latest, product_intakes i
WHERE latest.question_id = q.id AND latest.kind = 'dont_know'
  AND q.intake_id = i.id AND q.status = 'answered'
"""
CLOSE = f"""
UPDATE stakeholder_questions q SET status = 'answered', updated_at = now()
FROM ({LATEST}) latest
WHERE latest.question_id = q.id AND latest.kind = 'dont_know'
  AND q.intake_id IS NOT NULL AND q.status IN ('asked', 'delegated', 'retired')
"""


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(REOPEN)


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(CLOSE)
