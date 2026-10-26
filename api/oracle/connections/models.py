import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

# Data connectors, per user. Oracle's own model calls run on the company's Claude account
# pool (oracle.claude_accounts), not on a connection.
PROVIDERS = ("github", "slack", "notion", "fireflies", "google")
AUTH_MODES = ("oauth", "token")
CONNECTION_STATUSES = ("active", "expired", "revoked", "error")


class Connection(TenantScoped, Base):
    """One user's account at one provider. Integrations are per user (S5).

    The credential (an OAuth token bundle or a pasted personal token) is encrypted with
    oracle.crypto and never returned by any endpoint.
    """

    __tablename__ = "connections"
    __table_args__ = (
        UniqueConstraint("user_id", "provider", "account_id"),
        CheckConstraint(_in("provider", PROVIDERS), name="provider"),
        CheckConstraint(_in("auth_mode", AUTH_MODES), name="auth_mode"),
        CheckConstraint(_in("status", CONNECTION_STATUSES), name="status"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    auth_mode: Mapped[str] = mapped_column(Text, nullable=False)
    # The provider's stable id for the account (user id, workspace id, ...).
    account_id: Mapped[str] = mapped_column(Text, nullable=False)
    # What the UI shows: a login, a workspace name, an email.
    account_label: Mapped[str | None] = mapped_column(Text)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    key_version: Mapped[int] = mapped_column(Integer, nullable=False)
    scopes: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default="{}")
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    last_error: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Fireflies only: the GraphQL endpoint an owner set (https, checked by
    # oracle.sources.connectors.fireflies.check_endpoint); None reads Fireflies' own API.
    endpoint_url: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
