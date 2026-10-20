import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

SOURCE_KINDS = ("upload", "github", "slack", "notion", "fireflies", "google_docs")
SOURCE_STATUSES = ("active", "paused", "error", "needs_attention")
ITEM_KINDS = (
    "file",
    "page",
    "message",
    "thread",
    "issue",
    "pull_request",
    "release",
    "milestone",
    "readme",
    "doc",
    "transcript",
)
# Server defaults of the pin-stability columns (migration 0014_intake).
XID = "(pg_current_xact_id()::text)::bigint"
TXN_SNAPSHOT = "pg_current_snapshot()::text"
# The generated full-text column of source_item_versions (kept in step with migration 0002).
SEARCH_EXPRESSION = "to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || content)"


class Source(TenantScoped, Base):
    """What one user pulls in through one of their connections (S5, per user).

    Visible only to its owner (S3 revised 2026-10-17): items reach other users only
    as evidence the owner adds to the shared baseline.
    """

    __tablename__ = "sources"
    __table_args__ = (
        UniqueConstraint("owner_user_id", "name"),
        CheckConstraint(_in("kind", SOURCE_KINDS), name="kind"),
        CheckConstraint(_in("status", SOURCE_STATUSES), name="status"),
    )

    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The owner's connection the connector syncs with; null for uploads.
    connection_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("connections.id", ondelete="SET NULL"), index=True
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # The owner's allowlist: repos, channel ids, root pages. Never secrets.
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    last_error: Mapped[str | None] = mapped_column(Text)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Connector-defined incremental sync position (oracle.sources.base.CursorCheckpoint).
    cursor: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class SourceItem(TenantScoped, Base):
    __tablename__ = "source_items"
    __table_args__ = (
        UniqueConstraint("source_id", "external_id"),
        CheckConstraint(_in("kind", ITEM_KINDS), name="kind"),
    )

    source_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("sources.id", ondelete="CASCADE"), nullable=False
    )
    external_id: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    author: Mapped[str | None] = mapped_column(Text)
    # Visibility in the source (S3), e.g. {"visibility": "private", "members": [...]}.
    acl: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    # Where in the selection the item came from (a Fireflies meeting id and series key, a
    # Notion root), so narrowing can delete it on save without asking the provider.
    provenance: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The transaction that deleted it (pin stability, see Snapshot.txn_snapshot).
    deleted_xid: Mapped[int | None] = mapped_column(BigInteger)
    # The newest version; items and versions reference each other, hence use_alter.
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey(
            "source_item_versions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_source_items_current_version_id_source_item_versions",
        ),
    )


class SourceItemVersion(TenantScoped, Base):
    """Content of an item as fetched. Written only when the content hash changes."""

    __tablename__ = "source_item_versions"
    __table_args__ = (
        # Pinned reads: newest version per item with fetched_at <= as_of.
        Index("ix_source_item_versions_item_id_fetched_at", "item_id", "fetched_at"),
        Index("ix_source_item_versions_search", "search", postgresql_using="gin"),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("source_items.id", ondelete="CASCADE"), nullable=False
    )
    # Copied from the item when the version is written: the title and link a share
    # freezes with the text (S6, titles and links). A Notion link carries the title.
    title: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    search: Mapped[str] = mapped_column(
        TSVECTOR, Computed(SEARCH_EXPRESSION, persisted=True), nullable=True
    )
    # The transaction that wrote it. A pinned read keeps a version only if this
    # transaction had committed when the snapshot was taken; NULL (older rows) counts
    # as committed.
    xid: Mapped[int | None] = mapped_column(BigInteger, server_default=text(XID))


class Snapshot(TenantScoped, Base):
    """A point in time a run reads sources at."""

    __tablename__ = "snapshots"

    label: Mapped[str | None] = mapped_column(Text)
    as_of: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # User id or API token id; no FK because it can be either.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # The database's transaction snapshot when the pin was taken (pg_snapshot as text).
    # ``as_of`` alone is not enough: a version is stamped when it is written, not when
    # its transaction commits, so a sync that began before the pin and commits after it
    # would otherwise join the pinned set (oracle.sources.items.pinned_at).
    txn_snapshot: Mapped[str | None] = mapped_column(Text, server_default=text(TXN_SNAPSHOT))


class BrowseCall(TenantScoped, Base):
    """Provider calls made while browsing a connection for a source picker (S5): what a
    connection may still spend is counted here, so every API process sees the same
    budget (oracle.sources.fireflies_browse)."""

    __tablename__ = "browse_calls"

    connection_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("connections.id", ondelete="CASCADE"), nullable=False, index=True
    )
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    calls: Mapped[int] = mapped_column(Integer, nullable=False)
