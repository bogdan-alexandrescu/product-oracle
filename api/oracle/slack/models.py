"""G8 Slack bridge (migration 0047_slack_bridge): a discussion's link to its Slack thread,
the outbox the tick delivers, and the Slack events already processed. The outbox also
carries Slack pings to one member (migration 0055_slack_pings, oracle.slack.pings)."""

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
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

OUTBOX_OPS = ("root", "post", "update", "delete", "close", "ping")
OUTBOX_STATUSES = ("queued", "sent", "failed", "dropped")


class DiscussionSlackLink(TenantScoped, Base):
    __tablename__ = "discussion_slack_links"
    __table_args__ = (
        Index(
            "uq_discussion_slack_links_live",
            "discussion_id",
            unique=True,
            postgresql_where=text("unlinked_at IS NULL"),
        ),
        Index(
            "uq_discussion_slack_links_thread",
            "channel_id",
            "thread_ts",
            unique=True,
            postgresql_where=text("unlinked_at IS NULL"),
        ),
    )

    discussion_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("discussions.id", ondelete="CASCADE"), nullable=False
    )
    channel_id: Mapped[str] = mapped_column(Text, nullable=False)
    channel_name: Mapped[str] = mapped_column(Text, nullable=False)
    # Set when the root message is posted.
    thread_ts: Mapped[str | None] = mapped_column(Text)
    linked_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    unlinked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    unlinked_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Set when Slack gave up on the root message: the mirror has no thread, its queued items
    # are failed with ``error`` (Slack's reason, shown on the discussion), nothing more is
    # queued for it.
    failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)


class SlackOutbox(TenantScoped, Base):
    __tablename__ = "slack_outbox"
    __table_args__ = (
        CheckConstraint(_in("op", OUTBOX_OPS), name="op"),
        CheckConstraint(_in("status", OUTBOX_STATUSES), name="status"),
        # A ping is for one member and has no thread; every other op is a thread's.
        CheckConstraint(
            "(op = 'ping') = (link_id IS NULL AND recipient_id IS NOT NULL)", name="target"
        ),
        Index("ix_slack_outbox_due", "status", "next_try_at"),
    )

    link_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussion_slack_links.id", ondelete="CASCADE")
    )
    # A ping's member (oracle.slack.pings).
    recipient_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE")
    )
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussion_messages.id", ondelete="SET NULL")
    )
    op: Mapped[str] = mapped_column(Text, nullable=False)
    # {"text"} for root, post and close; {"ts", "text"} for update; {"ts"} for delete;
    # {"event", "text", "channel_text"} for a ping.
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="queued", server_default="queued"
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    next_try_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    slack_ts: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)


class SlackEventSeen(Base):
    """Slack retries an event it thinks was missed: each ``event_id`` is processed once.
    Rows older than 7 days are deleted by the tick."""

    __tablename__ = "slack_events_seen"

    event_id: Mapped[str] = mapped_column(Text, primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
