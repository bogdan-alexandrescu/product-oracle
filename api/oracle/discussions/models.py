"""Discussions (G1): one thread per subject, its people, its messages and the typed
changes it ends in.

``*_by`` columns hold a user id with no foreign key, as elsewhere. ``lock_version`` maps
as SQLAlchemy's ``version_id_col`` (oracle.v2.concurrency).
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    Uuid,
    false,
    func,
    text,
    true,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

SUBJECT_KINDS = (
    "document",
    "section",
    "checkpoint",
    "checkpoint_item",
    "roadmap_item",
    "entity",
    "conflict",
    "intake",
    "gap",
    "track",
    "priorities",
    "screen",
)
VISIBILITIES = ("open", "private")
STATUSES = ("open", "closed")
# Where it was started: a Discuss entry, G7's head-of-product panel, G8's Slack bridge.
ORIGINS = ("discuss", "panel", "slack")
SUMMARY_STATUSES = ("none", "draft", "confirmed")
ADDED_VIA = ("started", "mention", "added", "followed", "posted")
AUTHOR_KINDS = ("person", "oracle", "system")
VIA = ("web", "mcp", "slack")
MESSAGE_STATUSES = ("pending", "streaming", "complete", "failed", "cancelled")
# Every kind now (oracle.discussions.kinds), so later picks need no migration.
CHANGE_KINDS = (
    "section_edit",
    "goal_measure",
    "entity_edit",
    "conflict_pick",
    "answer",
    "ask_person",
    "basis_record",
    "item_horizon",
    "item_outcome",
    "item_drop",
    "item_dependency",
    "item_date_remove",
    "item_split",
    "item_merge",
    "scope_feature",
    "scope_requirement",
    "priority_move",
    "priority_pin",
    # H1 Decision log's entry point: a discussion proposes a decision.
    "decision",
)
CHANGE_STATUSES = ("proposed", "suggested", "staged", "done", "dismissed", "superseded")
PROPOSED_BY_KINDS = ("oracle", "person")
MAX_TITLE = 200
MAX_BODY = 8000
MAX_SUMMARY = 1200
MAX_RATIONALE = 1000
INBOX_KINDS = ("invited", "mentioned")


def _updated_at() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class Discussion(TenantScoped, Base):
    __tablename__ = "discussions"
    __table_args__ = (
        CheckConstraint(_in("subject_kind", SUBJECT_KINDS), name="subject_kind"),
        CheckConstraint(f"char_length(title) BETWEEN 1 AND {MAX_TITLE}", name="title"),
        CheckConstraint(_in("visibility", VISIBILITIES), name="visibility"),
        CheckConstraint(_in("status", STATUSES), name="status"),
        CheckConstraint(_in("origin", ORIGINS), name="origin"),
        CheckConstraint(
            f"summary IS NULL OR char_length(summary) <= {MAX_SUMMARY}", name="summary"
        ),
        CheckConstraint(_in("summary_status", SUMMARY_STATUSES), name="summary_status"),
        Index("ix_discussions_subject", "tenant_id", "subject_key", text("last_message_at DESC")),
    )

    subject_kind: Mapped[str] = mapped_column(Text, nullable=False)
    subject: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # Derived from the subject on create and never edited (oracle.discussions.service).
    subject_key: Mapped[str] = mapped_column(Text, nullable=False)
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="SET NULL"), index=True
    )
    intake_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("product_intakes.id", ondelete="CASCADE")
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    visibility: Mapped[str] = mapped_column(
        Text, nullable=False, default="open", server_default="open"
    )
    # Rule 3.4.3: on the author's own private finding; nobody is added while it stays so.
    author_only: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open", server_default="open")
    origin: Mapped[str] = mapped_column(
        Text, nullable=False, default="discuss", server_default="discuss"
    )
    started_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    summary_status: Mapped[str] = mapped_column(
        Text, nullable=False, default="none", server_default="none"
    )
    summary_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    summary_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # False by default for a private discussion (G5); moot once it is open.
    summary_shared: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    closed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lock_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    updated_at: Mapped[datetime] = _updated_at()

    __mapper_args__ = {"version_id_col": lock_version}


class DiscussionParticipant(TenantScoped, Base):
    __tablename__ = "discussion_participants"
    __table_args__ = (
        UniqueConstraint("discussion_id", "user_id"),
        CheckConstraint(_in("added_via", ADDED_VIA), name="added_via"),
    )

    discussion_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("discussions.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    added_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    added_via: Mapped[str] = mapped_column(Text, nullable=False)
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Left or removed; None: in.
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class DiscussionMessage(TenantScoped, Base):
    __tablename__ = "discussion_messages"
    __table_args__ = (
        CheckConstraint(_in("author_kind", AUTHOR_KINDS), name="author_kind"),
        CheckConstraint(_in("via", VIA), name="via"),
        CheckConstraint(f"char_length(body) <= {MAX_BODY}", name="body"),
        CheckConstraint(_in("status", MESSAGE_STATUSES), name="status"),
        Index("ix_discussion_messages_thread", "discussion_id", "created_at"),
        Index(
            "ix_discussion_messages_open_replies",
            "status",
            "created_at",
            postgresql_where=text("status IN ('pending', 'streaming')"),
        ),
    )

    discussion_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("discussions.id", ondelete="CASCADE"), nullable=False
    )
    author_kind: Mapped[str] = mapped_column(Text, nullable=False)
    # users.id for a person; None for Oracle and system lines.
    author_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    via: Mapped[str] = mapped_column(Text, nullable=False, default="web", server_default="web")
    body: Mapped[str] = mapped_column(Text, nullable=False)
    mentions: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, default=list, server_default="{}"
    )
    mentions_oracle: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    reply_to: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussion_messages.id", ondelete="SET NULL")
    )
    # G2 Live replies fills these for Oracle's messages; people's are 'complete'.
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="complete", server_default="complete"
    )
    citations: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # G2 Live replies: an Oracle reply's call, its accounting (owners only, P3d), its
    # stream's lease, a Stop request, how it failed, and a pushback (C1b).
    model: Mapped[str | None] = mapped_column(Text)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    account_label: Mapped[str | None] = mapped_column(Text)
    llm_via: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    error: Mapped[str | None] = mapped_column(Text)
    error_reason: Mapped[str | None] = mapped_column(Text)
    stream_lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancel_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    prompt: Mapped[str | None] = mapped_column(Text)
    pushback: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # G8 Slack bridge: a reply from the mirrored thread (its ts and its Slack author), or
    # the ts of the post that mirrored this message.
    slack_ts: Mapped[str | None] = mapped_column(Text)
    slack_user_id: Mapped[str | None] = mapped_column(Text)


class DiscussionChange(TenantScoped, Base):
    __tablename__ = "discussion_changes"
    __table_args__ = (
        CheckConstraint(_in("kind", CHANGE_KINDS), name="kind"),
        CheckConstraint(
            f"rationale IS NULL OR char_length(rationale) <= {MAX_RATIONALE}", name="rationale"
        ),
        CheckConstraint(_in("proposed_by_kind", PROPOSED_BY_KINDS), name="proposed_by_kind"),
        CheckConstraint(_in("status", CHANGE_STATUSES), name="status"),
        Index("ix_discussion_changes_status", "discussion_id", "status"),
    )

    discussion_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("discussions.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # What it changes, e.g. {"document_id", "section_key"}.
    target: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # Validated by the kind's model (oracle.discussions.kinds).
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # An approver's edit before acting (G3).
    edited_payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    rationale: Mapped[str | None] = mapped_column(Text)
    # The findings it rests on: [{"intake_id", "finding_id"}] (3.4).
    basis: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    proposed_by_kind: Mapped[str] = mapped_column(Text, nullable=False)
    proposed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    from_message_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussion_messages.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="proposed", server_default="proposed"
    )
    suggested_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    suggested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # C1b pushback and the reason it was overridden, filled by G3.
    pushback: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    override_reason: Mapped[str | None] = mapped_column(Text)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)
    # What acting created: a staged change, a proposal, a basis, a question.
    result_ref: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    lock_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    updated_at: Mapped[datetime] = _updated_at()

    __mapper_args__ = {"version_id_col": lock_version}


class DiscussionInboxItem(TenantScoped, Base):
    """G6: a person's Inbox row for being invited into a discussion or mentioned in it.
    Written with the message or the add; done when they read past it or dismiss it;
    deleted when they are removed. "Changes proposed" rows are derived, not stored."""

    __tablename__ = "discussion_inbox_items"
    __table_args__ = (
        CheckConstraint(_in("kind", INBOX_KINDS), name="kind"),
        Index(
            "uq_discussion_inbox_invited",
            "user_id",
            "discussion_id",
            unique=True,
            postgresql_where=text("kind = 'invited'"),
        ),
        Index(
            "uq_discussion_inbox_mentioned",
            "user_id",
            "message_id",
            unique=True,
            postgresql_where=text("kind = 'mentioned'"),
        ),
        Index("ix_discussion_inbox_open", "user_id", postgresql_where=text("done_at IS NULL")),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    discussion_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("discussions.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussion_messages.id", ondelete="CASCADE")
    )
    by_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
