"""Which Claude account a pool account is (#405)

Additive. ``claude_accounts`` gains ``claude_email`` and ``claude_organization``: the
Claude account the credential is for, as the token endpoint reports it at sign-in.
Both nullable (not reported, and every existing row), so an old image keeps writing.

Live-safe: adding nullable columns takes a short lock; the wait for it is capped
(LOCK_TIMEOUT).

The downgrade drops the columns.

Revision ID: 0040_claude_account_identity
Revises: 0039_company_timezone
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0040_claude_account_identity"
down_revision: str | None = "0039_company_timezone"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"

COLUMNS = ("claude_email", "claude_organization")


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for name in COLUMNS:
        op.add_column("claude_accounts", sa.Column(name, sa.Text(), nullable=True))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for name in reversed(COLUMNS):
        op.drop_column("claude_accounts", name)
