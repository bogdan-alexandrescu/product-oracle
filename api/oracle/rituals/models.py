"""Rituals, their occurrences and who read each pre-read (migration 0037_rituals)."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _json, _lock_version, _updated_at, _uuids

RITUAL_STATUSES = ("active", "paused")
OCCURRENCE_STATUSES = ("scheduled", "ready", "held", "skipped", "missed", "failed")
SUMMARY_STATES = ("none", "running", "ready", "failed", "not_started")


class Ritual(TenantScoped, Base):
    """A recurring review with an owner, attendees, a schedule, a length, a lead time and
    a kind (oracle.rituals.kinds)."""

    __tablename__ = "rituals"
    __table_args__ = (
        CheckConstraint("duration_min BETWEEN 5 AND 480", name="duration_min"),
        CheckConstraint("prep_hours BETWEEN 0 AND 168", name="prep_hours"),
        CheckConstraint(_in("status", RITUAL_STATUSES), name="status"),
        Index(
            "ux_rituals_builtin_kind",
            "tenant_id",
            "kind",
            unique=True,
            postgresql_where=text("builtin"),
        ),
        Index(
            "ix_rituals_due",
            "tenant_id",
            "next_due_at",
            postgresql_where=text("status = 'active'"),
        ),
    )

    updated_at: Mapped[datetime] = _updated_at()
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    # oracle.rituals.schedule.Schedule
    schedule: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    duration_min: Mapped[int] = mapped_column(Integer, nullable=False)
    prep_hours: Mapped[int] = mapped_column(Integer, nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    attendee_ids: Mapped[list[uuid.UUID]] = _uuids()
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    next_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()


class RitualOccurrence(TenantScoped, Base):
    """One instance of a ritual: its due time, its pre-read, its state and its notes."""

    __tablename__ = "ritual_occurrences"
    __table_args__ = (
        UniqueConstraint("ritual_id", "due_at"),
        CheckConstraint(_in("status", OCCURRENCE_STATUSES), name="status"),
        CheckConstraint(_in("summary_state", SUMMARY_STATES), name="summary_state"),
    )

    updated_at: Mapped[datetime] = _updated_at()
    ritual_id: Mapped[uuid.UUID] = _fk("rituals", nullable=False)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="scheduled")
    # {"built_at", "blocks": [{key, title, as_of, rows}], "markdown"}
    pre_read: Mapped[dict[str, Any]] = _json()
    pre_read_built_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    skip_reason: Mapped[str | None] = mapped_column(Text)
    decision_ids: Mapped[list[uuid.UUID]] = _uuids()
    held_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    held_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    summary_run_id: Mapped[uuid.UUID | None] = _fk("runs", "SET NULL")
    # The run's summary, copied when it succeeds.
    summary: Mapped[str | None] = mapped_column(Text)
    summary_state: Mapped[str] = mapped_column(Text, nullable=False, server_default="none")
    # Why a summary failed or did not start.
    summary_note: Mapped[str | None] = mapped_column(Text)


class RitualRead(TenantScoped, Base):
    """A member opened an occurrence's pre-read: its Inbox row is done, for them only."""

    __tablename__ = "ritual_reads"
    __table_args__ = (UniqueConstraint("occurrence_id", "user_id"),)

    occurrence_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ritual_occurrences.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    read_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
