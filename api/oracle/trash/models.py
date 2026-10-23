"""Trash columns and entries (#482, migration 0041_trash)."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Text,
    Uuid,
    false,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

from oracle.db import Base, TenantScoped

# What can be deleted on its own: a document (PRD, roadmap, spec, update, ...), an intake
# (a brief) or a run.
ROOT_TYPES = ("document", "intake", "run")
# Days a deleted artifact waits in Trash before the ticker purges it.
RETENTION_DAYS = 30


class Trashable:
    """``deleted_at`` set: in Trash. Every read leaves it out (oracle.trash.filter)."""

    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # User or API token id; no FK because it can be either.
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    deleted_reason: Mapped[str | None] = mapped_column(Text)

    @declared_attr
    def trash_entry_id(cls) -> Mapped[uuid.UUID | None]:  # noqa: N805
        # The delete it went with: restoring the entry brings it back.
        return mapped_column(Uuid, ForeignKey("trash_entries.id", ondelete="SET NULL"))


class TrashEntry(TenantScoped, Base):
    """One delete: its root and everything that went with it, restored together."""

    __tablename__ = "trash_entries"
    __table_args__ = (
        CheckConstraint("root_type IN ('document', 'intake', 'run')", name="root_type"),
        Index("ix_trash_entries_purge_after", "purge_after"),
    )

    root_type: Mapped[str] = mapped_column(Text, nullable=False)
    root_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    # {type, id, slug, title, kind} of the root and of each dependent, as deleted.
    root: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, server_default="[]")
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    deleted_by_name: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    # Whether a published copy (Notion, Google Docs, Slack) stays where it is.
    published: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=false())
    purge_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


def trashed_index(table: str) -> Index:
    """The partial index a trashable table carries: its rows in Trash."""
    return Index(
        f"ix_{table}_trashed", "tenant_id", "id", postgresql_where=text("deleted_at IS NOT NULL")
    )
