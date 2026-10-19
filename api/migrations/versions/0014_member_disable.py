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

Round 4 (owner, 2026-10-19). ``users.sessions_valid_after``: sessions and credentials
issued before it are dead, set on a disable and on a restore (a restored member signs in
fresh). The MCP OAuth grant an approval came through is recorded like the API token:
``section_reviews.oauth_grant_id``, ``document_versions.approved_grant_id`` and
``audit_events.actor_grant_id`` (revoking the grant voids its approvals).
``document_versions.approval_lapses`` keeps every lapsed approval of a version (a new
approval clears ``approval_lapsed_*``, never this list). ``member_disable_followups``:
the provider and SwarmCloud calls a disable owes, made after it commits and retried by
the ticker.

Backfill: approvals by people demoted before this change lapse too. Every approved,
un-lapsed section verdict and every version approval whose approver is now below
approver (a member's role, or a user-less API token's), whose token is revoked, or who
is no longer a member is marked lapsed (reason ``demoted before this change``, ``API
token revoked before this change`` or ``removed before this change``); documents left
without an approved version go back to ``in_review``.

The integrator re-chains this revision onto the head in merge order.

Revision ID: 0014_member_disable
Revises: 0014_review
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_member_disable"
down_revision: str | None = "0014_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


DEMOTED = "demoted before this change"
REVOKED = "API token revoked before this change"
REMOVED = "removed before this change"
APPROVER_ROLES = "('approver', 'owner')"

# Why each approver of a still-counting approval no longer stands: a member below
# approver; a revoked API token; a user-less token below approver (a user's token is
# its user); an id that is neither (removed). NULL when they still stand.
STANDING = f"""
SELECT x.id, CASE
    WHEN u.id IS NOT NULL THEN
        CASE WHEN u.role IN {APPROVER_ROLES} THEN NULL ELSE '{DEMOTED}' END
    WHEN t.id IS NOT NULL AND t.revoked_at IS NOT NULL THEN '{REVOKED}'
    WHEN t.id IS NOT NULL AND tu.id IS NOT NULL THEN
        CASE WHEN tu.role IN {APPROVER_ROLES} THEN NULL ELSE '{DEMOTED}' END
    WHEN t.id IS NOT NULL THEN
        CASE WHEN t.role IN {APPROVER_ROLES} THEN NULL ELSE '{DEMOTED}' END
    ELSE '{REMOVED}'
END AS reason
FROM (
    SELECT reviewer_id AS id FROM section_reviews
    WHERE verdict = 'approved' AND lapsed_at IS NULL AND reviewer_id IS NOT NULL
    UNION
    SELECT approved_by FROM document_versions
    WHERE approved_at IS NOT NULL AND approved_by IS NOT NULL
) x
LEFT JOIN users u ON u.id = x.id
LEFT JOIN api_tokens t ON t.id = x.id
LEFT JOIN users tu ON tu.id = t.user_id
"""


def _backfill_lapses() -> None:
    """Lapse the approvals of approvers who no longer stand (see the module doc)."""
    bind = op.get_bind()
    bind.execute(
        sa.text(
            f"""
            WITH standing AS ({STANDING})
            UPDATE section_reviews r SET lapsed_at = now(), lapse_reason = s.reason
            FROM standing s
            WHERE r.reviewer_id = s.id AND s.reason IS NOT NULL
              AND r.verdict = 'approved' AND r.lapsed_at IS NULL
            """
        )
    )
    documents = bind.execute(
        sa.text(
            f"""
            WITH standing AS ({STANDING})
            UPDATE document_versions v SET
                approval_lapsed_at = now(),
                approval_lapsed_by = v.approved_by,
                approval_lapse_reason = s.reason,
                approval_lapses = v.approval_lapses || jsonb_build_array(jsonb_build_object(
                    'approved_by', v.approved_by::text,
                    'approved_at', v.approved_at,
                    'token_id', v.approved_token_id::text,
                    'grant_id', NULL,
                    'lapsed_at', now(),
                    'reason', s.reason
                )),
                approved_at = NULL,
                approved_by = NULL
            FROM standing s
            WHERE v.approved_by = s.id AND s.reason IS NOT NULL AND v.approved_at IS NOT NULL
            RETURNING v.document_id
            """
        )
    ).scalars()
    ids = list(set(documents))
    if ids:
        bind.execute(
            sa.text(
                """
                UPDATE documents d SET status = 'in_review'
                WHERE d.id = ANY(:ids) AND d.status = 'approved' AND NOT EXISTS (
                    SELECT 1 FROM document_versions v
                    WHERE v.document_id = d.id AND v.approved_at IS NOT NULL
                )
                """
            ),
            {"ids": ids},
        )


