import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, LargeBinary, Text, Uuid, text
from sqlalchemy.dialects.postgresql import JSONB
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


FOLLOWUP_KINDS = ("provider_revoke", "runtime_cancel")
FOLLOWUP_STATUSES = ("pending", "done", "failed")


class DisableFollowup(TenantScoped, Base):
    """An outbound call a member's disable still owes, made after the disable commits
    (never under the company-wide review gate): revoking an OAuth grant at a provider,
    or cancelling a running SwarmCloud workflow. A failed call stays ``pending`` and the
    ticker retries it; after ``MAX_ATTEMPTS`` it is ``failed`` (audited either way).

    For a provider revoke the connection's encrypted credential is kept here, and only
    here, until the call is done: the connection row itself is deleted with the disable.
    """

    __tablename__ = "member_disable_followups"
    __table_args__ = (
        CheckConstraint(_in("kind", FOLLOWUP_KINDS), name="kind"),
        CheckConstraint(_in("status", FOLLOWUP_STATUSES), name="status"),
        Index("ix_member_disable_followups_status", "status"),
    )

    # The disabled member.
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # The connection (provider_revoke) or the run segment (runtime_cancel).
    subject_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # provider_revoke: provider, auth_mode, account; runtime_cancel: run_id, workflow_id.
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    key_version: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    # What the last call returned ("revoked", "failed", "not_applicable", "cancelled"...).
    outcome: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
