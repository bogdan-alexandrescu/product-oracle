"""Members and access (A5)

``users.name`` and ``invites.name``: optional names, 1 to 80 characters. Invites gain an
expiry (14 days from creation or from the last resend), a resend count and the access
request they came from. ``access_requests``: someone from the company's email domains who
signed in with Google without an invite, waiting for an owner (or an approver) to approve
or decline (one pending row per email).

Open invites expire 14 days after this migration (nobody is cut off by the deploy);
accepted and revoked ones 14 days after they were created.

The downgrade drops the columns, the table and the ``sign_in_without_invite`` settings.

Revision ID: 0042_members_access
Revises: 0041_subgoals
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0042_members_access"
down_revision: str | None = "0041_subgoals"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
NAME_LENGTH = "name IS NULL OR char_length(name) BETWEEN 1 AND 80"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for table in ("users", "invites"):
        op.add_column(table, sa.Column("name", sa.Text(), nullable=True))
        op.create_check_constraint(op.f(f"ck_{table}_name_length"), table, NAME_LENGTH)
    op.create_table(
        "access_requests",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "tenant_id", sa.Uuid(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("note", sa.Text()),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("decided_by", sa.Uuid()),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("role", sa.Text()),
        sa.Column("invite_id", sa.Uuid(), sa.ForeignKey("invites.id", ondelete="SET NULL")),
        sa.CheckConstraint("email = lower(email)", name=op.f("ck_access_requests_email_lowercase")),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'declined', 'closed')",
            name=op.f("ck_access_requests_status"),
        ),
        sa.CheckConstraint(
            "note IS NULL OR char_length(note) <= 500", name=op.f("ck_access_requests_note_length")
        ),
        sa.CheckConstraint(
            "role IS NULL OR role IN ('viewer', 'commenter', 'approver', 'owner')",
            name=op.f("ck_access_requests_role"),
        ),
    )
    op.create_index("ix_access_requests_tenant_id", "access_requests", ["tenant_id"])
    op.create_index(
        "uq_access_requests_tenant_id_email_pending",
        "access_requests",
        ["tenant_id", "email"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.add_column("invites", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(
        "UPDATE invites SET expires_at = CASE"
        " WHEN accepted_at IS NULL AND revoked_at IS NULL THEN now() + interval '336 hours'"
        " ELSE created_at + interval '336 hours' END"
    )
    op.alter_column(
        "invites",
        "expires_at",
        nullable=False,
        server_default=sa.text("now() + interval '336 hours'"),
    )
    op.add_column("invites", sa.Column("resent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "invites", sa.Column("resend_count", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "invites",
        sa.Column(
            "access_request_id",
            sa.Uuid(),
            sa.ForeignKey(
                "access_requests.id",
                ondelete="SET NULL",
                name=op.f("fk_invites_access_request_id_access_requests"),
            ),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("invites", "access_request_id")
    op.drop_column("invites", "resend_count")
    op.drop_column("invites", "resent_at")
    op.drop_column("invites", "expires_at")
    op.drop_table("access_requests")
    for table in ("users", "invites"):
        op.drop_constraint(op.f(f"ck_{table}_name_length"), table, type_="check")
        op.drop_column(table, "name")
    op.execute("DELETE FROM tenant_settings WHERE key = 'sign_in_without_invite'")
