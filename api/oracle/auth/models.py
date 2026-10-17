from datetime import datetime
from typing import Literal

from sqlalchemy import CheckConstraint, DateTime, Text, UniqueConstraint
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


class ApiToken(TenantScoped, Base):
    __tablename__ = "api_tokens"
    __table_args__ = (CheckConstraint(_in("role", ROLES), name="role"),)

    name: Mapped[str] = mapped_column(Text, nullable=False)
    # sha256 hex of the raw token; globally unique so a Bearer token resolves its tenant.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # The role the token acts with.
    role: Mapped[str] = mapped_column(Text, nullable=False, default="owner", server_default="owner")
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
