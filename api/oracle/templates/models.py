import uuid

from sqlalchemy import ForeignKey, Integer, Text, UniqueConstraint, Uuid
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped


class Template(TenantScoped, Base):
    """A PRD template; documents.template holds its key."""

    __tablename__ = "templates"
    __table_args__ = (UniqueConstraint("tenant_id", "key"),)

    key: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)


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
