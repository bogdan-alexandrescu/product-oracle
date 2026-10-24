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
    SmallInteger,
    Text,
    UniqueConstraint,
    Uuid,
    false,
    func,
    text,
    true,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from oracle.db import Base, TenantScoped
from oracle.trash.models import Trashable, trashed_index

DOCUMENT_STATUSES = ("draft", "in_review", "approved")
# "spec": a technical brief or engineering spec built from an approved PRD (CR-09).
# H4 (migration 0020_strategy): a product vision and a product strategy.
# H8 (migration 0022_updates): a board update's product section or an investor update.
DOCUMENT_KINDS = ("prd", "roadmap", "spec", "vision", "strategy", "update", "pricing")
# H8: who sees a document. "company": every member (S3); "approvers": owners and approvers
# only (oracle.docs.visibility), the default of an update.
DOCUMENT_VISIBILITIES = ("company", "approvers")
# O1f: a section belongs to the brief layer or is detail (oracle.docs.layers).
SECTION_LAYERS = ("brief", "detail")
BRIEF_SOURCES = ("draft", "template", "full_heading", "none")
# "oracle": the baseline itself (oracle.docs.schemas.CitationSource); added by migration
# 0017_citation_source_oracle.
CITATION_SOURCES = ("slack", "notion", "gdocs", "github", "fireflies", "upload", "web", "oracle")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class Document(Trashable, TenantScoped, Base):
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("tenant_id", "slug"),
        CheckConstraint(_in("status", DOCUMENT_STATUSES), name="status"),
        CheckConstraint(_in("kind", DOCUMENT_KINDS), name="kind"),
        CheckConstraint(_in("visibility", DOCUMENT_VISIBILITIES), name="visibility"),
        trashed_index("documents"),
        # The few documents that are not company-wide (oracle.docs.visibility).
        Index(
            "ix_documents_visibility",
            "tenant_id",
            "visibility",
            postgresql_where=text("visibility <> 'company'"),
        ),
    )

    slug: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="draft")
    template: Mapped[str | None] = mapped_column(Text)
    template_version: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="prd")
    # Theme key (oracle.templates.models.Theme), picked when the draft starts.
    theme: Mapped[str | None] = mapped_column(Text)
    # H8: "approvers" hides the document from commenters and viewers on every read path
    # (oracle.docs.visibility).
    visibility: Mapped[str] = mapped_column(Text, nullable=False, server_default="company")
    # Built-in model jobs (oracle.jobs) an owner turned off for this document; all on
    # by default.
    disabled_llm_jobs: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default="{}"
    )
    # E1: a PRD's "Derive for each new draft" switch (an owner's); on by default.
    draft_roadmap_auto: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=true())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    versions: Mapped[list["DocumentVersion"]] = relationship(
        back_populates="document", order_by="DocumentVersion.number", passive_deletes=True
    )


class DocumentVersion(TenantScoped, Base):
    __tablename__ = "document_versions"
    __table_args__ = (
        UniqueConstraint("document_id", "number"),
        UniqueConstraint("document_id", "content_hash"),
        CheckConstraint(_in("brief_source", BRIEF_SOURCES), name="brief_source"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    markdown: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    front_matter: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    snapshot: Mapped[str | None] = mapped_column(Text)
    # List of {"code": "locked_section_changed", "message": ..., "section_keys": [...]}.
    warnings: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    # Notes on how the version came in that are not about its content, e.g.
    # {"code": "base_version_missing", ...}: imported without a base version, so nothing
    # checked it keeps the changes made since the version it was written on.
    notes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, server_default="[]")
    # User id or API token id; no FK because it can be either.
    imported_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Who approved it (user or API token id); null on approvals before 0013.
    approved_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # The API token the approval was given through, when a token acted (C2).
    approved_token_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True)
    # The MCP OAuth grant (oauth_tokens.family_id) the approval was given through (C2).
    approved_grant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True)
    # A lapsed approval (approver demoted or disabled, token revoked) moves here and
    # approved_at / approved_by are cleared: it never counts again (C2).
    approval_lapsed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approval_lapsed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    approval_lapse_reason: Mapped[str | None] = mapped_column(Text)
    # Every approval of this version that lapsed, oldest first (approved_at, approved_by,
    # approved_token_id, approved_grant_id, lapsed_at, reason): a new approval clears
    # approval_lapsed_* but never this, so the history is not only in the audit log.
    approval_lapses: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default="[]", default=list
    )
    # Optimistic concurrency: the version number an edit started from. An import whose
    # base is older than the latest version, and that changes a section changed since,
    # is a conflict (no silent last-write-wins). Null: not given (legacy imports).
    base_number: Mapped[int | None] = mapped_column(Integer)
    # Where the brief layer came from: the draft's front matter, its template's markers,
    # a "Full version" heading, or none (the version opens on the full document).
    brief_source: Mapped[str] = mapped_column(Text, nullable=False, server_default="none")
    # Provenance: the PRD version a roadmap version was built from (O4b).
    source_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="SET NULL"), index=True
    )

    document: Mapped[Document] = relationship(back_populates="versions")
    sections: Mapped[list["Section"]] = relationship(
        order_by="Section.ordinal", passive_deletes=True
    )
    citations: Mapped[list["Citation"]] = relationship(passive_deletes=True)


def _content_hash(context: Any) -> str:
    return context.get_current_parameters()["content_hash"]


class Section(TenantScoped, Base):
    __tablename__ = "sections"
    __table_args__ = (
        UniqueConstraint("version_id", "section_key"),
        CheckConstraint(_in("layer", SECTION_LAYERS), name="layer"),
    )

    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    section_key: Mapped[str] = mapped_column(Text, nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    level: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    heading: Mapped[str] = mapped_column(Text, nullable=False)
    body_md: Mapped[str] = mapped_column(Text, nullable=False, default="")
    body_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    citation_keys: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default="{}"
    )
    layer: Mapped[str] = mapped_column(Text, nullable=False, server_default="detail")
    # The review revision (CR-06): the text plus the citation entries it cites and its
    # brief-layer membership (oracle.docs.parser.section_revision). Approvals, section
    # edits and patches bind to it. Defaults to the content hash (a detail section that
    # cites nothing).
    revision: Mapped[str] = mapped_column(Text, nullable=False, default=_content_hash)


class Citation(TenantScoped, Base):
    __tablename__ = "citations"
    __table_args__ = (
        UniqueConstraint("version_id", "cite_key"),
        CheckConstraint(_in("source", CITATION_SOURCES), name="source"),
        CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)", name="confidence"
        ),
    )

    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    cite_key: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    ref: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    excerpt: Mapped[str | None] = mapped_column(Text)
    retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # What the writer computed for the citation (migration 0019_citation_confidence). The
    # source item it read, when the company has that item; null otherwise.
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("source_items.id", ondelete="SET NULL"), index=True
    )
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    confidence_note: Mapped[str | None] = mapped_column(Text)
    low_confidence: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
