"""G2 §4 Research this, from inside a discussion

``discussion_messages.run_id``: the ``discussion_research`` run a message belongs to (the
line that says Oracle is researching, and the answer the run posts back), set null when
the run is deleted. The ``discussion_research`` flow joins ``runs.flow`` through
``oracle.migration_checks`` (other lanes' values survive).

Live-safe: one nullable column with no default and no rewrite, a partial index on it
(every existing row is null, so it is built at once), and a check widened.

Downgrade: deletes the research runs (their messages keep their text, ``run_id`` goes),
narrows the check and drops the column.

Revision ID: 0060_discussion_research
Revises: 0059_metric_errors_fixed
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0060_discussion_research"
down_revision: str | None = "0059_metric_errors_fixed"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
FLOW_CHECK = ("runs", "ck_runs_flow", "flow", ("discussion_research",))


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    add_check_values(*FLOW_CHECK)
    op.add_column(
        "discussion_messages",
        sa.Column(
            "run_id",
            sa.Uuid(),
            sa.ForeignKey(
                "runs.id",
                name=op.f("fk_discussion_messages_run_id_runs"),
                ondelete="SET NULL",
            ),
            nullable=True,
        ),
    )
    op.create_index(
        op.f("ix_discussion_messages_run_id"),
        "discussion_messages",
        ["run_id"],
        postgresql_where=sa.text("run_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_index(op.f("ix_discussion_messages_run_id"), table_name="discussion_messages")
    op.drop_column("discussion_messages", "run_id")
    op.execute("DELETE FROM runs WHERE flow = 'discussion_research'")
    remove_check_values(*FLOW_CHECK)
