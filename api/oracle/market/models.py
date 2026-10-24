"""H7 Competitive digest's tables (migration 0052_market).

- ``competitors``: the alternatives a company tracks: direct, indirect or the status quo.
- ``competitor_pages``: an alternative's public pages Oracle reads once a week
  (oracle.market.watch), each read stored in ``competitor_page_snapshots``.
- ``competitor_changes``: the dated change log: a page change (the line diff between two
  reads) or a web finding a person promoted.
- ``competitor_web_findings``: what the monthly digest run found on the open web, not
  vetted until a person promotes or dismisses it.
- ``positioning``: one record per company, six fields of items; ``positioning_suggestions``
  are a digest's proposed edits, each accepted or dismissed by a person.
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _json, _lock_version, _texts, _updated_at

KINDS = ("direct", "indirect", "status_quo")
STATUSES = ("active", "archived")
LABELS = ("pricing", "changelog", "product", "docs", "blog", "other")
PAGE_STATUSES = ("active", "paused", "blocked", "error")
ORIGINS = ("page", "web")
RATINGS = ("minor", "notable", "major")
RATED_BY = ("rule", "oracle", "person")
FINDING_KINDS = ("news", "review", "launch", "pricing", "other")
FINDING_STATUSES = ("open", "promoted", "dismissed")
FIELDS = (
    "alternatives",
    "unique_attributes",
    "value_and_proof",
    "best_fit_customers",
    "market_category",
    "trends",
)
ACTIONS = ("add", "replace", "remove")
SUGGESTION_STATUSES = ("open", "accepted", "dismissed")


class Competitor(TenantScoped, Base):
    __tablename__ = "competitors"
    __table_args__ = (
        CheckConstraint(_in("kind", KINDS), name="kind"),
        CheckConstraint(_in("status", STATUSES), name="status"),
        Index(
            "ux_competitors_name",
            "tenant_id",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    updated_at: Mapped[datetime] = _updated_at()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    website: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    aliases: Mapped[list[str]] = _texts()
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()


class CompetitorPage(TenantScoped, Base):
    __tablename__ = "competitor_pages"
    __table_args__ = (
        CheckConstraint(_in("label", LABELS), name="label"),
        CheckConstraint(_in("status", PAGE_STATUSES), name="status"),
        UniqueConstraint("competitor_id", "url"),
        Index(
            "ix_competitor_pages_due",
            "tenant_id",
            "last_checked_at",
            postgresql_where=text("status = 'active'"),
        ),
    )

    competitor_id: Mapped[uuid.UUID] = _fk("competitors", nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class CompetitorPageSnapshot(TenantScoped, Base):
    __tablename__ = "competitor_page_snapshots"

    page_id: Mapped[uuid.UUID] = _fk("competitor_pages", nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    final_url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    last_modified: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CompetitorWebFinding(TenantScoped, Base):
    __tablename__ = "competitor_web_findings"
    __table_args__ = (
        CheckConstraint(_in("kind", FINDING_KINDS), name="kind"),
        CheckConstraint(_in("status", FINDING_STATUSES), name="status"),
        Index("ix_web_findings_url", "tenant_id", "url"),
    )

    competitor_id: Mapped[uuid.UUID] = _fk("competitors", nullable=False)
    web_result_id: Mapped[uuid.UUID | None] = _fk("web_results", "SET NULL")
    run_id: Mapped[uuid.UUID | None] = _fk("runs", "SET NULL")
    occurrence_id: Mapped[uuid.UUID | None] = _fk("ritual_occurrences", "SET NULL")
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    excerpt: Mapped[str] = mapped_column(Text, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    host: Mapped[str] = mapped_column(Text, nullable=False)
    published_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dismiss_reason: Mapped[str | None] = mapped_column(Text)


class CompetitorChange(TenantScoped, Base):
    __tablename__ = "competitor_changes"
    __table_args__ = (
        CheckConstraint(_in("origin", ORIGINS), name="origin"),
        CheckConstraint(_in("rating", RATINGS), name="rating"),
        CheckConstraint(_in("rated_by", RATED_BY), name="rated_by"),
        CheckConstraint(
            "(origin = 'page') = (page_id IS NOT NULL AND after_id IS NOT NULL)", name="page"
        ),
        CheckConstraint("(origin = 'web') = (web_finding_id IS NOT NULL)", name="web"),
        Index("ix_competitor_changes_when", "tenant_id", text("detected_at DESC")),
    )

    competitor_id: Mapped[uuid.UUID] = _fk("competitors", nullable=False)
    origin: Mapped[str] = mapped_column(Text, nullable=False, server_default="page")
    page_id: Mapped[uuid.UUID | None] = _fk("competitor_pages")
    before_id: Mapped[uuid.UUID | None] = _fk("competitor_page_snapshots", "SET NULL")
    after_id: Mapped[uuid.UUID | None] = _fk("competitor_page_snapshots")
    web_finding_id: Mapped[uuid.UUID | None] = _fk("competitor_web_findings")
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    added_lines: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    removed_lines: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # [{"op": "+" | "-", "text": "…"}], at most oracle.market.diff.MAX_LINES.
    diff: Mapped[list[dict[str, Any]]] = _json("[]")
    rating: Mapped[str] = mapped_column(Text, nullable=False, server_default="minor")
    rated_by: Mapped[str] = mapped_column(Text, nullable=False, server_default="rule")
    summary: Mapped[str | None] = mapped_column(Text)
    occurrence_id: Mapped[uuid.UUID | None] = _fk("ritual_occurrences", "SET NULL")


class Positioning(TenantScoped, Base):
    """One per company (unique ``tenant_id``)."""

    __tablename__ = "positioning"
    __table_args__ = (UniqueConstraint("tenant_id"),)

    # {field: [{"id": "…", "text": "…"}]} over FIELDS.
    fields: Mapped[dict[str, Any]] = _json()
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    lock_version: Mapped[int] = _lock_version()


class PositioningSuggestion(TenantScoped, Base):
    __tablename__ = "positioning_suggestions"
    __table_args__ = (
        CheckConstraint(_in("field", FIELDS), name="field"),
        CheckConstraint(_in("action", ACTIONS), name="action"),
        CheckConstraint(_in("status", SUGGESTION_STATUSES), name="status"),
    )

    field: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    item_id: Mapped[str | None] = mapped_column(Text)
    text: Mapped[str | None] = mapped_column(Text)
    rationale: Mapped[str] = mapped_column(Text, nullable=False)
    # [{"kind": "change" | "web" | "request" | "source_item", "id": "…"}]
    refs: Mapped[list[dict[str, Any]]] = _json("[]")
    run_id: Mapped[uuid.UUID | None] = _fk("runs", "SET NULL")
    occurrence_id: Mapped[uuid.UUID | None] = _fk("ritual_occurrences", "SET NULL")
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
