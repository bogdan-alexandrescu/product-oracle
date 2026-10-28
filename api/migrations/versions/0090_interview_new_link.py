"""Make a new link (qa-work-43): an interview's link can be replaced.

- ``interviews.link_created_at``: when the current link was made (the members' page says
  so). Backfilled from the expiry, which is 7 days after it.
- ``interviews.replaced_link_hashes``: the sha256 of each link a new one replaced, so
  opening an old link says it was replaced (oracle.interviews.public); never the token.

The downgrade drops both columns.

Revision ID: 0090_interview_new_link
Revises: 0091_prd_questions
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0090_interview_new_link"
down_revision: str | None = "0091_prd_questions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("interviews", sa.Column("link_created_at", sa.DateTime(timezone=True)))
    op.add_column(
        "interviews",
        sa.Column(
            "replaced_link_hashes",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default="{}",
        ),
    )
    op.create_index(
        "ix_interviews_replaced_link_hashes",
        "interviews",
        ["replaced_link_hashes"],
        postgresql_using="gin",
    )
    op.execute(
        "UPDATE interviews SET link_created_at = link_expires_at - interval '7 days' "
        "WHERE link_token_hash IS NOT NULL AND link_expires_at IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_index("ix_interviews_replaced_link_hashes", table_name="interviews")
    op.drop_column("interviews", "replaced_link_hashes")
    op.drop_column("interviews", "link_created_at")
