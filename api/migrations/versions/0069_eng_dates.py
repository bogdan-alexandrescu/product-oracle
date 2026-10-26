"""F4 Engineering review stop, lane B: the Engineering dates checkpoint kind

``ck_checkpoints_kind`` gains ``eng_dates`` through ``add_check_values``, keeping every
value other lanes added. The stop's staged choices are D8 actions, its review D4's store
and its bases F3's ``schedule_bases``: nothing else changes.

Live-safe: one check constraint replaced, no rewrite.

The downgrade refuses while any ``eng_dates`` checkpoint exists (cancel or finish those
runs first), then removes only that value.

Revision ID: 0069_eng_dates
Revises: 0068_intake_read
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0069_eng_dates"
down_revision: str | None = "0068_intake_read"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("checkpoints", "ck_checkpoints_kind", "kind")
KINDS = ("eng_dates",)


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    add_check_values(*KIND_CHECK, KINDS)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    used = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM checkpoints WHERE kind = 'eng_dates'")
    )
    if used:
        raise RuntimeError(
            f"{used} eng_dates checkpoint(s) exist: cancel or finish those runs before downgrading"
        )
    remove_check_values(*KIND_CHECK, KINDS)
