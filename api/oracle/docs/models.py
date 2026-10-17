import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from oracle.db import Base, TenantScoped

DOCUMENT_STATUSES = ("draft", "in_review", "approved")
CITATION_SOURCES = ("slack", "notion", "gdocs", "github", "fireflies", "upload", "web")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class Document(TenantScoped, Base):
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("tenant_id", "slug"),
        CheckConstraint(_in("status", DOCUMENT_STATUSES), name="status"),
        CheckConstraint("kind IN ('prd', 'roadmap')", name="kind"),
    )

    slug: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="draft")
    template: Mapped[str | None] = mapped_column(Text)
    template_version: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="prd")
    # Theme key (oracle.templates.models.Theme), picked when the draft starts.
    theme: Mapped[str | None] = mapped_column(Text)
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
    # User id or API token id; no FK because it can be either.
    imported_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    document: Mapped[Document] = relationship(back_populates="versions")
    sections: Mapped[list["Section"]] = relationship(
        order_by="Section.ordinal", passive_deletes=True
    )
    citations: Mapped[list["Citation"]] = relationship(passive_deletes=True)


class Section(TenantScoped, Base):
    __tablename__ = "sections"
    __table_args__ = (UniqueConstraint("version_id", "section_key"),)

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


class Citation(TenantScoped, Base):
    __tablename__ = "citations"
    __table_args__ = (
        UniqueConstraint("version_id", "cite_key"),
        CheckConstraint(_in("source", CITATION_SOURCES), name="source"),
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