def upgrade() -> None:
    op.add_column("audit_events", sa.Column("actor_token_id", sa.Uuid(), nullable=True))
    op.add_column("audit_events", sa.Column("actor_grant_id", sa.Uuid(), nullable=True))
    op.add_column(
        "users", sa.Column("sessions_valid_after", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("users", sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("disabled_by", sa.Uuid(), nullable=True))
    op.add_column("section_reviews", sa.Column("token_id", sa.Uuid(), nullable=True))
    op.add_column(
        "section_reviews", sa.Column("lapsed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("section_reviews", sa.Column("lapse_reason", sa.Text(), nullable=True))
    op.create_index(
        op.f("ix_section_reviews_token_id"), "section_reviews", ["token_id"], unique=False
    )
    op.add_column("section_reviews", sa.Column("oauth_grant_id", sa.Uuid(), nullable=True))
    op.create_index(
        op.f("ix_section_reviews_oauth_grant_id"),
        "section_reviews",
        ["oauth_grant_id"],
        unique=False,
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
    op.add_column("document_versions", sa.Column("approved_grant_id", sa.Uuid(), nullable=True))
    op.create_index(
        op.f("ix_document_versions_approved_grant_id"),
        "document_versions",
        ["approved_grant_id"],
        unique=False,
    )
    op.add_column(
        "document_versions",
        sa.Column(
            "approval_lapses",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
    )
    op.create_table(
        "member_disable_followups",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("subject_id", sa.Uuid(), nullable=True),
        sa.Column(
            "data", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=True),
        sa.Column("key_version", sa.Integer(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
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
            "kind IN ('provider_revoke', 'runtime_cancel')",
            name=op.f("ck_member_disable_followups_kind"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'done', 'failed')",
            name=op.f("ck_member_disable_followups_status"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_member_disable_followups_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_member_disable_followups")),
    )
    op.create_index(
        "ix_member_disable_followups_status", "member_disable_followups", ["status"], unique=False
    )
    op.create_index(
        op.f("ix_member_disable_followups_tenant_id"),
        "member_disable_followups",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_member_disable_followups_user_id"),
        "member_disable_followups",
        ["user_id"],
        unique=False,
    )
    _backfill_lapses()


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
    # A disable's provider revocation not yet made would be forgotten.
    pending = "SELECT 1 FROM member_disable_followups WHERE status = 'pending'"
    if bind.execute(sa.text(pending)).first():
        raise RuntimeError(
            "cannot downgrade: a removed member's provider grant or workflow is still to be "
            "revoked; run the ticker until member_disable_followups has none pending"
        )
    op.drop_table("member_disable_followups")
    op.drop_column("document_versions", "approval_lapses")
    op.drop_index(op.f("ix_document_versions_approved_grant_id"), table_name="document_versions")
    op.drop_column("document_versions", "approved_grant_id")
    op.drop_index(op.f("ix_section_reviews_oauth_grant_id"), table_name="section_reviews")
    op.drop_column("section_reviews", "oauth_grant_id")
    op.drop_column("users", "sessions_valid_after")
    op.drop_column("audit_events", "actor_grant_id")
    op.drop_index(op.f("ix_document_versions_approved_token_id"), table_name="document_versions")
    op.drop_column("document_versions", "approval_lapse_reason")
    op.drop_column("document_versions", "approval_lapsed_by")
    op.drop_column("document_versions", "approval_lapsed_at")
    op.drop_column("document_versions", "approved_token_id")
    op.drop_index(op.f("ix_section_reviews_token_id"), table_name="section_reviews")
    op.drop_column("section_reviews", "lapse_reason")
    op.drop_column("section_reviews", "lapsed_at")
    op.drop_column("section_reviews", "token_id")
    op.drop_column("users", "disabled_by")
    op.drop_column("users", "disabled_at")
    op.drop_column("audit_events", "actor_token_id")
