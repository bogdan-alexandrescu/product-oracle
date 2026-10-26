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

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Index, Text, Uuid, text
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
