"""Account management: last sign-in, password or Google sign-in, personal token scopes

Additive, plus one backfill. ``users`` gains ``last_sign_in_at`` (set by a password or
Google sign-in from now on; unknown before) and ``password_sign_in`` (false for the
members Google sign-in provisioned: the hash they got is of a secret nobody keeps, so
My account offers no password change). The backfill reads the ``provision`` audit
events Google sign-in wrote (``data.via = 'iap'``). ``api_tokens`` gains ``scope``
(a personal token's scopes, as for MCP clients; NULL keeps every right of its role, so
existing tokens behave as before). No constraint is rebuilt.

The integrator re-chains this revision onto the head in merge order.

Revision ID: 0014_account_management
Revises: 0020_autonomy
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_account_management"
down_revision: str | None = "0020_autonomy"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_sign_in_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "users",
        sa.Column("password_sign_in", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column("api_tokens", sa.Column("scope", sa.Text(), nullable=True))
    op.execute(
        """
        UPDATE users SET password_sign_in = false
        WHERE id IN (
            SELECT entity_id FROM audit_events
            WHERE action = 'provision' AND entity = 'user' AND data->>'via' = 'iap'
        )
        """
    )


def downgrade() -> None:
    op.drop_column("api_tokens", "scope")
    op.drop_column("users", "password_sign_in")
    op.drop_column("users", "last_sign_in_at")
