"""Sources may need attention: a selection a newer rule refuses (S5, owner 2026-10-20)

A source saved before a rule existed (more than 100 Slack channels, a date outside the
accepted range) is no longer synced until its owner edits it; it shows as needing
attention instead of failing every sync.

Revision ID: 0016_source_needs_attention
Revises: 0014_blockers_snapshot
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0016_source_needs_attention"
down_revision: str | None = "0014_blockers_snapshot"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_sources_status"), "sources", type_="check")
    op.create_check_constraint(
        op.f("ck_sources_status"),
        "sources",
        "status IN ('active', 'paused', 'error', 'needs_attention')",
    )


def downgrade() -> None:
    op.execute("UPDATE sources SET status = 'error' WHERE status = 'needs_attention'")
    op.drop_constraint(op.f("ck_sources_status"), "sources", type_="check")
    op.create_check_constraint(
        op.f("ck_sources_status"), "sources", "status IN ('active', 'paused', 'error')"
    )
