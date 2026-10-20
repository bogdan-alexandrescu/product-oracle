"""Shared by the source pickers' browse endpoints (Slack channels, GitHub repos, ...).

Each picker lists what the signed-in user's own connection can read, so the browser
never holds a provider token: Oracle calls the provider and returns names and ids.

The lists are open to the person in the browser and to MCP clients acting as that
person (S5, owner 2026-10-19). So that a search cannot hammer the provider, an answer is
kept for :data:`CACHE_SECONDS` per connection and question, and a connection may reach
the provider at most :data:`RATE_LIMIT` times per :data:`RATE_WINDOW` seconds (cached
answers are free). Both live in this process: with several API instances each keeps its
own, which still bounds what one person can send.
"""

import math
import time
import uuid
from collections import deque
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.connections import service
from oracle.connections.models import Connection
from oracle.sources.base import (
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorError,
    ConnectorForbidden,
    ConnectorRateLimited,
)

# What a browse call says when the provider gives no wait.
DEFAULT_RETRY_SECONDS = 60
CACHE_SECONDS = 60
# Answers kept at most; the oldest go first.
CACHE_ENTRIES = 2000
RATE_LIMIT = 20
RATE_WINDOW = 60

_clock = time.monotonic
_cache: dict[tuple[uuid.UUID, tuple[Any, ...]], tuple[float, Any]] = {}
_calls: dict[uuid.UUID, deque[float]] = {}


def reset() -> None:
    """Forget every cached answer and call count (tests)."""
    _cache.clear()
    _calls.clear()


def cached(conn: Connection, key: tuple[Any, ...]) -> Any | None:
    """The answer to ``key`` read through ``conn`` within the last CACHE_SECONDS."""
    hit = _cache.get((conn.id, key))
    if hit is None:
        return None
    stored_at, answer = hit
    if _clock() - stored_at >= CACHE_SECONDS:
        del _cache[(conn.id, key)]
        return None
    return answer


def remember(conn: Connection, key: tuple[Any, ...], answer: Any) -> None:
    now = _clock()
    if len(_cache) >= CACHE_ENTRIES:
        for k in [k for k, (at, _) in _cache.items() if now - at >= CACHE_SECONDS]:
            del _cache[k]
        while len(_cache) >= CACHE_ENTRIES:
            del _cache[next(iter(_cache))]
    _cache[(conn.id, key)] = (now, answer)


def admit(conn: Connection, name: str) -> None:
    """Count one call to the provider through ``conn``; a 429 past RATE_LIMIT."""
    now = _clock()
    calls = _calls.setdefault(conn.id, deque())
    while calls and now - calls[0] >= RATE_WINDOW:
        calls.popleft()
    if len(calls) >= RATE_LIMIT:
        wait = max(1, math.ceil(RATE_WINDOW - (now - calls[0])))
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many {name} searches: try again in {wait} seconds",
            headers={"Retry-After": str(wait)},
        )
    calls.append(now)


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
    if isinstance(error, ConnectorForbidden):
        # Refused for this request (a scope, an admin setting), not a dead token.
        return HTTPException(status.HTTP_403_FORBIDDEN, f"{name} refused the request: {error}")
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
