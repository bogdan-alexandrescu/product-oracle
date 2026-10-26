"""Share links and their view log (spec-O5 §3; migration 0073_share_links).

A share link shows one publication of one roadmap, in one audience, to whoever has its
address **and its passcode** (owner answer O5-Q5, changed), until it expires or is
revoked. Only the token's sha256 and the passcode's argon2 hash are stored; both are
shown once. The view log counts browsers, never people (O5-Q4): no address, no user
agent string, no identity.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped

AUDIENCES = ("board", "team", "engineering", "public")
VIEW_KINDS = ("page", "download")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class ShareLink(TenantScoped, Base):
    __tablename__ = "share_links"
    __table_args__ = (
        CheckConstraint(_in("audience", AUDIENCES), name="audience"),
        CheckConstraint("char_length(label) BETWEEN 1 AND 120", name="label"),
        Index("ix_share_links_doc", "tenant_id", "document_id", "created_at"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    publication_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_publications.id"), nullable=False
    )
    audience: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    # sha256 of 32 random bytes; the token is shown once.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # argon2 of the passcode (O5-Q5); the passcode is shown once.
    passcode_hash: Mapped[str] = mapped_column(Text, nullable=False)
    # Bumped by a rotation: every cookie signed for an older one stops opening the link.
    passcode_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    passcode_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    passcode_window_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_reason: Mapped[str | None] = mapped_column(Text)
    # Revoked because its creator left or was demoted, or its document changed: listed
    # to owners in the Inbox (Re-share, Dismiss) until dismissed (O5-Q10).
    inbox_dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    allow_download: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    follow_latest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    views: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refused_window_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refused_in_window: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class ShareLinkView(TenantScoped, Base):
    """One page view or download. Counts only: never an address or an identity."""

    __tablename__ = "share_link_views"
    __table_args__ = (
        CheckConstraint(_in("kind", VIEW_KINDS), name="kind"),
        Index("ix_share_link_views", "share_link_id", "viewed_at"),
    )

    share_link_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("share_links.id", ondelete="CASCADE"), nullable=False
    )
    viewed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # HMAC(link secret, cookie id): counts distinct browsers, not people.
    browser_key: Mapped[str] = mapped_column(Text, nullable=False)
    # "Chrome", "Safari", "Firefox", "Edge" or "Other"; from the user agent, nothing else.
    browser_family: Mapped[str | None] = mapped_column(Text)
    # Only when the load balancer gives one (O5-Q4); never an address.
    country: Mapped[str | None] = mapped_column(Text)
