from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped


class User(TenantScoped, Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("tenant_id", "email"),
        CheckConstraint("role IN ('owner')", name="role"),
    )

    email: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, default="owner")


class ApiToken(TenantScoped, Base):
    __tablename__ = "api_tokens"

    name: Mapped[str] = mapped_column(Text, nullable=False)
    # sha256 hex of the raw token; globally unique so a Bearer token resolves its tenant.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
