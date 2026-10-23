import uuid
from datetime import UTC, datetime, timedelta

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
    false,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from oracle.auth.models import ENGINEERING_LEAD_ROLE, NAME_LENGTH, ROLES
from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

# granted: the invitee holds IAP's accessor role on Oracle's backend services; pending:
# not yet (the grant failed, or the invite predates per-invite access; Retry grants it);
# skipped: no backend services configured (ORACLE_IAP_BACKENDS empty: local and dev).
INVITE_ACCESS = ("granted", "pending", "skipped")
# queued: a background send owes it; sent; failed (after its one retry); not_sent: no
# sender configured (ORACLE_MAIL_PROVIDER, ORACLE_MAIL_SENDER).
INVITE_EMAIL = ("queued", "sent", "failed", "not_sent")
# A5: an invite is claimable this long after it was made or last resent.
INVITE_TTL = timedelta(days=14)
# pending: waiting for an owner (or an approver); approved: an invite was made for it;
# declined; closed: they became a member another way (an invite, or the rule changed).
ACCESS_REQUEST_STATUSES = ("pending", "approved", "declined", "closed")


class AccessRequest(TenantScoped, Base):
    """Someone from the company's email domains signed in with Google without an invite
    under the ``request`` rule (A5): they wait until an owner approves (an invite is made)
    or declines. One pending row per email; ``created_at`` is when they first asked."""

    __tablename__ = "access_requests"
    __table_args__ = (
        CheckConstraint("email = lower(email)", name="email_lowercase"),
        CheckConstraint(_in("status", ACCESS_REQUEST_STATUSES), name="status"),
        CheckConstraint("note IS NULL OR char_length(note) <= 500", name="note_length"),
        CheckConstraint(f"role IS NULL OR {_in('role', ROLES)}", name="role"),
        Index(
            "uq_access_requests_tenant_id_email_pending",
            "tenant_id",
            "email",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )

    email: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    note: Mapped[str | None] = mapped_column(Text)
    # Their last refused sign-in (touched at most every 10 minutes).
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # A user id or an API token id; no FK, like the other *_by.
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The role it was approved with.
    role: Mapped[str | None] = mapped_column(Text)
    invite_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("invites.id", ondelete="SET NULL")
    )


# The owner's note to the invitee (#203): plain text, never HTML.
INVITE_MESSAGE_MAX = 500


class Invite(TenantScoped, Base):
    """Pre-assigns a role to an email; the first sign-in with that email takes it."""

    __tablename__ = "invites"
    __table_args__ = (
        CheckConstraint(_in("role", ROLES), name="role"),
        CheckConstraint("email = lower(email)", name="email_lowercase"),
        CheckConstraint(ENGINEERING_LEAD_ROLE, name="engineering_lead_role"),
        CheckConstraint(_in("access", INVITE_ACCESS), name="access"),
        CheckConstraint(_in("email_status", INVITE_EMAIL), name="email_status"),
        CheckConstraint(NAME_LENGTH, name="name_length"),
        CheckConstraint(
            f"message IS NULL OR char_length(message) <= {INVITE_MESSAGE_MAX}",
            name="message_length",
        ),
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
    # What happened to it (#242): its IAP access and its email (oracle.members.delivery).
    access: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    access_error: Mapped[str | None] = mapped_column(Text)
    access_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    email_status: Mapped[str] = mapped_column(Text, nullable=False, server_default="not_sent")
    email_error: Mapped[str | None] = mapped_column(Text)
    # When it got its email status (queued: when the send was owed).
    email_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # A5: the name the inviter gave; the user takes it at their first sign-in.
    name: Mapped[str | None] = mapped_column(Text)
    # A5: not claimed at sign-in from then on (14 days from creation or the last resend).
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC) + INVITE_TTL,
        server_default=text("now() + interval '14 days'"),
    )
    resent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resend_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # The access request it was made for, when an owner or an approver approved one.
    access_request_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("access_requests.id", ondelete="SET NULL", use_alter=True)
    )
    # The owner's note to the invitee (#203): sent in the email and by Resend.
    message: Mapped[str | None] = mapped_column(Text)


FOLLOW_UP_KINDS = ("provider_revoke", "run_cancel", "iap_revoke", "iap_grant")
# pending: retried by the tick, by time; failed: still not done after the retry window,
# no more automatic retries (an owner's Retry or Dismiss in the Inbox; an access change,
# #245: retried once a day, and an owner's Retry); done; dismissed: an owner gave up on it.
FOLLOW_UP_STATUSES = ("pending", "done", "failed", "dismissed")


class MemberFollowUp(TenantScoped, Base):
    """An outbound call a disable owes, made after the disable commits (C2): revoking a
    connection's grant at its provider, cancelling a run segment at the runtime; or a
    change to a person's Google IAP access that failed (#242: a revoke, a removal or a
    restore; ``oracle.members.delivery``). Kept out of the disable's transaction so the
    company-wide review gate is never held across a network call; its outcome is
    recorded here and retried from the tick
    (``oracle.members.service.run_follow_ups``), with a backoff, for 24 hours; a provider
    revoke still not done keeps its copy of the credential and is shown to owners in the
    Inbox (Retry, Dismiss) until it succeeds or an owner dismisses it; an access change
    still failing is retried once a day and shown to owners in the Inbox (Retry, #245)
    until it succeeds or is no longer needed."""

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
    # iap_revoke, iap_grant (#242): the address whose Google IAP access a revoke, a
    # removal or a restore failed to change (oracle.members.delivery); member_id and
    # target_id are the member's id, or the revoked invite's.
    email: Mapped[str | None] = mapped_column(Text)
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
