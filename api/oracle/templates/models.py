import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    false,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

TEMPLATE_KINDS = ("prd", "roadmap", "vision", "strategy")
THEME_KINDS = ("prd", "roadmap", "vision", "strategy", "any")


class Template(TenantScoped, Base):
    """A PRD or roadmap structure; documents.template holds its key.

    Users add, edit (a new version) and delete (archive) templates; built-ins come
    from docs/research/templates/.
    """

    __tablename__ = "templates"
    __table_args__ = (
        UniqueConstraint("tenant_id", "key"),
        CheckConstraint(_in("kind", TEMPLATE_KINDS), name="kind"),
    )

    key: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="prd")
    description: Mapped[str | None] = mapped_column(Text)
    builtin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    # Deleted templates are archived: documents that used them keep resolving.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TemplateVersion(TenantScoped, Base):
    """Immutable; documents.template_version holds ``str(version)``."""

    __tablename__ = "template_versions"
    __table_args__ = (UniqueConstraint("template_id", "version"),)

    template_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("templates.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    # Markdown skeleton: headings with {#section-id} and guidance under each.
    body: Mapped[str] = mapped_column(Text, nullable=False)
    required_sections: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default="{}"
    )
    # User id or API token id; no FK because it can be either.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class Theme(TenantScoped, Base):
    """How a PRD or roadmap looks in the app, HTML and PDF; documents.theme holds its key."""

    __tablename__ = "themes"
    __table_args__ = (
        UniqueConstraint("tenant_id", "key"),
        CheckConstraint(_in("kind", THEME_KINDS), name="kind"),
    )

    key: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="any")
    description: Mapped[str | None] = mapped_column(Text)
    # Design tokens: fonts, colours, spacing, page size.
    tokens: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    css: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    # O1g: a company theme's slide CSS, applied after the shared slide layout in Present
    # mode and the deck PDF. Built-in themes keep their slide variants in code (null).
    slide_css: Mapped[str | None] = mapped_column(Text)
    builtin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # User id or API token id; no FK because it can be either.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
