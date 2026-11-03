"""What connection a source lost (source-relink, owner Nov 3)

``sources.lost_provider`` and ``sources.lost_account_id``: the provider and account of
the connection a Disconnect deleted (``connection_id`` is set null). The same person
connecting that account again links the source to the new connection by itself; picking
a connection, or that link, clears them. Sources that lost their connection before this
keep none: they are linked by picking a connection on their card.

Revision ID: 0100_source_lost_connection
Revises: 0099_meeting_joined_ids
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0100_source_lost_connection"
down_revision: str | None = "0099_meeting_joined_ids"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sources", sa.Column("lost_provider", sa.Text(), nullable=True))
    op.add_column("sources", sa.Column("lost_account_id", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("sources", "lost_account_id")
    op.drop_column("sources", "lost_provider")
