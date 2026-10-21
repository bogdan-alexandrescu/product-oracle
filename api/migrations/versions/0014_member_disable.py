"""Removing a member disables them; approvals lapse for good and name their token (C2)

Additive, plus one backfill. ``users`` gains ``disabled_at`` and ``disabled_by``: a
disabled member keeps their row (every ``*_by`` reference and the verdict history keep
the name) but no sign-in path accepts them, and an owner can restore them; and
``sessions_valid_after``: session cookies signed before it are refused (set by a
disable and by a restore, so a disable ends every session and a restored member signs
in fresh). ``section_reviews`` gains ``token_id`` (the API token that gave the verdict,
when a token acted), ``grant_id`` (the MCP OAuth grant, when one did) and ``lapsed_at``
/ ``lapse_reason``: an approval that lapsed (its approver demoted below approver or
disabled, its token or grant revoked) is marked for good, so a re-promotion or a
restore never revives it. ``document_versions`` gains the same for the version
approval: ``approved_token_id``, ``approved_grant_id``, and ``approval_lapsed_at`` /
``approval_lapsed_by`` / ``approval_lapse_reason`` (the lapsed approval moves there;
``approved_at`` is cleared) and ``approval_lapses``, the history a new approval keeps.
``audit_events`` gains ``actor_token_id`` and ``actor_grant_id``: the API token or
OAuth grant an actor acted through, also when it acts for a user.
``member_follow_ups`` holds the provider revokes and runtime cancels a disable owes,
made after it commits and retried by the tick.

Backfill: approvals given by people already below approver lapse for good (reason
"demoted before this change"), as a demotion now lapses them; before, a re-promotion
would have revived them; each section whose approval lapsed asks for re-review when its
document's policy says so, as a lapse does at runtime. See
docs/product-oracle-v2/08-review-and-publish.md.

The integrator re-chains this revision onto the head in merge order.

Revision ID: 0014_member_disable
Revises: 0014_review
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_member_disable"
down_revision: str | None = "0014_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("audit_events", sa.Column("actor_token_id", sa.Uuid(), nullable=True))
    op.add_column("audit_events", sa.Column("actor_grant_id", sa.Uuid(), nullable=True))
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
    op.add_column("section_reviews", sa.Column("grant_id", sa.Uuid(), nullable=True))
    op.create_index(
        op.f("ix_section_reviews_grant_id"), "section_reviews", ["grant_id"], unique=False
    )
    op.add_column("document_versions", sa.Column("approved_token_id", sa.Uuid(), nullable=True))
    op.add_column("document_versions", sa.Column("approved_grant_id", sa.Uuid(), nullable=True))
    op.create_index(
        op.f("ix_document_versions_approved_grant_id"),
        "document_versions",
        ["approved_grant_id"],
        unique=False,
    )
    op.add_column(
        "document_versions",
        sa.Column("approval_lapsed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("document_versions", sa.Column("approval_lapsed_by", sa.Uuid(), nullable=True))
    op.add_column("document_versions", sa.Column("approval_lapse_reason", sa.Text(), nullable=True))
    op.add_column(
        "document_versions",
        sa.Column(
            "approval_lapses",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
    )
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
    _lapse_approvals_of_demoted()


# Who no longer approves: a member below approver (or disabled).
_NOT_AN_APPROVER = "(u.role NOT IN ('approver', 'owner') OR u.disabled_at IS NOT NULL)"
DEMOTED_REASON = "demoted before this change"


def _lapse_approvals_of_demoted() -> None:
    """Backfill (C2): approvals given by people demoted below approver before this
    revision lapse for good, as a demotion now lapses them in its transaction; before,
    they only stopped counting while the person stayed demoted, so a re-promotion
    would have revived them. Section approvals get ``lapsed_at``; version approvals
    move to ``approval_lapsed_*``; a document left without an approved version goes
    back to in_review. One ``approval.lapse`` audit event per person."""
    bind = op.get_bind()
    reviews = bind.execute(
        sa.text(
            "UPDATE section_reviews r SET lapsed_at = now(), lapse_reason = :reason "
            "FROM users u WHERE u.id = r.reviewer_id AND u.tenant_id = r.tenant_id "
            f"AND r.verdict = 'approved' AND r.lapsed_at IS NULL AND {_NOT_AN_APPROVER} "
            "RETURNING r.tenant_id, r.reviewer_id, r.id"
        ),
        {"reason": DEMOTED_REASON},
    ).all()
    versions = bind.execute(
        sa.text(
            "UPDATE document_versions v SET approval_lapsed_at = now(), "
            "approval_lapsed_by = v.approved_by, approval_lapse_reason = :reason, "
            "approval_lapses = v.approval_lapses || jsonb_build_array(jsonb_build_object("
            "'approved_at', to_jsonb(v.approved_at), 'approved_by', CAST(v.approved_by AS text), "
            "'approved_token_id', CAST(v.approved_token_id AS text), "
            "'approved_grant_id', CAST(v.approved_grant_id AS text), "
            "'lapsed_at', to_jsonb(now()), 'reason', CAST(:reason AS text))), "
            "approved_at = NULL, approved_by = NULL "
            "FROM users u WHERE u.id = v.approved_by AND u.tenant_id = v.tenant_id "
            f"AND v.approved_at IS NOT NULL AND {_NOT_AN_APPROVER} "
            "RETURNING v.tenant_id, v.approval_lapsed_by, v.id, v.document_id"
        ),
        {"reason": DEMOTED_REASON},
    ).all()
    # As a runtime lapse does (oracle.review.state.lapse_approvals): each section whose
    # approval lapsed asks for re-review when its document's effective policy says so
    # (its own policy, else the company's review_policy, else the default: yes). No
    # notification is sent for the backfill.
    if reviews:
        bind.execute(
            sa.text(
                "INSERT INTO section_review_states (id, tenant_id, document_id, section_key, "
                "rereview_requested_at) "
                "SELECT gen_random_uuid(), x.tenant_id, x.document_id, x.section_key, now() "
                "FROM (SELECT DISTINCT r.tenant_id, v.document_id, r.section_key "
                "FROM section_reviews r JOIN document_versions v ON v.id = r.version_id "
                "WHERE CAST(r.id AS text) = ANY(:ids)) x "
                "LEFT JOIN document_review_policies p ON p.document_id = x.document_id "
                "LEFT JOIN tenant_settings s ON s.tenant_id = x.tenant_id "
                "AND s.key = 'review_policy' "
                "WHERE COALESCE(p.rereview_on_change, "
                "CAST(s.value ->> 'rereview_on_change' AS boolean), true) "
                "ON CONFLICT (document_id, section_key) "
                "DO UPDATE SET rereview_requested_at = now()"
            ),
            {"ids": [str(r.id) for r in reviews]},
        )
    documents = sorted({str(r.document_id) for r in versions})
    if documents:
        bind.execute(
            sa.text(
                "UPDATE documents d SET status = 'in_review' "
                "WHERE d.status = 'approved' AND CAST(d.id AS text) = ANY(:ids) "
                "AND NOT EXISTS (SELECT 1 FROM document_versions v "
                "WHERE v.document_id = d.id AND v.approved_at IS NOT NULL)"
            ),
            {"ids": documents},
        )
    by_person: dict[tuple, dict[str, list[str]]] = {}
    for tenant_id, person, review_id in reviews:
        entry = by_person.setdefault((tenant_id, person), {"reviews": [], "versions": []})
        entry["reviews"].append(str(review_id))
    for tenant_id, person, version_id, _ in versions:
        entry = by_person.setdefault((tenant_id, person), {"reviews": [], "versions": []})
        entry["versions"].append(str(version_id))
    for (tenant_id, person), entry in by_person.items():
        bind.execute(
            sa.text(
                "INSERT INTO audit_events (id, tenant_id, actor, action, entity, entity_id, "
                "data) VALUES (gen_random_uuid(), :t, 'system', 'approval.lapse', 'user', :p, "
                "CAST(:data AS jsonb))"
            ),
            {
                "t": tenant_id,
                "p": person,
                "data": json.dumps(
                    {
                        "reason": DEMOTED_REASON,
                        "via": "migration 0014_member_disable",
                        "section_review_ids": entry["reviews"],
                        "version_ids": entry["versions"],
                    }
                ),
            },
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
    op.drop_index(op.f("ix_document_versions_approved_grant_id"), table_name="document_versions")
    op.drop_column("document_versions", "approved_grant_id")
    op.drop_index(op.f("ix_document_versions_approved_token_id"), table_name="document_versions")
    op.drop_column("document_versions", "approval_lapses")
    op.drop_column("document_versions", "approval_lapse_reason")
    op.drop_column("document_versions", "approval_lapsed_by")
    op.drop_column("document_versions", "approval_lapsed_at")
    op.drop_column("document_versions", "approved_token_id")
    op.drop_index(op.f("ix_section_reviews_grant_id"), table_name="section_reviews")
    op.drop_column("section_reviews", "grant_id")
    op.drop_index(op.f("ix_section_reviews_token_id"), table_name="section_reviews")
    op.drop_column("section_reviews", "lapse_reason")
    op.drop_column("section_reviews", "lapsed_at")
    op.drop_column("section_reviews", "token_id")
    op.drop_column("users", "sessions_valid_after")
    op.drop_column("users", "disabled_by")
    op.drop_column("users", "disabled_at")
    op.drop_column("audit_events", "actor_grant_id")
    op.drop_column("audit_events", "actor_token_id")
