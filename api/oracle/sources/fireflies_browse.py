"""Browsing a Fireflies connection for the source picker (S5, owner 2026-10-19).

Only the connection's owner can browse it, in the browser or through an MCP client
acting as them (owner, 2026-10-19); another user's connection reads as not found.
Fireflies is called server-side with the stored API key, which never reaches the
browser.

Browsing spends the person's Fireflies quota (the lower Fireflies plans allow 50 API
calls a day), so its cost is bounded per connection: at most CALLS_PER_MINUTE and
CALLS_PER_DAY Fireflies calls are made for browsing (a series list counts as
SERIES_CALLS, the most it makes), the rest of the quota being left to syncs. The calls
are counted in the database (``browse_calls``), so the budget holds across API
processes; past it the routes answer 429 "Fireflies limit reached, try later". Answers
are also cached for CACHE_SECONDS in the API process; a cached answer costs nothing, but
is only served while the connection is still active.

The picker's dates are whole days in UTC: the API does not know the person's time zone.
"""

import hashlib
import math
import time
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from datetime import UTC, date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import delete, select

from oracle.auth.deps import TenantDB
from oracle.connections import service as connections
from oracle.connections.models import Connection
from oracle.connections.router import ProviderHttp, UserPrincipal
from oracle.sources import base
from oracle.sources.connectors import fireflies
from oracle.sources.connectors.fireflies import FirefliesConnector, FirefliesForbidden, Meeting
from oracle.sources.models import BrowseCall
from oracle.sources.service import InvalidError, _read_credential, redact

router = APIRouter(prefix="/v1", tags=["connections"])

CACHE_SECONDS = 60.0
CACHE_ENTRIES = 1000
CALLS_PER_MINUTE = 10
CALLS_PER_DAY = 25
# The most Fireflies calls one series list makes.
SERIES_CALLS = fireflies.SERIES_PAGES
LIMIT_REACHED = "Fireflies limit reached, try later"
_WINDOWS = (
    (timedelta(minutes=1), CALLS_PER_MINUTE, "a minute"),
    (timedelta(days=1), CALLS_PER_DAY, "a day"),
)

_clock = time.monotonic
_cache: OrderedDict[Hashable, tuple[float, object]] = OrderedDict()


def _now() -> datetime:
    return datetime.now(UTC)


RESPONSES: dict[int | str, dict[str, str]] = {
    404: {"description": "Not one of your Fireflies connections"},
    409: {"description": "The connection cannot be used (reconnect it), or Fireflies refused"},
    429: {
        "description": "Fireflies limit reached, try later: Fireflies is rate limiting the "
        "API key, or this connection has browsed its daily share; see Retry-After"
    },
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
    # What a source's config.series holds to take this meeting's calendar series; null
    # when the meeting is in none (only picking it takes it).
    series_key: str | None
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
    # True when there were more meetings than the list reads (the newest 200).
    truncated: bool


async def _fireflies_connection(db: TenantDB, connection_id: uuid.UUID, principal) -> Connection:
    conn = await connections.get_own(db, connection_id, principal.user_id)
    if conn is None or conn.provider != "fireflies":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fireflies connection not found")
    return conn


def reset_limits() -> None:
    """Forget cached answers (tests; spent budgets live in the database)."""
    _cache.clear()


def _later(seconds: int) -> str:
    if seconds < 120:
        return f"{seconds} seconds"
    if seconds < 7200:
        return f"{math.ceil(seconds / 60)} minutes"
    return f"{math.ceil(seconds / 3600)} hours"


def _limited(detail: str, seconds: int | None) -> HTTPException:
    headers = {"Retry-After": str(seconds)} if seconds else None
    return HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"{LIMIT_REACHED}. {detail}", headers)


async def _spend(db: TenantDB, conn: Connection, calls: int) -> None:
    """Reserve ``calls`` Fireflies calls for this connection, or answer 429. Commits."""
    now = _now()
    longest = max(window for window, _, _ in _WINDOWS)
    # One reservation at a time per connection, across API processes.
    await db.execute(select(Connection.id).where(Connection.id == conn.id).with_for_update())
    await db.execute(
        delete(BrowseCall).where(
            BrowseCall.connection_id == conn.id, BrowseCall.at <= now - longest
        )
    )
    spent = (
        await db.execute(
            select(BrowseCall.at, BrowseCall.calls)
            .where(BrowseCall.connection_id == conn.id)
            .order_by(BrowseCall.at)
        )
    ).all()
    for window, limit, per in _WINDOWS:
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
            await db.rollback()
            seconds = max(1, math.ceil(wait.total_seconds()))
            raise _limited(
                f"Browsing may make {limit} Fireflies calls {per} for this connection, so "
                f"syncs keep the rest of your Fireflies quota. Try again in {_later(seconds)}.",
                seconds,
            )
    db.add(BrowseCall(connection_id=conn.id, at=now, calls=calls))
    await db.commit()


async def _cached(
    db: TenantDB, conn: Connection, key: Hashable, calls: int, call: Callable[..., Awaitable]
):
    """The answer of ``call`` for ``key``, from the cache when it is fresh and the
    connection is still active."""
    if conn.status != "active":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"The Fireflies connection is {conn.status}: reconnect it in Settings > Connections",
        )
    now = _clock()
    # A reconnected key (new ciphertext) is another cache entry.
    full_key = (conn.id, hashlib.sha256(conn.ciphertext).hexdigest(), key)
    hit = _cache.get(full_key)
    if hit is not None and hit[0] > now:
        return hit[1]
    await _spend(db, conn, calls)
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
        raise _limited(
            "Fireflies is rate limiting this API key. "
            + (f"Try again in {_later(wait)}." if wait else "Try again in a minute."),
            wait,
        ) from None
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
    """Your meetings in Fireflies, newest first, a page at a time (search: in titles;
    from/to: whole days in UTC)."""
    _check_range(date_to)
    # As the connector sends it, so one search is one cache entry.
    search = search.strip()[: fireflies.MAX_SEARCH]
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
    """Your meetings grouped into their calendar series, with counts and the last date
    (from/to: whole days in UTC). Meetings on no calendar are in no series."""
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
