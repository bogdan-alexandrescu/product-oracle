"""The live tools (#710 section 1): REST routes under /v1/live, so MCP tools too.

Any signed-in member, only on their own connections: another person's connection id
(or none, or another provider's) answers 404 "You have no Fireflies connection...",
as oracle.sources.fireflies_browse does. Fireflies is called server-side with the
stored key, which never leaves the API (oracle.live.fireflies).

Every ``live_fireflies_*`` success carries ``cite``; every call after the connection is
found writes a ``live_reads`` row (no source text, no query text, no key). Calls spend
the connection's budget in ``browse_calls`` as ``live`` (oracle.live.budget); answers are
cached CACHE_SECONDS per (connection, tool, arguments) in this process, and a cached
answer costs nothing and keeps its original ``read_at``. ``ORACLE_LIVE_READS=off``
answers 503 on every route here.

With an Ask reply's live token (oracle.live.tokens, the ``olt_`` MCP caller's
``x-oracle-live-token``) every call first re-checks the reply and the discussion and
records itself (amendment C3), counts toward the reply's 8 (``live_sources`` too), and a
success's cite is numbered per reply in call order (``l:1``, ``l:2``, ...); without one it
is numbered per request: always ``l:1``.
"""

import hashlib
import logging
import time
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from pydantic import BaseModel

from oracle.auth.deps import TenantDB
from oracle.config import get_settings
from oracle.connections import service as connections
from oracle.connections.models import Connection
from oracle.connections.router import FirefliesHttp, UserPrincipal
from oracle.live import budget, tokens
from oracle.live import fireflies as live
from oracle.live.models import LiveRead
from oracle.sources.connectors.fireflies import MAX_MEETING_ID
from oracle.sources.service import InvalidError, _read_credential
from oracle.tenant_settings_api import company_timezone

log = logging.getLogger(__name__)

TURNED_OFF = "Live reads are turned off."
PROVIDER_NAMES = {"fireflies": "Fireflies"}
FIREFLIES_TOOLS = [
    "live_fireflies_list_meetings",
    "live_fireflies_search",
    "live_fireflies_get_meeting",
    "live_fireflies_get_lines",
]
CACHE_SECONDS = 60.0
CACHE_ENTRIES = 1000
BOTH_WINDOWS = "Use offset and limit, or start_ms and end_ms, not both."
MS_WINDOW = "Give start_ms and end_ms together, with end_ms after start_ms."

_clock = time.monotonic
# key -> (fresh until, answer, read_at)
_cache: OrderedDict[Hashable, tuple[float, dict[str, Any], datetime]] = OrderedDict()


def _now() -> datetime:
    return datetime.now(UTC)


def reset_cache() -> None:
    """Forget cached answers (tests; spent budgets live in the database)."""
    _cache.clear()


def live_reads_on() -> None:
    if get_settings().live_reads == "off":
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, TURNED_OFF)


router = APIRouter(prefix="/v1/live", tags=["live"], dependencies=[Depends(live_reads_on)])

RESPONSES: dict[int | str, dict[str, str]] = {
    404: {"description": "Not one of your Fireflies connections, or no such meeting"},
    422: {"description": "A filter this source does not offer, or arguments that conflict"},
    424: {"description": "The source refused your key: reconnect it in Settings > Connections"},
    429: {
        "description": "The source is limiting requests, or this connection's live budget "
        "is spent; see Retry-After"
    },
    502: {"description": "The source did not answer, or answered in a way Oracle could not read"},
    503: {"description": "Live reads are turned off"},
}


class Cite(BaseModel):
    ref: str
    source: str
    call: str
    read_at: datetime
    connection_id: uuid.UUID
    item_id: str | None = None


class LiveSourceOut(BaseModel):
    connection_id: uuid.UUID
    provider: str
    label: str
    tools: list[str]


class LiveMeeting(BaseModel):
    id: str
    title: str
    date: datetime | None
    duration_s: float | None
    participants: list[str]


class LiveMeetingList(BaseModel):
    # Null when the source does not offer a count (Fireflies' API with dates, or a plan
    # without it: see note).
    total: int | None
    meetings: list[LiveMeeting]
    # Entries without an id or a title, dropped.
    skipped: int = 0
    # Fireflies' API reads at most 50 at once.
    limit_capped: bool = False
    note: str | None = None
    cite: Cite


class LiveMatch(BaseModel):
    id: str
    title: str
    date: datetime | None
    snippet: str | None


class LiveSearch(BaseModel):
    # The match count; null on Fireflies' API.
    total: int | None
    matches: list[LiveMatch]
    skipped: int = 0
    limit_capped: bool = False
    cite: Cite


