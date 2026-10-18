"""Storing, reading and refreshing a user's connections.

Other modules get a usable credential with :func:`get_credential`; it never hands out
another user's connection, refreshes OAuth tokens shortly before they expire, and
marks the connection ``expired`` or ``error`` (with ``last_error``) when that fails.
"""

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import crypto
from oracle.connections import oauth
from oracle.connections.models import Connection
from oracle.connections.providers import (
    CredentialRejected,
    Identity,
    Provider,
    ProviderUnavailable,
    get_provider,
)

# OAuth access tokens are refreshed this long before they expire.
REFRESH_MARGIN = timedelta(minutes=5)
HTTP_TIMEOUT = httpx.Timeout(20.0)


class ConnectionUnavailable(Exception):
    """No usable credential: not found, not the caller's, expired, revoked or failing."""

    def __init__(self, message: str, status: str | None = None):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Credential:
    connection_id: uuid.UUID
    provider: str
    auth_mode: str
    access_token: str
    # Non-secret extras kept with the token.
    extra: dict[str, Any] = field(default_factory=dict)


@asynccontextmanager
async def http_client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        yield client


def _seal(bundle: dict[str, Any]) -> bytes:
    return crypto.encrypt(json.dumps(bundle).encode())


def _open(conn: Connection) -> dict[str, Any]:
    return json.loads(crypto.decrypt(conn.ciphertext))


def _now() -> datetime:
    return datetime.now(UTC)


async def list_for_user(session: AsyncSession, user_id: uuid.UUID) -> list[Connection]:
    stmt = (
        select(Connection)
        .where(Connection.user_id == user_id)
        .order_by(Connection.provider, Connection.created_at)
    )
    return list((await session.scalars(stmt)).all())


async def get_own(
    session: AsyncSession, connection_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
) -> Connection | None:
    stmt = select(Connection).where(Connection.id == connection_id, Connection.user_id == user_id)
    if lock:
        stmt = stmt.with_for_update()
    return await session.scalar(stmt)


async def save(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    provider: Provider,
    auth_mode: str,
    identity: Identity,
    bundle: dict[str, Any],
    expires_at: datetime | None = None,
    scopes: list[str] | None = None,
    label: str | None = None,
) -> Connection:
    """Create the connection, or replace the credential of the same account (reconnect)."""
    conn = await session.scalar(
        select(Connection).where(
            Connection.user_id == user_id,
            Connection.provider == provider.key,
            Connection.account_id == identity.account_id,
        )
    )
    if conn is None:
        conn = Connection(user_id=user_id, provider=provider.key, account_id=identity.account_id)
        session.add(conn)
    conn.auth_mode = auth_mode
    conn.account_label = label or identity.label
    conn.ciphertext = _seal({**identity.extra, **bundle})
    conn.key_version = crypto.KEY_VERSION
    conn.scopes = scopes if scopes else identity.scopes
    conn.status = "active"
    conn.last_error = None
    conn.expires_at = expires_at
    conn.updated_at = _now()
    await session.flush()
    return conn


async def connect_token(
    session: AsyncSession,
    http: httpx.AsyncClient,
    *,
    user_id: uuid.UUID,
    provider: Provider,
    token: str,
    label: str | None = None,
) -> Connection:
    """Validate a pasted token with the provider, read the account, store it encrypted."""
    identity = await provider.identify(http, token)
    return await save(
        session,
        user_id=user_id,
        provider=provider,
        auth_mode="token",
        identity=identity,
        bundle={"access_token": token},
        label=label,
    )


async def connect_oauth(
    session: AsyncSession,
    http: httpx.AsyncClient,
    *,
    user_id: uuid.UUID,
    provider: Provider,
    tokens: oauth.Tokens,
) -> Connection:
    identity = await provider.identify(http, tokens.access_token)
    return await save(
        session,
        user_id=user_id,
        provider=provider,
        auth_mode="oauth",
        identity=identity,
        bundle=tokens.bundle(),
        expires_at=tokens.expires_at,
        scopes=tokens.scopes or identity.scopes,
    )


async def mark_failure(session: AsyncSession, conn: Connection, status: str, error: str) -> None:
    """Record why a connection stopped working. Commits."""
    conn.status = status
    conn.last_error = error[:500]
    conn.updated_at = _now()
    await session.commit()


