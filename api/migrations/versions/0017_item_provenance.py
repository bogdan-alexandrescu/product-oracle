"""Items keep where in the selection they came from (S5, owner 2026-10-20)

Narrowing a source takes effect on save, with no provider call: a Fireflies meeting
records its meeting id and calendar series key, a Notion page the picked root it came
from, and the save deletes (soft) what the new picks do not cover. Backfilled from what
is stored: a Notion page's ``acl.root``, a Fireflies meeting's id (its series is not
stored, so it is unknown until a sync reads it again, and an item whose series is
unknown is deleted by a narrowing save unless its meeting is picked).

Chains on this branch's head, 0016_browse_calls (re-chained when merged).

Revision ID: 0017_item_provenance
Revises: 0016_browse_calls
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0017_item_provenance"
down_revision: str | None = "0016_browse_calls"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("source_items", sa.Column("provenance", postgresql.JSONB(astext_type=sa.Text())))
    op.execute(
        """
        UPDATE source_items si
           SET provenance = jsonb_build_object('root', si.acl ->> 'root')
          FROM sources s
         WHERE s.id = si.source_id AND s.kind = 'notion' AND si.acl ? 'root'
        """
    )
    op.execute(
        """
        UPDATE source_items si
           SET provenance = jsonb_build_object('meeting', si.external_id)
          FROM sources s
         WHERE s.id = si.source_id AND s.kind = 'fireflies'
        """
    )


def downgrade() -> None:
    op.drop_column("source_items", "provenance")
