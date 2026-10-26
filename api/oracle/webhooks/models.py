"""Outbound webhooks (I1, migration 0055_webhooks).

``webhooks``: an address outside Oracle that Oracle calls when something happens, with the
event types it wants and its signing secret, encrypted with :mod:`oracle.crypto` (Oracle
signs with it, so it cannot be a hash). The secret is never returned by any endpoint but
create's and rotate's own answer, nor logged or audited. ``webhook_events``: one row per
event captured in the transaction of the change (:func:`oracle.webhooks.service.capture`),
ids only. ``webhook_deliveries``: one attempt to send one event to one webhook (the
delivery lane fills it).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

WEBHOOK_STATUSES = ("active", "paused")
PAUSED_REASONS = ("manual", "failing", "gone", "creator_disabled", "creator_demoted")
DELIVERY_STATUSES = ("pending", "retrying", "succeeded", "failed", "withheld")


class Webhook(TenantScoped, Base):
    __tablename__ = "webhooks"
    __table_args__ = (
        CheckConstraint("char_length(name) BETWEEN 1 AND 80", name="name"),
        CheckConstraint(_in("status", WEBHOOK_STATUSES), name="status"),
        CheckConstraint(_in("paused_reason", PAUSED_REASONS), name="paused_reason"),
        # capture(): is any active webhook of the company subscribed? One indexed read.
        Index("ix_webhooks_active", "tenant_id", postgresql_where=text("status = 'active'")),
    )

    name: Mapped[str] = mapped_column(Text, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    host: Mapped[str] = mapped_column(Text, nullable=False)
    # Checked against oracle.webhooks.events.EVENT_TYPES by the API.
    event_types: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    api_version: Mapped[str] = mapped_column(Text, nullable=False)
    # Q2: owners-and-approvers events, only on an owner's webhook, turned on by an owner.
    include_approvers_content: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="active", server_default="active"
    )
    paused_reason: Mapped[str | None] = mapped_column(Text)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    key_version: Mapped[int] = mapped_column(Integer, nullable=False)
    secret_hint: Mapped[str] = mapped_column(Text, nullable=False)
    # The 24-hour rotation overlap: the old secret still signs until it expires.
    previous_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    previous_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    secret_rotated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # The user, or the user-less API token, that created it ("own webhooks").
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class WebhookEvent(TenantScoped, Base):
    __tablename__ = "webhook_events"
    __table_args__ = (
        Index(
            "ix_webhook_events_new",
            "tenant_id",
            "occurred_at",
            postgresql_where=text("fanned_out_at IS NULL"),
        ),
    )

    # evt_<ulid>: the payload's id and the receivers' idempotency key.
    public_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Ids and codes only; titles and links are read at send time.
    subject: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    approvers_only: Mapped[bool] = mapped_column(Boolean, nullable=False)
    fanned_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class WebhookDelivery(TenantScoped, Base):
    __tablename__ = "webhook_deliveries"
    __table_args__ = (
        CheckConstraint(_in("status", DELIVERY_STATUSES), name="status"),
        Index(
            "ix_webhook_deliveries_due",
            "tenant_id",
            "next_at",
            postgresql_where=text("status IN ('pending', 'retrying')"),
        ),
        Index("ix_webhook_deliveries_log", "webhook_id", text("last_at DESC")),
    )

    webhook_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("webhooks.id", ondelete="CASCADE"), nullable=False
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("webhook_events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    next_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    http_status: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    # A code: timeout, connect, not_public, redirect, tls.
    error: Mapped[str | None] = mapped_column(Text)
    response_excerpt: Mapped[str | None] = mapped_column(Text)
    body: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # 0056: where it went (the URL may change later) and the headers sent, the signature
    # truncated (oracle.webhooks.sign.shown).
    host: Mapped[str | None] = mapped_column(Text)
    headers: Mapped[dict[str, str] | None] = mapped_column(JSONB)
    redelivery_of: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("webhook_deliveries.id", ondelete="SET NULL")
    )