async def _refresh(
    session: AsyncSession, conn: Connection, bundle: dict[str, Any], http: httpx.AsyncClient
) -> dict[str, Any]:
    provider = get_provider(conn.provider)
    client = oauth.client_for(provider) if provider else None
    refresh_token = bundle.get("refresh_token")
    if provider is None or client is None or not refresh_token:
        if conn.expires_at is not None and conn.expires_at <= _now():
            message = "The access token expired and cannot be refreshed; reconnect"
            await mark_failure(session, conn, "expired", message)
            raise ConnectionUnavailable(message, "expired")
        return bundle
    try:
        tokens = await oauth.refresh(http, provider, client, refresh_token)
    except CredentialRejected as e:
        await mark_failure(session, conn, "expired", f"Refresh refused: {e}")
        raise ConnectionUnavailable(
            f"{provider.name} refused to refresh; reconnect", "expired"
        ) from e
    except ProviderUnavailable as e:
        if conn.expires_at is not None and conn.expires_at > _now():
            # Still valid for a few minutes: use it and try again next time.
            conn.last_error = f"Refresh failed: {e}"[:500]
            return bundle
        await mark_failure(session, conn, "error", f"Refresh failed: {e}")
        raise ConnectionUnavailable(
            f"Cannot refresh the {provider.name} token right now", "error"
        ) from e
    bundle = {**bundle, **tokens.bundle()}
    conn.ciphertext = _seal(bundle)
    conn.key_version = crypto.KEY_VERSION
    conn.expires_at = tokens.expires_at
    if tokens.scopes:
        conn.scopes = tokens.scopes
    conn.last_error = None
    return bundle


async def credential_for(
    session: AsyncSession, conn: Connection, http: httpx.AsyncClient | None = None
) -> Credential:
    """A usable credential for a connection row already checked by the caller. Commits."""
    if conn.status != "active":
        raise ConnectionUnavailable(
            f"The {conn.provider} connection is {conn.status}; reconnect it", conn.status
        )
    try:
        bundle = _open(conn)
    except crypto.DecryptionError:
        await mark_failure(session, conn, "error", "The stored credential cannot be decrypted")
        raise ConnectionUnavailable(
            "The stored credential is unreadable; reconnect", "error"
        ) from None
    if (
        conn.auth_mode == "oauth"
        and conn.expires_at is not None
        and conn.expires_at - _now() <= REFRESH_MARGIN
    ):
        if http is None:
            async with http_client() as own:
                bundle = await _refresh(session, conn, bundle, own)
        else:
            bundle = await _refresh(session, conn, bundle, http)
    conn.last_used_at = _now()
    await session.commit()
    extra = {k: v for k, v in bundle.items() if k not in ("access_token", "refresh_token")}
    return Credential(
        connection_id=conn.id,
        provider=conn.provider,
        auth_mode=conn.auth_mode,
        access_token=bundle["access_token"],
        extra=extra,
    )


async def get_credential(
    session: AsyncSession,
    connection_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    http: httpx.AsyncClient | None = None,
) -> Credential:
    """The decrypted credential of ``user_id``'s own connection, refreshed if due.

    Raises :class:`ConnectionUnavailable` when the connection is missing, belongs to
    someone else, or cannot be used; failures are recorded on the row. Commits the
    session (the row is locked while a refresh runs, so concurrent callers do not spend
    a rotating refresh token twice).
    """
    conn = await get_own(session, connection_id, user_id, lock=True)
    if conn is None:
        raise ConnectionUnavailable("Connection not found")
    return await credential_for(session, conn, http)


async def revoke_at_provider(http: httpx.AsyncClient, conn: Connection) -> str:
    """Best effort, on disconnect: revoke a grant Oracle obtained through the provider's
    OAuth (GitHub, Slack, Google). Pasted personal tokens are the user's own and are not
    revoked. Never raises; returns what happened, for the audit log."""
    provider = get_provider(conn.provider)
    if conn.auth_mode != "oauth" or provider is None or provider.key not in oauth.REVOKERS:
        return "not_applicable"
    client = oauth.client_for(provider)
    if client is None:
        return "not_configured"
    try:
        bundle = _open(conn)
    except crypto.DecryptionError:
        return "unreadable"
    try:
        await oauth.revoke(http, provider, client, bundle)
    except (ProviderUnavailable, KeyError, ValueError):
        return "failed"
    return "revoked"


async def recheck(session: AsyncSession, http: httpx.AsyncClient, conn: Connection) -> Connection:
    """Reconnect without a new credential: refresh (OAuth) or re-validate (token)."""
    provider = get_provider(conn.provider)
    assert provider is not None
    try:
        bundle = _open(conn)
    except crypto.DecryptionError:
        await mark_failure(session, conn, "error", "The stored credential cannot be decrypted")
        raise ConnectionUnavailable(
            "The stored credential is unreadable; paste it again", "error"
        ) from None
    if conn.auth_mode == "oauth":
        if not bundle.get("refresh_token") or oauth.client_for(provider) is None:
            raise ConnectionUnavailable("Sign in again to reconnect", conn.status)
        conn.status = "active"
        bundle = await _refresh(session, conn, {**bundle}, http)
        token = bundle["access_token"]
    else:
        token = bundle["access_token"]
    try:
        identity = await provider.identify(http, token)
    except CredentialRejected as e:
        await mark_failure(session, conn, "expired", str(e))
        raise ConnectionUnavailable(f"{e}; paste a new token", "expired") from e
    except ProviderUnavailable as e:
        await mark_failure(session, conn, "error", str(e))
        raise
    conn.status = "active"
    conn.last_error = None
    if identity.scopes:
        conn.scopes = identity.scopes
    conn.updated_at = _now()
    await session.flush()
    return conn
