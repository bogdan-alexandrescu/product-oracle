import uuid
from datetime import datetime
from typing import Literal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

# Lowest to highest; oracle.authz compares by position.
ROLES = ("viewer", "commenter", "approver", "owner")
Role = Literal["viewer", "commenter", "approver", "owner"]


class User(TenantScoped, Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("tenant_id", "email"),
        CheckConstraint(_in("role", ROLES), name="role"),
    )

    email: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, default="owner")
    # Removing a member disables them (C2): the row stays, so every *_by reference and
    # the verdict history keep the name, but no sign-in path accepts them. An owner can
    # restore them (oracle.members.service).
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The owner (user or API token id) who disabled them; no FK, like the other *_by.
    disabled_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Session cookies signed before this are refused (C2): set by a disable and by a
    # restore, so a disable ends every session and a restored member signs in fresh.
    sessions_valid_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ApiToken(TenantScoped, Base):
    __tablename__ = "api_tokens"
    __table_args__ = (CheckConstraint(_in("role", ROLES), name="role"),)

    name: Mapped[str] = mapped_column(Text, nullable=False)
    # sha256 hex of the raw token; globally unique so a Bearer token resolves its tenant.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # The role the token acts with (ignored when the token acts for a user).
    role: Mapped[str] = mapped_column(Text, nullable=False, default="owner", server_default="owner")
    # A token with a user acts as that user: their role, connections and sources.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
