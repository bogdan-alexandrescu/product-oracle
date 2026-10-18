"""The account pool's tables (migration 0007). SwarmCloud's Firestore documents as rows.

``claude_accounts``                SwarmCloud's ``accounts/{id}``; the two Secret Manager
                                   secrets become two encrypted columns: the PAIR
                                   (``{base}-refresh``, read only by the refresher) and
                                   the ACCESS token (``{base}``, what a call reads)
``claude_account_holds``           ``account_holds/{assignment_id}``, the hold log
``claude_account_signins``         ``account_auth/{state}``, a started browser sign-in
``claude_sweep_leases``            ``sweep_leases/quota-sweep``, one per company
``claude_fallback_credentials``    the tenant secret: a setup-token or API key used
                                   when no account is registered

Every table is tenant-scoped: a company's pool serves that company only.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

ACCOUNT_STATES = ("AVAILABLE", "PAUSED", "DRAINING", "REAUTH_REQUIRED")
FALLBACK_KINDS = ("plan", "api_key")


class ClaudeAccount(TenantScoped, Base):
    __tablename__ = "claude_accounts"
    __table_args__ = (
        UniqueConstraint("tenant_id", "label"),
        CheckConstraint(_in("state", ACCOUNT_STATES), name="state"),
    )

    label: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False, default="anthropic")
    state: Mapped[str] = mapped_column(Text, nullable=False, default="AVAILABLE")
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    state_before_reauth: Mapped[str | None] = mapped_column(Text)
    windows: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    holds: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    assigned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unreadable_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_refresh_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_refresh_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # The pair (Claude Code's saved-login shape), encrypted with oracle.crypto.
    credential_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    credential_key_version: Mapped[int | None] = mapped_column(Integer)
    # The access token alone, written after the pair; what a call reads.
    access_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    access_key_version: Mapped[int | None] = mapped_column(Integer)
    # User or API token that added it; no FK because it can be either.
    added_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class ClaudeAccountHold(TenantScoped, Base):
    """One hold's lifetime, written in the same transaction as the account's ``holds``."""

    __tablename__ = "claude_account_holds"
    __table_args__ = (
        UniqueConstraint("assignment_id"),
        Index("ix_claude_account_holds_account_assigned", "account_id", "assigned_at"),
    )

    assignment_id: Mapped[str] = mapped_column(Text, nullable=False)
    # No FK: a record outlives its account (closed as account_removed).
    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    task_id: Mapped[str | None] = mapped_column(Text)
    attempt_id: Mapped[str | None] = mapped_column(Text)
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end: Mapped[str | None] = mapped_column(Text)
    hold_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Retention: rows past this are deleted by the sweep (Firestore's TTL policy).
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    swapped_from: Mapped[str | None] = mapped_column(Text)
    swapped_from_reason: Mapped[str | None] = mapped_column(Text)
    swapped_to: Mapped[str | None] = mapped_column(Text)
    swapped_to_reason: Mapped[str | None] = mapped_column(Text)


class ClaudeAccountSignin(TenantScoped, Base):
    """A browser sign-in between its authorize URL and its pasted code."""

    __tablename__ = "claude_account_signins"
    __table_args__ = (UniqueConstraint("state"),)

    state: Mapped[str] = mapped_column(Text, nullable=False)
    # Server-side: a PKCE verifier the browser holds proves nothing.
    verifier: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    # The user or API token that started it; only it may finish it.
    started_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)


class ClaudeSweepLease(TenantScoped, Base):
    """One sweep exchanges at a time; also records whether the sweep is alive."""

    __tablename__ = "claude_sweep_leases"
    __table_args__ = (UniqueConstraint("tenant_id"),)

    holder: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    released: Mapped[bool] = mapped_column(nullable=False, default=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_outcome: Mapped[str | None] = mapped_column(Text)


class ClaudeFallbackCredential(TenantScoped, Base):
    """The credential built-in jobs use while no account is registered."""

    __tablename__ = "claude_fallback_credentials"
    __table_args__ = (
        UniqueConstraint("tenant_id"),
        CheckConstraint(_in("kind", FALLBACK_KINDS), name="kind"),
    )

    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # "Claude setup-token …abcd" / "Anthropic API key …abcd"; never the value.
    label: Mapped[str] = mapped_column(Text, nullable=False)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    key_version: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
