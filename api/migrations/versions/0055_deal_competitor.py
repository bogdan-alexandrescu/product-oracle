"""H9 x H7: a win or loss record linked to a market alternative

``deal_outcomes.competitor_id`` gains the foreign key to ``competitors`` that 0051_pricing
left for whichever of H7 and H9 landed second (ON DELETE SET NULL: an alternative is
archived, not deleted, but a removed one must not take its records with it), and an index
for Company › Market › Win and loss's filter by alternative.

Before the key, an id that names no alternative is cleared; none should exist, since the
API refused competitor_id until now.

Live-safe: deal_outcomes is small (one row per deal a person entered or imported).

The downgrade drops the key and the index and keeps the ids.

Revision ID: 0055_deal_competitor
Revises: 0054_reply_opened
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0055_deal_competitor"
down_revision: str | None = "0054_reply_opened"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute(
        "UPDATE deal_outcomes d SET competitor_id = NULL WHERE competitor_id IS NOT NULL "
        "AND NOT EXISTS (SELECT 1 FROM competitors c WHERE c.id = d.competitor_id)"
    )
    op.create_foreign_key(
        op.f("fk_deal_outcomes_competitor_id_competitors"),
        "deal_outcomes",
        "competitors",
        ["competitor_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_deal_outcomes_competitor_id", "deal_outcomes", ["competitor_id"])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_index("ix_deal_outcomes_competitor_id", table_name="deal_outcomes")
    op.drop_constraint(
        op.f("fk_deal_outcomes_competitor_id_competitors"), "deal_outcomes", type_="foreignkey"
    )
