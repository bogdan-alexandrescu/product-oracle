"""Simple S2 (#723) tables: Oracle's date suggestions for undated roadmap items
(oracle.simple.suggestions). Simple S3a: the change engine's sessions and changes
(oracle.simple.changes).

One row per suggestion: ``open`` until a person with the right accepts it (the item takes
its dates, ``date_source = 'accepted'``), edits it (the item takes the person's dates) or
dismisses it. An item has at most one open suggestion; the daily regeneration replaces it.
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

SUGGESTION_STATUSES = ("open", "accepted", "edited", "dismissed")
SESSION_KINDS = ("editing", "meeting")
CHANGE_STATUSES = ("applied", "proposed", "accepted", "declined", "undone")


class RoadmapDateSuggestion(TenantScoped, Base):
    __tablename__ = "roadmap_date_suggestions"
    __table_args__ = (
        CheckConstraint(_in("status", SUGGESTION_STATUSES), name="status"),
        CheckConstraint("end_date >= start_date", name="span"),
        Index(
            "uq_roadmap_date_suggestions_open",
            "item_id",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("roadmap_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    # One sentence: why these dates.
    basis: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SimpleSession(TenantScoped, Base):
    """One person's editing session, or a meeting's: the changes made in it undo step by
    step while it is open. Closed by its starter, or by the minute tick after 30 minutes
    without a change (oracle.simple.changes.close_idle). A person has at most one open
    editing session."""

    __tablename__ = "simple_sessions"
    __table_args__ = (
        CheckConstraint(_in("kind", SESSION_KINDS), name="kind"),
        Index(
            "uq_simple_sessions_open_editing",
            "started_by",
            unique=True,
            postgresql_where=text("kind = 'editing' AND closed_at IS NULL"),
        ),
    )

    kind: Mapped[str] = mapped_column(Text, nullable=False)
    started_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_change_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SimpleChange(TenantScoped, Base):
    """One change made in Simple (oracle.simple.changes): ``applied`` (an owner's or the
    decider's), ``proposed`` to ``routed_to`` then ``accepted`` or ``declined``, or an
    ``undone`` row that reverses the change ``undoes_id`` (history is never deleted).
    ``before``/``after``: the fields the change writes, as they were and as they became;
    an op that moves several items keys them by item id."""

    __tablename__ = "simple_changes"
    __table_args__ = (
        CheckConstraint(_in("status", CHANGE_STATUSES), name="status"),
        Index(
            "uq_simple_changes_undoes",
            "undoes_id",
            unique=True,
            postgresql_where=text("undoes_id IS NOT NULL"),
        ),
        Index("ix_simple_changes_document_at", "document_id", "at"),
    )

    session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("simple_sessions.id", ondelete="SET NULL"), index=True
    )
    # The roadmap document of the target item.
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE")
    )
    op: Mapped[str] = mapped_column(Text, nullable=False)
    target: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    before: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    after: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str | None] = mapped_column(Text)
    decision_reason: Mapped[str | None] = mapped_column(Text)
    # Who decides a proposal: the roadmap's decider, else its owner, else the company's
    # owners (#723 owner answer); empty for every other status.
    routed_to: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    undoes_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("simple_changes.id", ondelete="CASCADE")
    )
    # S3b: the working drafts an applied change of a versioned document wrote (one per
    # roadmap it touched); empty for a proposal and for non-versioned targets.
    draft_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )


DRAFT_STATUSES = ("working", "submitted", "approved", "discarded")
TASK_STATUSES = ("todo", "doing", "done", "dropped")
ACTION_STATUSES = ("open", "done", "dropped")


class SimpleDraft(TenantScoped, Base):
    """Simple S3b: the working draft of one versioned document (a roadmap's items): the
    applied changes of owners and the decider land here, never in the published version
    (oracle.simple.drafts). ``overlay`` holds each changed item's fields as the draft has
    them, keyed by the published item's id; ``base_version_id`` is the version it was
    opened on. Submitting imports the next version (``version_id``) through the
    roadmap's change-set path and the document's review policy; the decider's approval
    waits in ``decider_approval`` while required reviewers in ``waiting_on`` have not
    approved. At most one working draft per document; sessions join it
    (``simple_session_drafts``)."""

    __tablename__ = "simple_drafts"
    __table_args__ = (
        CheckConstraint(_in("status", DRAFT_STATUSES), name="status"),
        Index(
            "uq_simple_drafts_working",
            "document_id",
            unique=True,
            postgresql_where=text("status = 'working'"),
        ),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    base_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="SET NULL")
    )
    version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="working")
    overlay: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    # Who took part: every session's starter that joined it, and meeting attendees.
    participant_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # {"by", "at", "session_id"}: the decider's approval, held until every required
    # reviewer has approved.
    decider_approval: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    waiting_on: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SimpleSessionDraft(TenantScoped, Base):
    """Simple S3b: a session's working draft of one document (one per session and
    document); ``draft_version_id`` is the version the draft became once submitted."""

    __tablename__ = "simple_session_drafts"
    __table_args__ = (UniqueConstraint("session_id", "document_id"),)

    session_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("simple_sessions.id", ondelete="CASCADE"), nullable=False
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    draft_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("simple_drafts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    draft_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="SET NULL")
    )


class RoadmapItemTask(TenantScoped, Base):
    """Simple S3b: work under a roadmap item (#723 data model). Not versioned: owners and
    the decider change it directly, others propose (oracle.simple.targets). Anchored by
    the item's roadmap and key as well as its id, so a later version's item keeps it."""

    __tablename__ = "roadmap_item_tasks"
    __table_args__ = (
        CheckConstraint(_in("status", TASK_STATUSES), name="status"),
        Index("ix_roadmap_item_tasks_item", "roadmap_document_id", "item_key"),
    )

    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("roadmap_items.id", ondelete="SET NULL")
    )
    roadmap_document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    item_key: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="todo")
    due_date: Mapped[date | None] = mapped_column(Date)
    tracker_record_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tracker_records.id", ondelete="SET NULL")
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)


class SimpleActionItem(TenantScoped, Base):
    """Simple S3b: a meeting's (or an editing session's) action item (#723 data model),
    optionally under a roadmap item. ``meeting_id`` names S8's meeting (no key yet)."""

    __tablename__ = "simple_action_items"
    __table_args__ = (CheckConstraint(_in("status", ACTION_STATUSES), name="status"),)

    meeting_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("roadmap_items.id", ondelete="SET NULL")
    )
    roadmap_document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE")
    )
    item_key: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open")
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
