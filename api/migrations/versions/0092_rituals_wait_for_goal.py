"""Built-in rituals start paused until the first confirmed goal (owner decision
2026-10-29, "Start paused until goals").

- ``rituals.waits_for_goal``: a built-in on by default, seeded paused while the company
  had no confirmed goal; the first confirmed goal turns it on (oracle.rituals.service).
  Existing rows get false: a company's rituals are unchanged.

The downgrade drops the column.

Revision ID: 0092_rituals_wait_for_goal
Revises: 0090_interview_new_link
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0092_rituals_wait_for_goal"
down_revision: str | None = "0090_interview_new_link"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column(
        "rituals",
        sa.Column("waits_for_goal", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_column("rituals", "waits_for_goal")
