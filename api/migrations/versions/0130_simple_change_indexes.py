"""Indexes for Simple's slow reads (owner, Nov 11: "product oracle is loading so slowly")

- ``simple_changes (at, seq)``: the change history, newest first (GET /v1/simple/changes).
- ``simple_changes (document_id) WHERE status = 'proposed'``: the open proposals every Simple
  page counts per roadmap (oracle.simple.drafts.reader).
- ``simple_changes USING gin (draft_ids)``: the changes in the open drafts (drafts' counts and
  logs).
- ``simple_changes (op)``: the cuts Trash names who made (GET /v1/simple/removed). On the
  Simple reads seed (tests/simple_perf_helpers.py, 1,500 changes) the planner reads that
  query through it, 0.05 ms against a 0.70 ms sequential scan without it, and so do the
  questions' and tracks' open proposals and Trash's deleted items (EXPLAIN, speed review).

The 5 s lock_timeout is reset at the end: Alembic runs every pending migration in one
transaction, and a SET LOCAL would bind the ones after this.

Revision ID: 0130_simple_change_indexes
Revises: 0129_ritual_failed_at
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0130_simple_change_indexes"
down_revision: str | None = "0129_ritual_failed_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

T = "simple_changes"


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.create_index("ix_simple_changes_at_seq", T, ["at", "seq"])
    op.create_index(
        "ix_simple_changes_proposed",
        T,
        ["document_id"],
        postgresql_where=sa.text("status = 'proposed'"),
    )
    op.create_index("ix_simple_changes_draft_ids", T, ["draft_ids"], postgresql_using="gin")
    op.create_index("ix_simple_changes_op", T, ["op"])
    op.execute("RESET lock_timeout")


def downgrade() -> None:
    op.drop_index("ix_simple_changes_op", table_name=T)
    op.drop_index("ix_simple_changes_draft_ids", table_name=T)
    op.drop_index("ix_simple_changes_proposed", table_name=T)
    op.drop_index("ix_simple_changes_at_seq", table_name=T)
