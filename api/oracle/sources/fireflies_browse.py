"""Browsing a Fireflies connection for the source picker (S5, owner 2026-10-19).

Only the connection's owner can browse it, in the browser or through an MCP client
acting as them (owner, 2026-10-19); another user's connection reads as not found.
Fireflies is called server-side with the stored API key, which never reaches the
browser.

Browsing spends the person's Fireflies quota, so its cost is bounded per connection:
answers are cached for CACHE_SECONDS, and at most CALLS_PER_MINUTE and CALLS_PER_HOUR
Fireflies calls are made for browsing (a series list counts as SERIES_CALLS, the most it
makes); past that the routes answer 429. Cached answers cost nothing. Both live in the
API process's memory, so each API process keeps its own.
"""

import hashlib
import math
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Awaitable, Callable, Hashable
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from oracle.auth.deps import TenantDB
from oracle.connections import service as connections
from oracle.connections.models import Connection
from oracle.connections.router import ProviderHttp, UserPrincipal
from oracle.sources import base
from oracle.sources.connectors import fireflies
from oracle.sources.connectors.fireflies import FirefliesConnector, FirefliesForbidden, Meeting
from oracle.sources.service import InvalidError, _read_credential, redact

router = APIRouter(prefix="/v1", tags=["connections"])

CACHE_SECONDS = 60.0
CACHE_ENTRIES = 1000
CALLS_PER_MINUTE = 30
CALLS_PER_HOUR = 150
# The most Fireflies calls one series list makes.
SERIES_CALLS = fireflies.SERIES_PAGES

_clock = time.monotonic
_cache: OrderedDict[Hashable, tuple[float, object]] = OrderedDict()
# Per connection: when each Fireflies call (or reservation of several) was made.
_spent: dict[uuid.UUID, deque[tuple[float, int]]] = {}

RESPONSES: dict[int | str, dict[str, str]] = {
    429: {
        "description": "Fireflies is rate limiting the API key, or this connection has "
        "browsed too much for now; see Retry-After"
    },
    404: {"description": "Not one of your Fireflies connections"},
    409: {"description": "The connection cannot be used (reconnect it), or Fireflies refused"},
    422: {"description": "An invalid date range"},
    502: {"description": "Fireflies did not answer as expected"},
}


class FirefliesMeetingOut(BaseModel):
    id: str
    title: str
    date: datetime | None
    # Minutes of audio.
    duration: float | None
    organizer: str | None
    attendee_count: int
    # What a source's config.series holds to take this meeting's whole series.
    series_key: str
    series_title: str


class FirefliesMeetingPage(BaseModel):
    meetings: list[FirefliesMeetingOut]
    # Pass as ``cursor`` for the next page; null on the last one.
    next_cursor: str | None


class FirefliesSeriesOut(BaseModel):
    key: str
    title: str
    meeting_count: int
    last_date: datetime | None
    organizer: str | None


class FirefliesSeriesList(BaseModel):
    series: list[FirefliesSeriesOut]
    # True when there were more meetings than the list reads (the newest 500).
    truncated: bool


async def _fireflies_connection(db: TenantDB, connection_id: uuid.UUID, principal) -> Connection:
    conn = await connections.get_own(db, connection_id, principal.user_id)
    if conn is None or conn.provider != "fireflies":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fireflies connection not found")
    return conn


def reset_limits() -> None:
    """Forget cached answers and spent budgets (tests)."""
    _cache.clear()
    _spent.clear()


def _spend(connection_id: uuid.UUID, calls: int) -> None:
    """Reserve ``calls`` Fireflies calls for this connection, or answer 429."""
    now = _clock()
    spent = _spent.setdefault(connection_id, deque())
    while spent and spent[0][0] <= now - 3600:
        spent.popleft()
    for window, limit in ((60.0, CALLS_PER_MINUTE), (3600.0, CALLS_PER_HOUR)):
        recent = [(at, n) for at, n in spent if at > now - window]
        used = sum(n for _, n in recent)
        if used + calls > limit:
            # Wait until enough of the window's calls have aged out.
            freed, wait = 0, window
            for at, n in recent:
                freed += n
                if used - freed + calls <= limit:
                    wait = at + window - now
                    break
            seconds = max(1, math.ceil(wait))
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many Fireflies requests for this connection (they use your Fireflies "
                f"quota). Try again in {seconds} seconds.",
                {"Retry-After": str(seconds)},
            )
    spent.append((now, calls))