class LiveLine(BaseModel):
    speaker: str | None
    start_ms: int | None
    text: str


class LiveMeetingDetail(LiveMeeting):
    summary: str | None
    # With part=all only.
    lines: list[LiveLine] | None
    truncated: bool
    skipped: int = 0
    cite: Cite


class LiveLines(BaseModel):
    lines: list[LiveLine]
    next_offset: int | None
    skipped: int = 0
    cite: Cite


def _label(conn: Connection) -> str:
    return conn.account_label or PROVIDER_NAMES.get(conn.provider, conn.provider)


def _no_connection(provider: str = "fireflies") -> HTTPException:
    name = PROVIDER_NAMES.get(provider, provider)
    return HTTPException(
        status.HTTP_404_NOT_FOUND,
        f"You have no {name} connection. Connect one in Settings > Connections.",
    )


async def _bound(request: Request, principal: UserPrincipal, db: TenantDB):
    """The Ask reply's live token this call was made with, if any."""
    return await tokens.bound(db, request, principal.user_id)


LiveTokenOf = Annotated[tokens.LiveToken | None, Depends(_bound)]


def _error(e: live.LiveError, label: str, meeting_id: str | None) -> HTTPException:
    if isinstance(e, live.SourceRefused):
        return HTTPException(
            status.HTTP_424_FAILED_DEPENDENCY,
            f"{label} refused your key (it may have been revoked or expired). Reconnect it "
            "in Settings > Connections.",
        )
    if isinstance(e, live.SourceLimited):
        wait = e.retry_after or live.DEFAULT_RETRY_SECONDS
        return HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"{label} is limiting requests; try again in {wait} seconds.",
            headers={"Retry-After": str(wait)},
        )
    if isinstance(e, live.NotFound):
        return HTTPException(status.HTTP_404_NOT_FOUND, f"No meeting {meeting_id} in {label}.")
    if isinstance(e, live.Malformed):
        return HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"{label} answered in a way Oracle could not read."
        )
    reason = e.reason if isinstance(e, live.SourceDown) else "an unexpected answer"
    return HTTPException(
        status.HTTP_502_BAD_GATEWAY,
        f"{label} did not answer ({reason}). Synced data is still available; try again later.",
    )


def _spent(refusal: budget.Refusal, label: str) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        f"Live reads of {label} are at this connection's limit of {refusal.limit} a "
        f"{refusal.per}; try again in {budget.later(refusal.seconds)}.",
        headers={"Retry-After": str(refusal.seconds)},
    )


async def _record(
    db: TenantDB,
    principal,
    conn: Connection,
    call: str,
    label: str,
    item_id: str | None,
    outcome: str,
    reserved: tuple[tokens.LiveToken, uuid.UUID] | None,
) -> int | None:
    """The call's live_reads row (a reply's call settles the row it reserved); a
    success's ref number."""
    if reserved is not None:
        return await tokens.settle(db, *reserved, outcome)
    # Per request without a live token: always 1.
    ref_n = None if outcome == "error" else 1
    db.add(
        LiveRead(
            user_id=principal.user_id,
            connection_id=conn.id,
            tool=call,
            source_label=label,
            ref_n=ref_n,
            item_id=item_id,
            status=outcome,
        )
    )
    await db.commit()
    return ref_n


async def _read(
    db: TenantDB,
    principal,
    http,
    connection_id: uuid.UUID,
    call: str,
    args: dict[str, Any],
    run: Callable[[Any], Awaitable[dict[str, Any]]],
    item_id: str | None = None,
    token: tokens.LiveToken | None = None,
) -> dict[str, Any]:
    """One live call: the caller's connection, the cache or the source (on budget), its
    live_reads row and its cite. Failures answer the errors table's status and words.
    With a reply's live token the call is re-checked and recorded first (C3)."""
    conn = await connections.get_own(db, connection_id, principal.user_id)
    if conn is not None and conn.provider != "fireflies":
        conn = None
    reserved = None
    if token is not None:
        # Before the 404 too: every call of a reply counts toward its 8 (C1).
        label = _label(conn) if conn is not None else PROVIDER_NAMES["fireflies"]
        read_id = await tokens.reserve(
            db, token, conn.id if conn else None, call, label, item_id, cited=conn is not None
        )
        reserved = (token, read_id)
    if conn is None:
        raise _no_connection()
    label = _label(conn)
    try:
        return await _answer(db, principal, http, conn, label, call, args, run, item_id, reserved)
    except BaseException:
        if reserved is not None:
            # However the call ended without an answer, it keeps no ref (C1); settling a
            # call as failed twice changes nothing.
            try:
                await db.rollback()
                await tokens.settle(db, *reserved, "error")
            except Exception:
                log.exception("could not settle a failed live read")
        raise


