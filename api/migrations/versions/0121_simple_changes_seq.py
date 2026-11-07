"""Simple changes keep the order they were made in (qaC-numfix)

``simple_changes`` gains ``seq``: every list of changes (a draft's changes and the
one-pager's number fixes, GET /v1/simple/changes, the Inbox, proposals) breaks a tie on
``at`` by it, not by the random id.

The column is added nullable with no default (no table rewrite), the changes already
stored are numbered by (at, id) (the order lists showed them in before), and only then does
it take its default from a sequence that starts after the highest number, and NOT NULL.
It all runs in one transaction: ADD COLUMN takes the table's ACCESS EXCLUSIVE lock and it is
held to the commit, so reads and writes of simple_changes wait through the backfill (one
UPDATE) and the NOT NULL scan. The wait for the lock is capped (LOCK_TIMEOUT). The
downgrade drops the column and its sequence.

Revision ID: 0121_simple_changes_seq
Revises: 0120_feature_parts
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0121_simple_changes_seq"
down_revision: str | None = "0120_feature_parts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
SEQ = "simple_changes_seq_seq"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("simple_changes", sa.Column("seq", sa.BigInteger(), nullable=True))
    op.execute(
        "UPDATE simple_changes c SET seq = o.n FROM ("
        "SELECT id, row_number() OVER (ORDER BY at, id) AS n FROM simple_changes"
        ") o WHERE c.id = o.id"
    )
    op.execute(f"CREATE SEQUENCE {SEQ} AS bigint OWNED BY simple_changes.seq")
    op.execute(f"SELECT setval('{SEQ}', coalesce(max(seq), 0) + 1, false) FROM simple_changes")
    op.execute(f"ALTER TABLE simple_changes ALTER COLUMN seq SET DEFAULT nextval('{SEQ}')")
    op.alter_column("simple_changes", "seq", nullable=False)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    # The sequence is owned by the column: it goes with it.
    op.drop_column("simple_changes", "seq")
