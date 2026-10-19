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
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

VERDICTS = ("approved", "changes_requested", "rejected")
FEEDBACK_KINDS = ("comment", "section_review", "general")
FEEDBACK_STATUSES = ("open", "addressed", "declined", "superseded")


class Comment(TenantScoped, Base):
    __tablename__ = "comments"

    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    section_key: Mapped[str] = mapped_column(Text, nullable=False)
    # W3C TextQuoteSelector: {"exact": ..., "prefix": ..., "suffix": ...}. Null on replies.
    anchor: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # User id (or API token id); no FK because it can be either.
    author_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("comments.id", ondelete="CASCADE"), index=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SectionReview(TenantScoped, Base):
    """Verdict history; the latest row per (version_id, section_key) wins."""

    __tablename__ = "section_reviews"
    __table_args__ = (
        CheckConstraint(_in("verdict", VERDICTS), name="verdict"),
        Index("ix_section_reviews_version_section", "version_id", "section_key", "created_at"),
    )

    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), nullable=False
    )
    section_key: Mapped[str] = mapped_column(Text, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    reviewer_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # The section's content hash the verdict was given on (sections.content_hash), so an
    # approval is tied to an exact section revision. Null on verdicts before 0013.
    section_hash: Mapped[str | None] = mapped_column(Text)


class FeedbackItem(TenantScoped, Base):
    __tablename__ = "feedback_items"
    __table_args__ = (
        CheckConstraint(_in("kind", FEEDBACK_KINDS), name="kind"),
        CheckConstraint(_in("status", FEEDBACK_STATUSES), name="status"),
        Index("ix_feedback_items_document_status", "document_id", "status"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    # Version NUMBERS (DocumentVersion.number) within the document, not ids.
    raised_on_version: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    comment_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("comments.id", ondelete="SET NULL")
    )
    section_review_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("section_reviews.id", ondelete="SET NULL")
    )
    section_key: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    addressed_in_version: Mapped[int | None] = mapped_column(Integer)
    resolution_note: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