async def _answer(db, principal, http, conn, label, call, args, run, item_id, reserved):
    """The rest of :func:`_read`, once the connection is known."""
    zone = await company_timezone(db)
    kind, _ = live.backend_of(conn.endpoint_url)
    # A reconnected key (new ciphertext) or another endpoint is another cache entry.
    key = (
        conn.id,
        hashlib.sha256(conn.ciphertext).hexdigest(),
        conn.endpoint_url,
        zone.key,
        call,
        tuple(sorted((k, tuple(v) if isinstance(v, list) else v) for k, v in args.items())),
    )
    outcome = "ok"
    try:
        hit = _cache.get(key)
        if hit is not None and hit[0] > _clock() and conn.status == "active":
            _, answer, read_at = hit
            outcome = "cached"
        else:
            answer, read_at = await _from_source(db, conn, http, zone, call, args, run)
            _cache[key] = (_clock() + CACHE_SECONDS, answer, read_at)
            _cache.move_to_end(key)
            while len(_cache) > CACHE_ENTRIES:
                _cache.popitem(last=False)
    except live.Unsupported as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, e.detail) from None
    except _Spent as e:
        await _record(db, principal, conn, call, label, item_id, "error", reserved)
        raise _spent(e.refusal, label) from None
    except live.LiveError as e:
        if isinstance(e, live.SourceRefused) and not isinstance(e, _Inactive):
            # As a sync does: Settings > Connections offers Reconnect.
            await connections.mark_failure(
                db, conn, "expired", f"{label} refused the key during a live read"
            )
        log.info("a live %s read of a %s connection failed: %s", call, kind, type(e).__name__)
        await _record(db, principal, conn, call, label, item_id, "error", reserved)
        raise _error(e, label, item_id) from None
    ref_n = await _record(db, principal, conn, call, label, item_id, outcome, reserved)
    cite = Cite(
        ref=f"l:{ref_n}",
        source=label,
        call=call,
        read_at=read_at,
        connection_id=conn.id,
        item_id=item_id,
    )
    return {**answer, "cite": cite}


class _Spent(Exception):
    def __init__(self, refusal: budget.Refusal):
        self.refusal = refusal


class _Inactive(live.SourceRefused):
    """The connection already needs reconnecting: no source call is made."""


async def _from_source(db, conn, http, zone, call, args, run) -> tuple[dict[str, Any], datetime]:
    if conn.status != "active":
        raise _Inactive("inactive")
    try:
        credential = await _read_credential(db, conn)
    except InvalidError:
        raise _Inactive("unavailable") from None
    api_key = credential.get("api_key") or ""
    backend = live.backend_for(http, conn.endpoint_url, api_key, zone)
    backend.check(call, args)
    windows, counted = budget.live_windows(backend.kind == "graphql")
    refusal = await budget.spend(
        db,
        conn.id,
        backend.cost(call, args),
        windows,
        _now(),
        kind=budget.LIVE,
        counted=counted,
    )
    if refusal is not None:
        raise _Spent(refusal)
    answer = await run(backend)
    return answer, _now()


def _check_days(date_from: date | None, date_to: date | None) -> None:
    if date_to is not None and date_to >= date.max:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "date_to is out of range.")
    if date_from is not None and date_to is not None and date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "date_to is before date_from.")


ConnectionId = Annotated[uuid.UUID, Path(description="One of your Fireflies connections")]
MeetingId = Annotated[str, Path(min_length=1, max_length=MAX_MEETING_ID)]
DateFrom = Annotated[
    date | None, Query(description="YYYY-MM-DD, whole days in the Company time zone")
]
DateTo = Annotated[date | None, Query(description="YYYY-MM-DD, inclusive")]


@router.get("/sources", operation_id="live_sources", response_model=list[LiveSourceOut])
async def live_sources(
    principal: UserPrincipal, db: TenantDB, token: LiveTokenOf
) -> list[LiveSourceOut]:
    """Your active connections that Oracle can read live (v1: Fireflies), with their
    tools."""
    assert principal.user_id is not None
    reserved = None
    if token is not None:
        # Re-checked and counted toward the reply's 8 like every live call (C1); no cite.
        read_id = await tokens.reserve(
            db, token, None, "sources", "Live sources", None, cited=False
        )
        reserved = (token, read_id)
    out = [
        LiveSourceOut(
            connection_id=c.id, provider=c.provider, label=_label(c), tools=FIREFLIES_TOOLS
        )
        for c in await connections.list_for_user(db, principal.user_id)
        if c.provider == "fireflies" and c.status == "active"
    ]
    if reserved is not None:
        await tokens.settle(db, *reserved, "ok")
    return out


