"""Shared by the source pickers' browse endpoints (Slack channels, GitHub repos, ...).

Each picker lists what the signed-in user's own connection can read, so the browser
never holds a provider token: Oracle calls the provider and returns names and ids.

The lists are open to the person in the browser and to MCP clients acting as that
person (S5, owner 2026-10-19). So that a search cannot hammer the provider, an answer is
kept for :data:`CACHE_SECONDS` per connection and question, and a connection may reach
the provider at most :data:`RATE_LIMIT` times per :data:`RATE_WINDOW` seconds, each page
read counting once (cached answers are free). Both live in this process: with several
API instances each keeps its own, which still bounds what one person can send.
"""

import logging
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
# Provider calls (each page counts) per connection per window: Slack allows about 20
# conversations.list calls a minute (Tier 2) for a token.
RATE_LIMIT = 20
RATE_WINDOW = 60
# Expired answers and idle call counts are dropped at most this often.
SWEEP_SECONDS = 5

log = logging.getLogger(__name__)

_clock = time.monotonic
_cache: dict[tuple[uuid.UUID, tuple[Any, ...]], tuple[float, Any]] = {}
_calls: dict[uuid.UUID, deque[float]] = {}
_last_sweep = -math.inf


def reset() -> None:
    """Forget every cached answer and call count (tests)."""
    global _last_sweep
    _cache.clear()
    _calls.clear()
    _last_sweep = -math.inf


def _sweep(now: float) -> None:
    """Drop expired answers and the call counts of connections idle for a window."""
    global _last_sweep
    if 0 <= now - _last_sweep < SWEEP_SECONDS:
        return
    _last_sweep = now
    for k in [k for k, (at, _) in _cache.items() if now - at >= CACHE_SECONDS]:
        del _cache[k]
    for k in [k for k, calls in _calls.items() if not calls or now - calls[-1] >= RATE_WINDOW]:
        del _calls[k]


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
    _sweep(now)
    if len(_cache) >= CACHE_ENTRIES:
        for k in [k for k, (at, _) in _cache.items() if now - at >= CACHE_SECONDS]:
            del _cache[k]
        while len(_cache) >= CACHE_ENTRIES:
            del _cache[next(iter(_cache))]
    _cache[(conn.id, key)] = (now, answer)


def _take(conn: Connection) -> int | None:
    """Count one provider call through ``conn``: None when admitted, else the seconds
    until one is."""
    now = _clock()
    _sweep(now)
    calls = _calls.setdefault(conn.id, deque())
    while calls and now - calls[0] >= RATE_WINDOW:
        calls.popleft()
    if len(calls) >= RATE_LIMIT:
        return max(1, math.ceil(RATE_WINDOW - (now - calls[0])))
    calls.append(now)
    return None


def admit(conn: Connection, name: str) -> None:
    """Count a request's first provider call through ``conn``; a 429 past RATE_LIMIT."""
    wait = _take(conn)
    if wait is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many {name} searches: try again in {wait} seconds",
            headers={"Retry-After": str(wait)},
        )


def admit_more(conn: Connection) -> bool:
    """Count a further page of the same request; False when the budget is spent (the
    request stops and answers what it read, with a cursor to resume)."""
    return _take(conn) is None


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
        credential = await service.credential_for(db, conn, touch=False)
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
        # The provider's own words go to the log, not into the answer.
        log.info("%s refused a browse call: %s", name, error)
        return HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"{name} refused the request: your sign-in may lack access, "
            "or an organization policy blocks it",
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
    log.warning("%s browse call failed: %s", name, error)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, f"{name} could not be read: try again")


def unreachable(name: str) -> HTTPException:
    """The provider could not be reached, or answered something that is not JSON."""
    return HTTPException(status.HTTP_502_BAD_GATEWAY, f"{name} could not be reached: try again")
