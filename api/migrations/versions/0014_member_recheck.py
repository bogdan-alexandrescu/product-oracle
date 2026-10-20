"""Runs a member change could not lock are rechecked later; the scheduler's tick token

Additive (C2, review round 8). ``member_follow_ups.kind`` admits ``run_recheck``: a run
a disable or a demotion found busy (its row held by a tick or a request), rechecked for
the change once it can be locked (oracle.runs.service.recheck_run). ``api_tokens`` gains
``scope`` (null, or ``tick``: the scheduler's token, good for ``POST /v1/internal/tick``
only; minted with ``python -m oracle.tick_token``).

The integrator re-chains this revision onto the head in merge order.

Revision ID: 0014_member_recheck
Revises: 0014_member_follow_up_retry
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0014_member_recheck"
down_revision: str | None = "0014_member_follow_up_retry"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KIND = "ck_member_follow_ups_kind"
_SCOPE = "ck_api_tokens_scope"


def upgrade() -> None:
    add_check_values("member_follow_ups", _KIND, "kind", ("run_recheck",))
    op.add_column("api_tokens", sa.Column("scope", sa.Text(), nullable=True))
    op.create_check_constraint(op.f(_SCOPE), "api_tokens", "scope IS NULL OR scope IN ('tick')")


def downgrade() -> None:
    # A tick token is nothing without its scope: it is revoked, not turned into an
    # owner token.
    op.execute(
        "UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE scope IS NOT NULL"
    )
    op.drop_constraint(op.f(_SCOPE), "api_tokens", type_="check")
    op.drop_column("api_tokens", "scope")
    op.execute("DELETE FROM member_follow_ups WHERE kind = 'run_recheck'")
    remove_check_values("member_follow_ups", _KIND, "kind", ("run_recheck",))