@router.get(
    "/fireflies/{connection_id}/meetings",
    operation_id="live_fireflies_list_meetings",
    response_model=LiveMeetingList,
    responses=RESPONSES,
)
async def live_fireflies_list_meetings(
    connection_id: ConnectionId,
    principal: UserPrincipal,
    db: TenantDB,
    http: FirefliesHttp,
    token: LiveTokenOf,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    series: Annotated[str | None, Query(min_length=1, max_length=500)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 20,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
) -> dict[str, Any]:
    """Your Fireflies meetings, newest first, read live. The count is ``total`` with
    limit=1 (null when the source does not offer it)."""
    _check_days(date_from, date_to)
    args = {
        "date_from": date_from,
        "date_to": date_to,
        "series": series,
        "limit": limit,
        "offset": offset,
    }
    return await _read(
        db,
        principal,
        http,
        connection_id,
        "list_meetings",
        args,
        lambda b: b.list_meetings(args),
        token=token,
    )


@router.get(
    "/fireflies/{connection_id}/search",
    operation_id="live_fireflies_search",
    response_model=LiveSearch,
    responses=RESPONSES,
)
async def live_fireflies_search(
    connection_id: ConnectionId,
    principal: UserPrincipal,
    db: TenantDB,
    http: FirefliesHttp,
    token: LiveTokenOf,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    people: Annotated[list[str], Query(max_length=20)] = [],  # noqa: B006 - FastAPI copies it
    date_from: DateFrom = None,
    date_to: DateTo = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
) -> dict[str, Any]:
    """Search your Fireflies meetings live (people: names or emails, the archive only)."""
    _check_days(date_from, date_to)
    args = {
        "q": q,
        "people": list(people),
        "date_from": date_from,
        "date_to": date_to,
        "limit": limit,
        "offset": offset,
    }
    return await _read(
        db, principal, http, connection_id, "search", args, lambda b: b.search(args), token=token
    )


@router.get(
    "/fireflies/{connection_id}/meetings/{meeting_id}",
    operation_id="live_fireflies_get_meeting",
    response_model=LiveMeetingDetail,
    responses=RESPONSES,
)
async def live_fireflies_get_meeting(
    connection_id: ConnectionId,
    meeting_id: MeetingId,
    principal: UserPrincipal,
    db: TenantDB,
    http: FirefliesHttp,
    token: LiveTokenOf,
    part: Literal["summary", "all"] = "summary",
    max_lines: Annotated[int, Query(ge=1, le=2000)] = 400,
) -> dict[str, Any]:
    """One meeting read live: its summary and, with part=all, up to max_lines lines."""
    args = {"meeting_id": meeting_id, "part": part, "max_lines": max_lines}
    return await _read(
        db,
        principal,
        http,
        connection_id,
        "get_meeting",
        args,
        lambda b: b.get_meeting(args),
        item_id=meeting_id,
        token=token,
    )


@router.get(
    "/fireflies/{connection_id}/meetings/{meeting_id}/lines",
    operation_id="live_fireflies_get_lines",
    response_model=LiveLines,
    responses=RESPONSES,
)
async def live_fireflies_get_lines(
    connection_id: ConnectionId,
    meeting_id: MeetingId,
    principal: UserPrincipal,
    db: TenantDB,
    http: FirefliesHttp,
    token: LiveTokenOf,
    offset: Annotated[int | None, Query(ge=0, le=1_000_000)] = None,
    limit: Annotated[int | None, Query(ge=1, le=500)] = None,
    start_ms: Annotated[int | None, Query(ge=0)] = None,
    end_ms: Annotated[int | None, Query(ge=0)] = None,
) -> dict[str, Any]:
    """A meeting's lines read live: by offset and limit (defaults 0 and 200), or the
    ones starting in start_ms..end_ms."""
    by_ms = start_ms is not None or end_ms is not None
    if by_ms and (offset is not None or limit is not None):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, BOTH_WINDOWS)
    args: dict[str, Any] = {"meeting_id": meeting_id}
    if by_ms:
        if start_ms is None or end_ms is None or end_ms <= start_ms:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, MS_WINDOW)
        args.update(start_ms=start_ms, end_ms=end_ms)
    else:
        args.update(offset=offset or 0, limit=limit or 200)
    return await _read(
        db,
        principal,
        http,
        connection_id,
        "get_lines",
        args,
        lambda b: b.get_lines(args),
        item_id=meeting_id,
        token=token,
    )
