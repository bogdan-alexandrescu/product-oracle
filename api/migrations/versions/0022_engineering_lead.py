"""The engineering lead flag on members and invites (A3 Engineering lead)

Additive. ``users.engineering_lead`` and ``invites.engineering_lead`` (boolean, not null,
default false): the members who speak for engineering, who decide the engineering stops
(the check and the dates) once one is named and verify dates; an invite carries it to the
first sign-in. A check on each table keeps it off viewers (commenter or above carries it).

Live-safe: a not-null column with a constant default is a catalog-only change on
Postgres 11+, and the checks hold for every existing row (all false); nothing is
backfilled.

The downgrade drops the checks, then the columns: who was flagged is lost (the
``member.engineering_lead`` audit events keep it).

Revision ID: 0022_engineering_lead
Revises: 0022_baseline_flow
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022_engineering_lead"
down_revision: str | None = "0022_baseline_flow"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("users", "invites")
CHECK = "NOT engineering_lead OR role <> 'viewer'"


def upgrade() -> None:
    for table in TABLES:
        op.add_column(
            table,
            sa.Column("engineering_lead", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
        op.create_check_constraint(op.f(f"ck_{table}_engineering_lead_role"), table, CHECK)


def downgrade() -> None:
    for table in TABLES:
        op.drop_constraint(op.f(f"ck_{table}_engineering_lead_role"), table, type_="check")
        op.drop_column(table, "engineering_lead")