async def _cached(
    db: TenantDB, conn: Connection, key: Hashable, calls: int, call: Callable[..., Awaitable]
):
    """The answer of ``call`` for ``key``, from the cache when it is fresh."""
    now = _clock()
    # A reconnected key (new ciphertext) is another cache entry.
    full_key = (conn.id, hashlib.sha256(conn.ciphertext).hexdigest(), key)
    hit = _cache.get(full_key)
    if hit is not None and hit[0] > now:
        return hit[1]
    _spend(conn.id, calls)
    result = await _browse(db, conn, call)
    _cache[full_key] = (now + CACHE_SECONDS, result)
    _cache.move_to_end(full_key)
    while len(_cache) > CACHE_ENTRIES:
        _cache.popitem(last=False)
    return result


async def _browse(db: TenantDB, conn: Connection, call):
    try:
        credential = await _read_credential(db, conn)
    except InvalidError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    try:
        return await call(credential)
    except base.ConnectorRateLimited as e:
        wait = math.ceil(e.retry_after) if e.retry_after else None
        detail = "Fireflies is rate limiting this API key. " + (
            f"Try again in {wait} seconds." if wait else "Try again in a minute."
        )
        headers = {"Retry-After": str(wait)} if wait else None
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail, headers) from None
    except FirefliesForbidden:
        # The key may lack access to this (a plan or team permission): the connection
        # itself still works, so it is not marked expired.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Fireflies refused to list these meetings for this API key: check the key's "
            "Fireflies plan and permissions",
        ) from None
    except base.ConnectorAuthError:
        await connections.mark_failure(
            db, conn, "expired", "Fireflies rejected the API key while browsing"
        )
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Fireflies rejected the API key: reconnect it in Settings > Connections",
        ) from None
    except base.ConnectorError as e:
        # Redacted like a sync's error: Fireflies may echo the key back.
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, redact(str(e), credential)) from None


def _check_range(date_to: date | None) -> None:
    if date_to is not None and date_to >= date.max:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "'to' is out of range")


def _meeting_out(m: Meeting) -> FirefliesMeetingOut:
    return FirefliesMeetingOut(**m.__dict__)


@router.get(
    "/connections/{connection_id}/fireflies/meetings",
    response_model=FirefliesMeetingPage,
    responses=RESPONSES,
)
async def list_fireflies_meetings(
    connection_id: uuid.UUID,
    principal: UserPrincipal,
    db: TenantDB,
    http: ProviderHttp,
    search: Annotated[str, Query(max_length=255)] = "",
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    cursor: Annotated[str | None, Query(pattern=r"^\d{1,6}$")] = None,
) -> FirefliesMeetingPage:
    """Your meetings in Fireflies, newest first, a page at a time (search: in titles)."""
    _check_range(date_to)
    conn = await _fireflies_connection(db, connection_id, principal)
    page = await _cached(
        db,
        conn,
        ("meetings", search, date_from, date_to, int(cursor or 0)),
        1,
        lambda credential: FirefliesConnector(http).browse_meetings(
            credential,
            search=search,
            date_from=date_from,
            date_to=date_to,
            skip=int(cursor or 0),
        ),
    )
    return FirefliesMeetingPage(
        meetings=[_meeting_out(m) for m in page.meetings],
        next_cursor=str(page.next_skip) if page.next_skip is not None else None,
    )


@router.get(
    "/connections/{connection_id}/fireflies/series",
    response_model=FirefliesSeriesList,
    responses=RESPONSES,
)
async def list_fireflies_series(
    connection_id: uuid.UUID,
    principal: UserPrincipal,
    db: TenantDB,
    http: ProviderHttp,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> FirefliesSeriesList:
    """Your meetings grouped into recurring series, with counts and the last date."""
    _check_range(date_to)
    conn = await _fireflies_connection(db, connection_id, principal)
    result = await _cached(
        db,
        conn,
        ("series", date_from, date_to),
        SERIES_CALLS,
        lambda credential: FirefliesConnector(http).browse_series(
            credential, date_from=date_from, date_to=date_to
        ),
    )
    return FirefliesSeriesList(
        series=[FirefliesSeriesOut(**s.__dict__) for s in result.series],
        truncated=result.truncated,
    )
