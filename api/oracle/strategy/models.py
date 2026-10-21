"""Drift findings and drift check runs (migration 0020_strategy).

A finding is stored so that a waiver survives the next check: one row per (kind,
subject), a null subject included. Each check upserts what it sees, resolves the open
ones it no longer sees, and leaves waived ones waived until their subject changes again
(``subject_version``: what the subject was when last seen).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

FINDING_KINDS = (
    "goal_without_strategy",
    "focus_without_goal",
    "outside_strategy",
    "stopped_but_planned",
    "strategy_review_due",
    "vision_review_due",
    "no_strategy",
)
SEVERITIES = ("info", "warning", "high")
SUBJECT_KINDS = ("entity", "roadmap_item", "document")
FINDING_STATUSES = ("open", "resolved", "waived")


class StrategyFinding(TenantScoped, Base):
    __tablename__ = "strategy_findings"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "kind", "subject_kind", "subject_id", postgresql_nulls_not_distinct=True
        ),
        CheckConstraint(_in("kind", FINDING_KINDS), name="kind"),
        CheckConstraint(_in("severity", SEVERITIES), name="severity"),
        CheckConstraint(_in("subject_kind", SUBJECT_KINDS), name="subject_kind"),
        CheckConstraint(_in("status", FINDING_STATUSES), name="status"),
        Index("ix_strategy_findings_status", "tenant_id", "status"),
    )

    kind: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    subject_kind: Mapped[str] = mapped_column(Text, nullable=False)
    subject_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Human-readable: "goal:activation", a roadmap item key, a document slug.
    subject_ref: Mapped[str] = mapped_column(Text, nullable=False)
    subject_version: Mapped[str | None] = mapped_column(Text)
    # The approved strategy version the finding was measured against.
    strategy_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="SET NULL")
    )
    # Rule-specific facts: the item's roadmap and horizon, the stop choice, the due date.
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open")
    waived_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    waived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    waive_reason: Mapped[str | None] = mapped_column(Text)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class StrategyCheck(TenantScoped, Base):
    """One drift check: why it ran (daily, approval, change, manual) and what it did."""

    __tablename__ = "strategy_checks"

    cause: Mapped[str] = mapped_column(Text, nullable=False)
    opened: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    resolved: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
