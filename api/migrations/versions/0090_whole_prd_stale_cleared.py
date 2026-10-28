"""The walk-fixes-3 review (P11's stored rows): drop the earlier whole-PRD stale reason.

An earlier rule marked every roadmap item with no PRD section potentially stale when the
PRD got a new version, with the reason "the PRD has a new version (N)". Reads no longer
count it (oracle.roadmap.staleness.is_stale), but the rows stayed potentially_stale and
Detailed reads the stored freshness. This drops that reason from every item; an item left
with no reason of its own is fresh again. Data only.

The downgrade does nothing (the reason was never one of the item's own).

Revision ID: 0090_whole_prd_stale_cleared
Revises: 0089_ritual_attendees_edited_at
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0090_whole_prd_stale_cleared"
down_revision: str | None = "0089_ritual_attendees_edited_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WHOLE_PRD = r"^the PRD has a new version \(\d+\)$"

CLEAR = f"""
WITH cleared AS (
    SELECT id, ARRAY(
        SELECT r FROM unnest(stale_reasons) AS r WHERE r !~ '{_WHOLE_PRD}'
    ) AS own
    FROM roadmap_items
    WHERE freshness = 'potentially_stale'
      AND EXISTS (SELECT 1 FROM unnest(stale_reasons) AS r WHERE r ~ '{_WHOLE_PRD}')
)
UPDATE roadmap_items AS i
SET stale_reasons = cleared.own,
    freshness = CASE WHEN cardinality(cleared.own) = 0 THEN 'fresh' ELSE i.freshness END,
    stale_since = CASE WHEN cardinality(cleared.own) = 0 THEN NULL ELSE i.stale_since END,
    caused_by_change_id = CASE
        WHEN cardinality(cleared.own) = 0 THEN NULL ELSE i.caused_by_change_id
    END
FROM cleared
WHERE i.id = cleared.id
"""


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(CLEAR)


def downgrade() -> None:
    pass
