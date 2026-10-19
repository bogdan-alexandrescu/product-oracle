"""Removing a member disables them; approvals lapse for good and name their token (C2)

Additive only. ``users`` gains ``disabled_at`` and ``disabled_by``: a disabled member
keeps their row (every ``*_by`` reference and the verdict history keep the name) but no
sign-in path accepts them, and an owner can restore them. ``section_reviews`` gains
``token_id`` (the API token that gave the verdict, when a token acted) and
``lapsed_at`` / ``lapse_reason``: an approval that lapsed (its approver demoted below
approver or disabled, its token revoked) is marked for good, so a re-promotion or a
restore never revives it. ``document_versions`` gains the same for the version
approval: ``approved_token_id``, and ``approval_lapsed_at`` / ``approval_lapsed_by`` /
``approval_lapse_reason`` (the lapsed approval moves there; ``approved_at`` is cleared).
``audit_events`` gains ``actor_token_id``: the API token an actor acted through, also
when it acts for a user. See docs/product-oracle-v2/08-review-and-publish.md.

The integrator re-chains this revision onto the head in merge order.

Revision ID: 0014_member_disable
Revises: 0014_review
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_member_disable"
down_revision: str | None = "0014_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("audit_events", sa.Column("actor_token_id", sa.Uuid(), nullable=True))
    op.add_column("users", sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("disabled_by", sa.Uuid(), nullable=True))
    op.add_column(
        "users", sa.Column("sessions_valid_after", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("section_reviews", sa.Column("token_id", sa.Uuid(), nullable=True))
    op.add_column(
        "section_reviews", sa.Column("lapsed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("section_reviews", sa.Column("lapse_reason", sa.Text(), nullable=True))
    op.create_index(
        op.f("ix_section_reviews_token_id"), "section_reviews", ["token_id"], unique=False
    )
    op.add_column("document_versions", sa.Column("approved_token_id", sa.Uuid(), nullable=True))
    op.add_column(
        "document_versions",
        sa.Column("approval_lapsed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("document_versions", sa.Column("approval_lapsed_by", sa.Uuid(), nullable=True))
    op.add_column("document_versions", sa.Column("approval_lapse_reason", sa.Text(), nullable=True))
    op.create_index(
        op.f("ix_document_versions_approved_token_id"),
        "document_versions",
        ["approved_token_id"],
        unique=False,
    )
    op.create_table(
        "member_follow_ups",
        sa.Column("member_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=True),
        sa.Column("auth_mode", sa.Text(), nullable=True),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=True),
        sa.Column("key_version", sa.Integer(), nullable=True),
        sa.Column("workflow_id", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('provider_revoke', 'run_cancel')", name=op.f("ck_member_follow_ups_kind")
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'done', 'failed')", name=op.f("ck_member_follow_ups_status")
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_member_follow_ups_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_member_follow_ups")),
    )
    op.create_index(
        op.f("ix_member_follow_ups_member_id"), "member_follow_ups", ["member_id"], unique=False
    )
    op.create_index(
        op.f("ix_member_follow_ups_tenant_id"), "member_follow_ups", ["tenant_id"], unique=False
    )


def downgrade() -> None:
    bind = op.get_bind()
    # Dropping the column would let a disabled member sign in again.
    if bind.execute(sa.text("SELECT 1 FROM users WHERE disabled_at IS NOT NULL")).first():
        raise RuntimeError(
            "cannot downgrade: a member is disabled (dropping disabled_at would let them "
            "sign in again); delete or restore them first"
        )
    # Dropping lapsed_at would let a lapsed approval count again.
    if bind.execute(sa.text("SELECT 1 FROM section_reviews WHERE lapsed_at IS NOT NULL")).first():
        raise RuntimeError("cannot downgrade: an approval lapsed and would count again")
    # A pending follow-up is a provider revoke or a runtime cancel a disable still owes.
    if bind.execute(sa.text("SELECT 1 FROM member_follow_ups WHERE status = 'pending'")).first():
        raise RuntimeError(
            "cannot downgrade: a removed member's provider revoke or run cancel is still "
            "pending; run the tick until it is done"
        )
    op.drop_index(op.f("ix_member_follow_ups_tenant_id"), table_name="member_follow_ups")
    op.drop_index(op.f("ix_member_follow_ups_member_id"), table_name="member_follow_ups")
    op.drop_table("member_follow_ups")
    op.drop_index(op.f("ix_document_versions_approved_token_id"), table_name="document_versions")
    op.drop_column("document_versions", "approval_lapse_reason")
    op.drop_column("document_versions", "approval_lapsed_by")
    op.drop_column("document_versions", "approval_lapsed_at")
    op.drop_column("document_versions", "approved_token_id")
    op.drop_index(op.f("ix_section_reviews_token_id"), table_name="section_reviews")
    op.drop_column("section_reviews", "lapse_reason")
    op.drop_column("section_reviews", "lapsed_at")
    op.drop_column("section_reviews", "token_id")
    op.drop_column("users", "sessions_valid_after")
    op.drop_column("users", "disabled_by")
    op.drop_column("users", "disabled_at")
    op.drop_column("audit_events", "actor_token_id")
