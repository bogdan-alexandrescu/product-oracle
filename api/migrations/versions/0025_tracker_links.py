"""Tracker records linked to synced GitHub issues (F7 Link tracker issues)

Additive. ``tracker_records`` gains the PRD a record is matched to (an item of a roadmap
with no track yet is matched by PRD and item key), the synced source item it was linked
from and is refreshed from, who linked it and when, and when its source went away
(``refresh_lost_at``). Backfill: each record on a track gets its track's PRD.

Live-safe: nullable columns with no default and two indexes on a small table.

The downgrade drops the five columns and the two indexes; linked records stay as ordinary
tracker records with their track and item key.

Revision ID: 0025_tracker_links
Revises: 0024_segment_skipped
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025_tracker_links"
down_revision: str | None = "0024_segment_skipped"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for column, table in (("prd_document_id", "documents"), ("source_item_id", "source_items")):
        op.add_column("tracker_records", sa.Column(column, sa.Uuid(), nullable=True))
        op.create_foreign_key(
            f"fk_tracker_records_{column}_{table}",
            "tracker_records",
            table,
            [column],
            ["id"],
            ondelete="SET NULL",
        )
    op.add_column("tracker_records", sa.Column("linked_by", sa.Uuid(), nullable=True))
    op.add_column(
        "tracker_records", sa.Column("linked_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "tracker_records",
        sa.Column("refresh_lost_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_tracker_records_prd_item",
        "tracker_records",
        ["tenant_id", "prd_document_id", "item_key"],
    )
    op.create_index("ix_tracker_records_source_item", "tracker_records", ["source_item_id"])
    op.execute(
        "UPDATE tracker_records r SET prd_document_id = t.prd_document_id "
        "FROM product_tracks t WHERE r.track_id = t.id AND r.prd_document_id IS NULL"
    )


def downgrade() -> None:
    op.drop_index("ix_tracker_records_source_item", table_name="tracker_records")
    op.drop_index("ix_tracker_records_prd_item", table_name="tracker_records")
    for column in ("refresh_lost_at", "linked_at", "linked_by"):
        op.drop_column("tracker_records", column)
    for column, table in (("prd_document_id", "documents"), ("source_item_id", "source_items")):
        op.drop_constraint(
            f"fk_tracker_records_{column}_{table}", "tracker_records", type_="foreignkey"
        )
        op.drop_column("tracker_records", column)
