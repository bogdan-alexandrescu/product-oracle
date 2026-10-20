"""Shared by the source pickers' browse endpoints (Slack channels, GitHub repos, ...).

Each picker lists what the signed-in user's own connection can read, so the browser
never holds a provider token: Oracle calls the provider and returns names and ids.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.connections import service
from oracle.connections.models import Connection
from oracle.sources.base import (
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorError,
    ConnectorRateLimited,
)

# What a browse call says when the provider gives no wait.
DEFAULT_RETRY_SECONDS = 60


async def open_connection(
    db: AsyncSession, principal: Principal, connection_id: uuid.UUID, provider: str
) -> tuple[Connection, str]:
    """The caller's own ``provider`` connection and its access token (refreshed if due).

    Another user's connection, or one of another provider, is a 404; a connection that
    cannot be used (expired, revoked, failing) is a 409 saying to reconnect.
    """
    assert principal.user_id is not None
    conn = await service.get_own(db, connection_id, principal.user_id, lock=True)
    if conn is None or conn.provider != provider:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
    try:
        credential = await service.credential_for(db, conn)
    except service.ConnectionUnavailable as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    return conn, credential.access_token


async def provider_error(
    db: AsyncSession, conn: Connection, name: str, error: ConnectorError
) -> HTTPException:
    """Map a provider failure to what the picker shows. A rejected token marks the
    connection expired, as a sync does."""
    if isinstance(error, ConnectorRateLimited):
        wait = round(error.retry_after) if error.retry_after else DEFAULT_RETRY_SECONDS
        wait = max(wait, 1)
        return HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"{name} is busy: try again in {wait} seconds",
            headers={"Retry-After": str(wait)},
        )
    if isinstance(error, ConnectorAuthError):
        await service.mark_failure(db, conn, "expired", f"Rejected while browsing: {error}")
        return HTTPException(
            status.HTTP_409_CONFLICT, f"{name} rejected the connection: reconnect it"
        )
    if isinstance(error, ConnectorConfigError):
        message = str(error)
        return HTTPException(
            status.HTTP_409_CONFLICT, f"{message[:1].upper()}{message[1:]}: reconnect it"
        )
    return HTTPException(status.HTTP_502_BAD_GATEWAY, f"{name} could not be read: {error}")


def unreachable(name: str) -> HTTPException:
    """The provider could not be reached, or answered something that is not JSON."""
    return HTTPException(status.HTTP_502_BAD_GATEWAY, f"{name} could not be reached: try again")
