"""Discussions: one thread per subject, its people, messages and typed changes (G1)

New tables ``discussions``, ``discussion_participants``, ``discussion_messages`` and
``discussion_changes`` (oracle.discussions.models). Every table is company-scoped; the
``*_by`` columns hold a user id with no foreign key, as elsewhere. The changes table's
kind CHECK lists every typed change kind now (oracle.discussions.kinds), so the picks that
apply them later need no migration.

Additive: no existing table changes and nothing is backfilled.

The downgrade drops the four tables: discussions written meanwhile are lost (export them
first with ``GET /v1/discussions`` and their messages).

Revision ID: 0022_discussions
Revises: 0021_feedback_agent_staging
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022_discussions"
down_revision: str | None = "0021_feedback_agent_staging"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen here as of this revision (oracle.discussions.models).
SUBJECT_KINDS = (
    "document", "section", "checkpoint", "checkpoint_item", "roadmap_item", "entity",
    "conflict", "intake", "gap", "track", "priorities", "screen",
)  # fmt: skip
CHANGE_KINDS = (
    "section_edit", "goal_measure", "entity_edit", "conflict_pick", "answer", "ask_person",
    "basis_record", "item_horizon", "item_outcome", "item_drop", "item_dependency",
    "item_date_remove", "item_split", "item_merge", "scope_feature", "scope_requirement",
    "priority_move", "priority_pin",
)  # fmt: skip


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.create_table(
        "discussions",
        sa.Column("subject_kind", sa.Text(), nullable=False),
        sa.Column("subject", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("subject_key", sa.Text(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("intake_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("visibility", sa.Text(), server_default="open", nullable=False),
        sa.Column("author_only", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("origin", sa.Text(), server_default="discuss", nullable=False),
        sa.Column("started_by", sa.Uuid(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("summary_status", sa.Text(), server_default="none", nullable=False),
        sa.Column("summary_by", sa.Uuid(), nullable=True),
        sa.Column("summary_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("summary_shared", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("closed_by", sa.Uuid(), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "origin IN ('discuss', 'panel', 'slack')", name=op.f("ck_discussions_origin")
        ),
        sa.CheckConstraint("status IN ('open', 'closed')", name=op.f("ck_discussions_status")),
        sa.CheckConstraint(
            _in("subject_kind", SUBJECT_KINDS),
            name=op.f("ck_discussions_subject_kind"),
        ),
        sa.CheckConstraint(
            "summary_status IN ('none', 'draft', 'confirmed')",
            name=op.f("ck_discussions_summary_status"),
        ),
        sa.CheckConstraint(
            "visibility IN ('open', 'private')", name=op.f("ck_discussions_visibility")
        ),
        sa.CheckConstraint(
            "char_length(title) BETWEEN 1 AND 200", name=op.f("ck_discussions_title")
        ),
        sa.CheckConstraint(
            "summary IS NULL OR char_length(summary) <= 1200", name=op.f("ck_discussions_summary")
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_discussions_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["intake_id"],
            ["product_intakes.id"],
            name=op.f("fk_discussions_intake_id_product_intakes"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_discussions_run_id_runs"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_discussions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discussions")),
    )
    op.create_index(
        op.f("ix_discussions_document_id"), "discussions", ["document_id"], unique=False
    )
    op.create_index(op.f("ix_discussions_run_id"), "discussions", ["run_id"], unique=False)
    op.create_index(
        "ix_discussions_subject",
        "discussions",
        ["tenant_id", "subject_key", sa.literal_column("last_message_at DESC")],
        unique=False,
    )
    op.create_index(op.f("ix_discussions_tenant_id"), "discussions", ["tenant_id"], unique=False)
    op.create_table(
        "discussion_messages",
        sa.Column("discussion_id", sa.Uuid(), nullable=False),
        sa.Column("author_kind", sa.Text(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=True),
        sa.Column("via", sa.Text(), server_default="web", nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("mentions", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("mentions_oracle", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("reply_to", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="complete", nullable=False),
        sa.Column(
            "citations",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "author_kind IN ('person', 'oracle', 'system')",
            name=op.f("ck_discussion_messages_author_kind"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'streaming', 'complete', 'failed', 'cancelled')",
            name=op.f("ck_discussion_messages_status"),
        ),
        sa.CheckConstraint(
            "via IN ('web', 'mcp', 'slack')", name=op.f("ck_discussion_messages_via")
        ),
        sa.CheckConstraint("char_length(body) <= 8000", name=op.f("ck_discussion_messages_body")),
        sa.ForeignKeyConstraint(
            ["discussion_id"],
            ["discussions.id"],
            name=op.f("fk_discussion_messages_discussion_id_discussions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["reply_to"],
            ["discussion_messages.id"],
            name=op.f("fk_discussion_messages_reply_to_discussion_messages"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_discussion_messages_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discussion_messages")),
    )
    op.create_index(
        op.f("ix_discussion_messages_tenant_id"), "discussion_messages", ["tenant_id"], unique=False
    )
    op.create_index(
        "ix_discussion_messages_thread",
        "discussion_messages",
        ["discussion_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "discussion_participants",
        sa.Column("discussion_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("added_by", sa.Uuid(), nullable=True),
        sa.Column("added_via", sa.Text(), nullable=False),
        sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_by", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "added_via IN ('started', 'mention', 'added', 'followed', 'posted')",
            name=op.f("ck_discussion_participants_added_via"),
        ),
        sa.ForeignKeyConstraint(
            ["discussion_id"],
            ["discussions.id"],
            name=op.f("fk_discussion_participants_discussion_id_discussions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_discussion_participants_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_discussion_participants_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discussion_participants")),
        sa.UniqueConstraint(
            "discussion_id",
            "user_id",
            name=op.f("uq_discussion_participants_discussion_id_user_id"),
        ),
    )
    op.create_index(
        op.f("ix_discussion_participants_tenant_id"),
        "discussion_participants",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "discussion_changes",
        sa.Column("discussion_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("target", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("edited_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column(
            "basis", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("proposed_by_kind", sa.Text(), nullable=False),
        sa.Column("proposed_by", sa.Uuid(), nullable=True),
        sa.Column("from_message_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="proposed", nullable=False),
        sa.Column("suggested_by", sa.Uuid(), nullable=True),
        sa.Column("suggested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pushback", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("override_reason", sa.Text(), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_note", sa.Text(), nullable=True),
        sa.Column("result_ref", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            _in("kind", CHANGE_KINDS),
            name=op.f("ck_discussion_changes_kind"),
        ),
        sa.CheckConstraint(
            "proposed_by_kind IN ('oracle', 'person')",
            name=op.f("ck_discussion_changes_proposed_by_kind"),
        ),
        sa.CheckConstraint(
            "status IN ('proposed', 'suggested', 'staged', 'done', 'dismissed', 'superseded')",
            name=op.f("ck_discussion_changes_status"),
        ),
        sa.CheckConstraint(
            "rationale IS NULL OR char_length(rationale) <= 1000",
            name=op.f("ck_discussion_changes_rationale"),
        ),
        sa.ForeignKeyConstraint(
            ["discussion_id"],
            ["discussions.id"],
            name=op.f("fk_discussion_changes_discussion_id_discussions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["from_message_id"],
            ["discussion_messages.id"],
            name=op.f("fk_discussion_changes_from_message_id_discussion_messages"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_discussion_changes_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discussion_changes")),
    )
    op.create_index(
        "ix_discussion_changes_status",
        "discussion_changes",
        ["discussion_id", "status"],
        unique=False,
    )
    op.create_index(
        op.f("ix_discussion_changes_tenant_id"), "discussion_changes", ["tenant_id"], unique=False
    )


def downgrade() -> None:
    # Their indexes go with them.
    op.drop_table("discussion_changes")
    op.drop_table("discussion_participants")
    op.drop_table("discussion_messages")
    op.drop_table("discussions")
