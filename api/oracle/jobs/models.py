"""Built-in model jobs and the suggestions they leave on feedback items.

A job (``llm_jobs``) is one unit of work for Oracle's own model calls on a document:
``review_comments`` (classify, group, suggest, push back), ``reporting`` (resolution
report and what changed) or ``refinement`` (a revised section). Jobs run one at a time
per document, from ``oracle tick`` and the local background worker.

A suggestion (``llm_suggestions``) is what ``review_comments`` drafts for one feedback
item. Nothing in it changes the document: an approver accepts, edits or dismisses it,
and accepted section text reaches the document only through a refinement that an
approver accepts in turn.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

JOB_KINDS = ("review_comments", "reporting", "refinement")
JOB_STATUSES = ("queued", "running", "succeeded", "failed", "cancelled")
CLASSIFICATIONS = ("question", "change_request", "factual_correction", "approval", "other")
SUGGESTION_KINDS = ("section_text", "answer", "none", "duplicate")
SUGGESTION_STATUSES = ("open", "accepted", "dismissed", "applied", "superseded")


class LlmJob(TenantScoped, Base):
    __tablename__ = "llm_jobs"
    __table_args__ = (
        CheckConstraint(_in("kind", JOB_KINDS), name="kind"),
        CheckConstraint(_in("status", JOB_STATUSES), name="status"),
        Index("ix_llm_jobs_document_status", "document_id", "status"),
        Index("ix_llm_jobs_status_created", "status", "created_at"),
    )

    kind: Mapped[str] = mapped_column(Text, nullable=False)
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), index=True
    )
    section_key: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="queued")
    # What the job was asked (version number, since, suggestion ids, instruction) and
    # the prompt file it ran with.
    input: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # The pool account that ran the call (label kept even if the account is removed);
    # null when the fallback credential did (``via`` says which).
    account_label: Mapped[str | None] = mapped_column(Text)
    via: Mapped[str | None] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(Text)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error: Mapped[str | None] = mapped_column(Text)
    # When no Claude account could take the call: the pool's reason and next reset.
    error_reason: Mapped[str | None] = mapped_column(Text)
    next_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # User id or API token id; null when Oracle queued it itself (a comment arrived).
    requested_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class LlmSuggestion(TenantScoped, Base):
    __tablename__ = "llm_suggestions"
    __table_args__ = (
        CheckConstraint(_in("classification", CLASSIFICATIONS), name="classification"),
        CheckConstraint(_in("kind", SUGGESTION_KINDS), name="kind"),
        CheckConstraint(_in("status", SUGGESTION_STATUSES), name="status"),
        Index("ix_llm_suggestions_document_status", "document_id", "status"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    feedback_item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("feedback_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("llm_jobs.id", ondelete="SET NULL"), index=True
    )
    # The version number the suggestion was drafted against.
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    classification: Mapped[str] = mapped_column(Text, nullable=False)
    # Items that say the same thing share a group; the first one carries the suggestion
    # and the others point at it (kind "duplicate").
    group_key: Mapped[str | None] = mapped_column(Text)
    duplicate_of: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("feedback_items.id", ondelete="SET NULL")
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    section_key: Mapped[str | None] = mapped_column(Text)
    # Proposed section body (markdown) for section_text, the answer for answer.
    text: Mapped[str | None] = mapped_column(Text)
    # An approver's edit; accepted text is edited_text when set, else text.
    edited_text: Mapped[str | None] = mapped_column(Text)
    rationale: Mapped[str | None] = mapped_column(Text)
    # C1b: {"reason": ..., "sources": [{"ref", "kind", "title", "url", "excerpt",
    # "confidence"}]} when the feedback contradicts confirmed goals or high-confidence
    # evidence. Raised once per feedback item.
    pushback: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    # Why an approver kept their call over a pushback (logged for later review).
    override_reason: Mapped[str | None] = mapped_column(Text)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    applied_in_version: Mapped[int | None] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
