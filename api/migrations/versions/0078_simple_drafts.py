"""Simple S3b (#723): working drafts, item tasks and action items

``simple_drafts``: the working draft of one versioned document (a roadmap's items), at
most one ``working`` per document, holding the changed items' fields until it is
submitted as the next version and approved through the review policy;
``simple_session_drafts``: which sessions work on it. ``simple_changes`` gains
``draft_ids``. ``roadmap_item_tasks`` (work under a roadmap item) and
``simple_action_items`` (a meeting's action items), from the issue's data model. All
tenant-scoped like every table.

Live-safe: new tables and an array column with a constant default (no rewrite).

The downgrade drops them (working drafts, item tasks and action items are lost).

Revision ID: 0078_simple_drafts
Revises: 0077_simple_changes
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0078_simple_drafts"
down_revision: str | None = "0077_simple_changes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
DRAFT_STATUSES = ("working", "submitted", "approved", "discarded")
TASK_STATUSES = ("todo", "doing", "done", "dropped")
ACTION_STATUSES = ("open", "done", "dropped")


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _base(table: str) -> list[sa.Column | sa.Constraint]:
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{table}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]


def _fk(table: str, column: str, target: str, ondelete: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column], [f"{target}.id"], name=op.f(f"fk_{table}_{column}_{target}"), ondelete=ondelete
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "simple_changes",
        sa.Column("draft_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
    )
    t = "simple_drafts"
    op.create_table(
        t,
        *_base(t),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("base_version_id", sa.Uuid(), nullable=True),
        sa.Column("version_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="working", nullable=False),
        sa.Column(
            "overlay", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column(
            "participant_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False
        ),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("submitted_by", sa.Uuid(), nullable=True),
        sa.Column("decider_approval", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("waiting_on", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(_in("status", DRAFT_STATUSES), name=op.f("ck_simple_drafts_status")),
        _fk(t, "document_id", "documents", "CASCADE"),
        _fk(t, "base_version_id", "document_versions", "SET NULL"),
        _fk(t, "version_id", "document_versions", "SET NULL"),
    )
    op.create_index(op.f("ix_simple_drafts_tenant_id"), t, ["tenant_id"])
    op.create_index(op.f("ix_simple_drafts_document_id"), t, ["document_id"])
    op.create_index(
        "uq_simple_drafts_working",
        t,
        ["document_id"],
        unique=True,
        postgresql_where=sa.text("status = 'working'"),
    )
    t = "simple_session_drafts"
    op.create_table(
        t,
        *_base(t),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("draft_id", sa.Uuid(), nullable=False),
        sa.Column("draft_version_id", sa.Uuid(), nullable=True),
        _fk(t, "session_id", "simple_sessions", "CASCADE"),
        _fk(t, "document_id", "documents", "CASCADE"),
        _fk(t, "draft_id", "simple_drafts", "CASCADE"),
        _fk(t, "draft_version_id", "document_versions", "SET NULL"),
        sa.UniqueConstraint(
            "session_id", "document_id", name=op.f("uq_simple_session_drafts_session_id_document_id")
        ),
    )
    op.create_index(op.f("ix_simple_session_drafts_tenant_id"), t, ["tenant_id"])
    op.create_index(op.f("ix_simple_session_drafts_draft_id"), t, ["draft_id"])
    t = "roadmap_item_tasks"
    op.create_table(
        t,
        *_base(t),
        sa.Column("item_id", sa.Uuid(), nullable=True),
        sa.Column("roadmap_document_id", sa.Uuid(), nullable=False),
        sa.Column("item_key", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="todo", nullable=False),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("tracker_record_id", sa.Uuid(), nullable=True),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.CheckConstraint(_in("status", TASK_STATUSES), name=op.f("ck_roadmap_item_tasks_status")),
        _fk(t, "item_id", "roadmap_items", "SET NULL"),
        _fk(t, "roadmap_document_id", "documents", "CASCADE"),
        _fk(t, "tracker_record_id", "tracker_records", "SET NULL"),
    )
    op.create_index(op.f("ix_roadmap_item_tasks_tenant_id"), t, ["tenant_id"])
    op.create_index("ix_roadmap_item_tasks_item", t, ["roadmap_document_id", "item_key"])
    t = "simple_action_items"
    op.create_table(
        t,
        *_base(t),
        sa.Column("meeting_id", sa.Uuid(), nullable=True),
        sa.Column("item_id", sa.Uuid(), nullable=True),
        sa.Column("roadmap_document_id", sa.Uuid(), nullable=True),
        sa.Column("item_key", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.CheckConstraint(
            _in("status", ACTION_STATUSES), name=op.f("ck_simple_action_items_status")
        ),
        _fk(t, "item_id", "roadmap_items", "SET NULL"),
        _fk(t, "roadmap_document_id", "documents", "CASCADE"),
    )
    op.create_index(op.f("ix_simple_action_items_tenant_id"), t, ["tenant_id"])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_table("simple_action_items")
    op.drop_table("roadmap_item_tasks")
    op.drop_table("simple_session_drafts")
    op.drop_table("simple_drafts")
    op.drop_column("simple_changes", "draft_ids")
