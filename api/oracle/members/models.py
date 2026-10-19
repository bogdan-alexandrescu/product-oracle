import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, LargeBinary, Text, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from oracle.auth.models import ROLES
from oracle.db import Base, TenantScoped
from oracle.docs.models import _in


class Invite(TenantScoped, Base):
    """Pre-assigns a role to an email; the first sign-in with that email takes it."""

    __tablename__ = "invites"
    __table_args__ = (
        CheckConstraint(_in("role", ROLES), name="role"),
        CheckConstraint("email = lower(email)", name="email_lowercase"),
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
    # User id or API token id; no FK because it can be either.
    invited_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


FOLLOW_UP_KINDS = ("provider_revoke", "run_cancel")
FOLLOW_UP_STATUSES = ("pending", "done", "failed")


class MemberFollowUp(TenantScoped, Base):
    """An outbound call a disable owes, made after the disable commits (C2): revoking a
    connection's grant at its provider, cancelling a run segment at the runtime. Kept
    out of the disable's transaction so the company-wide review gate is never held
    across a network call; its outcome is recorded here and retried from the tick
    (``oracle.members.service.run_follow_ups``) until it succeeds or gives up."""

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
    # encrypted, kept only until the revoke is done (then cleared).
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
