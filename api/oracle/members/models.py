import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    LargeBinary,
    Text,
    Uuid,
    false,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from oracle.auth.models import ENGINEERING_LEAD_ROLE, ROLES
from oracle.db import Base, TenantScoped
from oracle.docs.models import _in


class Invite(TenantScoped, Base):
    """Pre-assigns a role to an email; the first sign-in with that email takes it."""

    __tablename__ = "invites"
    __table_args__ = (
        CheckConstraint(_in("role", ROLES), name="role"),
        CheckConstraint("email = lower(email)", name="email_lowercase"),
        CheckConstraint(ENGINEERING_LEAD_ROLE, name="engineering_lead_role"),
        # One open invite per email; accepted and revoked ones are history.
        Index(
            "uq_invites_tenant_id_email_open",
            "tenant_id",
            "email",
            unique=True,
            postgresql_where=text("accepted_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    email: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    # A3: the first sign-in lands as an engineering lead (never with role viewer).
    engineering_lead: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    # User id or API token id; no FK because it can be either.
    invited_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


FOLLOW_UP_KINDS = ("provider_revoke", "run_cancel")
# pending: retried by the tick, by time; failed: still not done after the retry window,
# no more automatic retries (an owner's Retry or Dismiss in the Inbox); done; dismissed:
# an owner gave up on it.
FOLLOW_UP_STATUSES = ("pending", "done", "failed", "dismissed")


class MemberFollowUp(TenantScoped, Base):
    """An outbound call a disable owes, made after the disable commits (C2): revoking a
    connection's grant at its provider, cancelling a run segment at the runtime. Kept
    out of the disable's transaction so the company-wide review gate is never held
    across a network call; its outcome is recorded here and retried from the tick
    (``oracle.members.service.run_follow_ups``), with a backoff, for 24 hours; a provider
    revoke still not done keeps its copy of the credential and is shown to owners in the
    Inbox (Retry, Dismiss) until it succeeds or an owner dismisses it."""

    __tablename__ = "member_follow_ups"
    __table_args__ = (
        CheckConstraint(_in("kind", FOLLOW_UP_KINDS), name="kind"),
        CheckConstraint(_in("status", FOLLOW_UP_STATUSES), name="status"),
    )

    member_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # The connection (deleted by the disable) or the run segment the call is for.
    target_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    # provider_revoke: the connection's provider, auth mode and its credential, still
    # encrypted, kept only until the revoke is done or an owner dismisses it (then
    # cleared).
    provider: Mapped[str | None] = mapped_column(Text)
    auth_mode: Mapped[str | None] = mapped_column(Text)
    ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    key_version: Mapped[int | None] = mapped_column(Integer)
    # run_cancel: the runtime's workflow id.
    workflow_id: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # The last attempt's outcome ("revoked", "failed", "cancelled", ...).
    outcome: Mapped[str | None] = mapped_column(Text)
    last_error: Mapped[str | None] = mapped_column(Text)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # When the tick may try a pending one again (a backoff after each failure); None: now.
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The owner who dismissed it (a user id or an API token id).
    dismissed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
