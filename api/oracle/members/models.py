import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Text, Uuid, text
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
