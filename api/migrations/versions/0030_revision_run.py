"""The run behind a baseline revision (B2 Baseline review from this run)

Additive. ``entity_revisions`` gains ``run_id``: the run whose write made the revision
(a run's baseline.yaml merge), so a run's changes can be told apart from its creator's own
edits. Null for history and for a person's edits.

Live-safe: adding a nullable column takes a short lock; the wait for it is capped
(LOCK_TIMEOUT). The index is built on a table that only grows by revisions.

The downgrade drops the column (and its index and foreign key).

Revision ID: 0030_revision_run
Revises: 0029_discussion_replies
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030_revision_run"
down_revision: str | None = "0029_discussion_replies"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("entity_revisions", sa.Column("run_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_entity_revisions_run_id_runs"),
        "entity_revisions",
        "runs",
        ["run_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(op.f("ix_entity_revisions_run_id"), "entity_revisions", ["run_id"])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_index(op.f("ix_entity_revisions_run_id"), table_name="entity_revisions")
    op.drop_constraint(
        op.f("fk_entity_revisions_run_id_runs"), "entity_revisions", type_="foreignkey"
    )
    op.drop_column("entity_revisions", "run_id")
