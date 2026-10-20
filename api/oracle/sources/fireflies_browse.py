"""Browsing a Fireflies connection for the source picker (S5, owner 2026-10-19).

Only the connection's owner can browse it; another user's connection reads as not
found. Fireflies is called server-side with the stored API key, which never reaches
the browser.
"""

import math
import uuid
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from oracle.auth.deps import TenantDB
from oracle.connections import service as connections
from oracle.connections.models import Connection
from oracle.connections.router import ProviderHttp, UserPrincipal
from oracle.sources import base
from oracle.sources.connectors.fireflies import FirefliesConnector, Meeting
from oracle.sources.service import InvalidError, _read_credential

router = APIRouter(prefix="/v1", tags=["connections"])

RESPONSES: dict[int | str, dict[str, str]] = {
    404: {"description": "Not one of your Fireflies connections"},
    409: {"description": "The connection cannot be used: reconnect it"},
    429: {"description": "Fireflies is rate limiting the API key; see Retry-After"},
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
    except base.ConnectorAuthError:
        await connections.mark_failure(
            db, conn, "expired", "Fireflies rejected the API key while browsing"
        )
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Fireflies rejected the API key: reconnect it in Settings > Connections",
        ) from None
    except base.ConnectorError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from None


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
    conn = await _fireflies_connection(db, connection_id, principal)
    page = await _browse(
        db,
        conn,
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
    conn = await _fireflies_connection(db, connection_id, principal)
    result = await _browse(
        db,
        conn,
        lambda credential: FirefliesConnector(http).browse_series(
            credential, date_from=date_from, date_to=date_to
        ),
    )
    return FirefliesSeriesList(
        series=[FirefliesSeriesOut(**s.__dict__) for s in result.series],
        truncated=result.truncated,
    )
