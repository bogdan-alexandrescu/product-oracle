"""Why a task's last push to the connected tracker failed (#1816, Nov 24)

- ``roadmap_item_tasks.tracker_push_error``: set when pushing the task to the tracker fails
  (shown on the task with Retry), cleared when a push succeeds.

The downgrade drops the column.

Revision ID: 0139_task_tracker_push_error
Revises: 0138_oauth_token_used_at
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0139_task_tracker_push_error"
down_revision: str | None = "0138_oauth_token_used_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("roadmap_item_tasks", sa.Column("tracker_push_error", sa.Text(), nullable=True))


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_column("roadmap_item_tasks", "tracker_push_error")
