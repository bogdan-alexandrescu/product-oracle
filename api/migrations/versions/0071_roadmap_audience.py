"""O5 lane 1: a roadmap's default audience (spec-O5 §1)

``documents.audience``: who a roadmap is read by first (board, team, engineering or
public), set from the picker's variant when the draft starts. Nullable, with no
backfill: a roadmap without one reads as ``team``. It only preselects; every reader may
switch audience (oracle.roadmap.variants).

Live-safe: one nullable column and a CHECK added NOT VALID, then validated (no rows hold
a value yet).

The downgrade drops the column.

Revision ID: 0071_roadmap_audience
Revises: 0070_brand_assets
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0071_roadmap_audience"
down_revision: str | None = "0070_brand_assets"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("documents", sa.Column("audience", sa.Text(), nullable=True))
    op.execute(
        "ALTER TABLE documents ADD CONSTRAINT ck_documents_audience "
        "CHECK (audience IN ('board', 'team', 'engineering', 'public')) NOT VALID"
    )
    op.execute("ALTER TABLE documents VALIDATE CONSTRAINT ck_documents_audience")


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("documents", "audience")
