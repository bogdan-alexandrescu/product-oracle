"""A source counts the saves that change its config, connection or name

A save that carries the version it loaded (``base_version``) is refused with 409 when
the source has changed since (owner 2026-10-20): an old tab cannot undo a narrowing.
Syncs and status updates do not bump it. Existing sources start at 1.

Revision ID: 0017_source_config_version
Revises: 0017_item_provenance
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017_source_config_version"
down_revision: str | None = "0017_item_provenance"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sources",
        sa.Column("config_version", sa.Integer(), nullable=False, server_default="1"),
    )


def downgrade() -> None:
    op.drop_column("sources", "config_version")
