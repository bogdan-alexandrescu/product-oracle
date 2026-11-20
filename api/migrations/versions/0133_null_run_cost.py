"""An unknown run or segment cost is null, not 0 (#1572)

``runs.spent_usd`` and ``run_segments.cost_usd`` were NOT NULL with a ``0`` default, so a
cost nobody reported read as "free". Both are nullable now, with no default: null until a
cost is reported. A stored 0 that was never reported becomes null: a pending or running
segment's (the run page said "Cost not reported yet"; a skipped one's 0 is known), and a
run's spend when none of its segments has a known cost. Reversible: the downgrade puts 0
back on nulls.

Revision ID: 0133_null_run_cost
Revises: 0132_roadmap_picked_quarter
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0133_null_run_cost"
down_revision: str | None = "0132_roadmap_picked_quarter"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = (("runs", "spent_usd"), ("run_segments", "cost_usd"))


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    for table, column in _COLUMNS:
        op.alter_column(table, column, nullable=True, server_default=None)
    op.execute(
        "UPDATE run_segments SET cost_usd = NULL "
        "WHERE cost_usd = 0 AND status IN ('pending', 'running')"
    )
    op.execute(
        "UPDATE runs SET spent_usd = NULL WHERE spent_usd = 0 AND NOT EXISTS ("
        "SELECT 1 FROM run_segments s WHERE s.run_id = runs.id AND s.cost_usd IS NOT NULL)"
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    for table, column in _COLUMNS:
        op.execute(f"UPDATE {table} SET {column} = 0 WHERE {column} IS NULL")
        op.alter_column(table, column, nullable=False, server_default="0")
