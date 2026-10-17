"""OAuth clients, authorization codes and tokens. Only hashes of secrets are stored."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, Uuid
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped


class OAuthClient(TenantScoped, Base):
    """A public client (no secret) registered through ``POST /oauth/register``."""

    __tablename__ = "oauth_clients"

    # Random, globally unique: the token endpoint resolves the tenant from it.
    client_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    redirect_uris: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)


class OAuthCode(TenantScoped, Base):
    """A 10-minute, single-use authorization code bound to a PKCE challenge."""

    __tablename__ = "oauth_codes"

    # sha256 hex of the raw code.
    code_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    client_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("oauth_clients.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    redirect_uri: Mapped[str] = mapped_column(Text, nullable=False)
    # BASE64URL(SHA256(code_verifier)); S256 is the only method.
    code_challenge: Mapped[str] = mapped_column(Text, nullable=False)
    # Space-delimited, as on the wire.
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OAuthToken(TenantScoped, Base):
    """One access token and the refresh token issued with it.

    A refresh rotates the row: the old one is revoked and the new one points back at it
    (``rotated_from``). Every row descending from one code shares ``family_id``, so a
    replayed refresh token or code revokes the whole family.
    """

    __tablename__ = "oauth_tokens"

    # sha256 hex of the raw tokens.
    access_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    refresh_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    client_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("oauth_clients.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    refresh_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rotated_from: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("oauth_tokens.id", ondelete="SET NULL"), index=True
    )
    family_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    # The code the family was issued from (code replay revokes the family).
    code_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("oauth_codes.id", ondelete="SET NULL"), index=True
    )
