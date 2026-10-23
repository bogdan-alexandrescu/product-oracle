"""Requests (C1, migration 0020_requests): every feature request in one queue.

- ``request_themes``: a named group of requests about the same need, linked to the
  goals it serves. One live theme per title (case-insensitive); archiving frees it.
- ``product_requests``: one thing someone asked for, in their words, with who asked (as
  given), where it came from and its state: new, qualified (needs a confirmed goal,
  decision F3b), merged (into another request, ``merged_into_id``; chains count toward
  the root's mentions) or disqualified (with a reason). A request filed from a person's
  own source item carries a copy of the item's title, link, kind and an excerpt of at
  most 400 characters (decided 2026-10-21, C1 "Found items"): everyone who can see the
  request reads them, and they stay when the item goes. ``suggestion`` is what Oracle's
  triage proposes; it changes nothing until an approver accepts it.
- ``request_candidates``: possible requests Oracle's triage found in one person's own
  sources, visible to that person only until they file one (decision S6).
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
    Numeric,
    Text,
    UniqueConstraint,
    Uuid,
    text,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _json, _lock_version, _updated_at, _uuids

# ``in_app``: filed with New request on the Requests screen (#329, migration 0025).
CHANNELS = (
    "support",
    "sales",
    "team",
    "interview",
    "slack",
    "meeting",
    "doc",
    "other",
    "in_app",
)
ORIGINS = ("person", "oracle", "interview")
THEME_ORIGINS = ("person", "oracle")
REQUESTER_KINDS = ("customer", "team", "unknown")
STATES = ("new", "qualified", "merged", "disqualified")
DISQUALIFY_REASONS = ("no_goal", "out_of_scope", "duplicate", "not_a_request", "wont_do", "other")
CANDIDATE_STATUSES = ("open", "filed", "dismissed")
EXCERPT_MAX = 400


class RequestTheme(TenantScoped, Base):
    __tablename__ = "request_themes"
    __table_args__ = (
        CheckConstraint(_in("origin", THEME_ORIGINS), name="origin"),
        Index(
            "ux_request_themes_title",
            "tenant_id",
            text("lower(title)"),
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
        ),
    )

    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    # Confirmed goal entities (entities.id) the theme serves.
    goal_ids: Mapped[list[uuid.UUID]] = _uuids()
    origin: Mapped[str] = mapped_column(Text, nullable=False)
    # User or API token id, no FK, as elsewhere.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = _updated_at()
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}


class ProductRequest(TenantScoped, Base):
    __tablename__ = "product_requests"
    __table_args__ = (
        CheckConstraint(_in("channel", CHANNELS), name="channel"),
        CheckConstraint(_in("origin", ORIGINS), name="origin"),
        CheckConstraint(_in("requester_kind", REQUESTER_KINDS), name="requester_kind"),
        CheckConstraint(_in("state", STATES), name="state"),
        CheckConstraint(_in("disqualify_reason", DISQUALIFY_REASONS), name="disqualify_reason"),
        CheckConstraint(f"length(source_excerpt) <= {EXCERPT_MAX}", name="source_excerpt"),
        CheckConstraint("(state = 'merged') = (merged_into_id IS NOT NULL)", name="merged"),
        CheckConstraint(
            "(state = 'disqualified') = (disqualify_reason IS NOT NULL)", name="disqualified"
        ),
        CheckConstraint("merged_into_id IS NULL OR merged_into_id <> id", name="not_self"),
        Index("ix_product_requests_state", "tenant_id", "state", text("created_at DESC")),
    )

    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    origin: Mapped[str] = mapped_column(Text, nullable=False)
    requester_name: Mapped[str | None] = mapped_column(Text)
    requester_kind: Mapped[str] = mapped_column(
        Text, nullable=False, default="unknown", server_default="unknown"
    )
    # False for interview answers (decision V2e): the customer's words, not checked.
    verified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    source_item_id: Mapped[uuid.UUID | None] = _fk("source_items", "SET NULL")
    # Copied from the item when filed (C1 "Found items"), kept when the item goes.
    source_title: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    source_kind: Mapped[str | None] = mapped_column(Text)
    source_excerpt: Mapped[str | None] = mapped_column(Text)
    # The interview it came from (C3 Interviews, migration 0030_interviews).
    interview_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("interviews.id", ondelete="SET NULL")
    )
    state: Mapped[str] = mapped_column(Text, nullable=False, default="new", server_default="new")
    merged_into_id: Mapped[uuid.UUID | None] = _fk("product_requests", "SET NULL")
    disqualify_reason: Mapped[str | None] = mapped_column(Text)
    decision_note: Mapped[str | None] = mapped_column(Text)
    theme_id: Mapped[uuid.UUID | None] = _fk("request_themes", "SET NULL")
    goal_ids: Mapped[list[uuid.UUID]] = _uuids()
    feature_id: Mapped[uuid.UUID | None] = _fk("entities", "SET NULL")
    document_id: Mapped[uuid.UUID | None] = _fk("documents", "SET NULL")
    intake_id: Mapped[uuid.UUID | None] = _fk("product_intakes", "SET NULL")
    # Oracle's triage proposal (oracle.requests.schemas.Suggestion), {} when none.
    suggestion: Mapped[dict[str, Any]] = _json()
    # User or API token ids, no FK, as elsewhere.
    filed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = _updated_at()
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}


class RequestCandidate(TenantScoped, Base):
    """A possible request Oracle's triage found in its owner's own source item."""

    __tablename__ = "request_candidates"
    __table_args__ = (
        CheckConstraint(_in("status", CANDIDATE_STATUSES), name="status"),
        UniqueConstraint("owner_user_id", "source_item_id", name="ux_request_candidates_item"),
    )

    owner_user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    run_id: Mapped[uuid.UUID | None] = _fk("runs", "SET NULL")
    source_item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("source_items.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    requester_name: Mapped[str | None] = mapped_column(Text)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    theme_title: Mapped[str | None] = mapped_column(Text)
    goal_ids: Mapped[list[uuid.UUID]] = _uuids()
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    rationale: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open", server_default="open")
    request_id: Mapped[uuid.UUID | None] = _fk("product_requests", "SET NULL")
    updated_at: Mapped[datetime] = _updated_at()
