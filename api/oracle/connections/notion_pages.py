"""The Notion page picker: what a person's Notion connection can read, for them only.

A Notion source is chosen by ticking roots among the pages and databases the person shared
with Product Oracle when connecting (OAuth with ``owner=user``); sub-pages and databases
come with a ticked root. This lists them through Notion's search. The token stays here:
the browser sees titles, ids and parents, never the credential.
"""

import math
import uuid
from datetime import datetime
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from oracle.auth.deps import TenantDB
from oracle.connections import service
from oracle.connections.router import ProviderHttp, UserPrincipal, _own
from oracle.sources.base import ConnectorAuthError, ConnectorError, ConnectorRateLimited
from oracle.sources.connectors import notion

router = APIRouter(prefix="/v1", tags=["connections"])


class NotionPageOut(BaseModel):
    id: str
    type: Literal["page", "database"]
    title: str
    # An emoji, or the URL of an image icon.
    icon: str | None
    # "block": the item sits in a column or synced block, whose id the picker cannot place.
    parent_type: Literal["workspace", "page", "database", "block"]
    parent_id: str | None
    last_edited_at: datetime | None
    url: str


class NotionPagesOut(BaseModel):
    items: list[NotionPageOut]
    # Pass as ``cursor`` for the next page; ``None`` on the last one.
    next_cursor: str | None


def _retry_message(seconds: float | None) -> tuple[str, str]:
    wait = max(1, math.ceil(seconds)) if seconds is not None else 60
    when = "a minute" if seconds is None else f"{wait} second{'s' if wait != 1 else ''}"
    return f"Notion is limiting requests right now; try again in {when}", str(wait)


@router.get(
    "/connections/{connection_id}/notion/pages",
    response_model=NotionPagesOut,
    responses={
        404: {"description": "Not one of your connections"},
        409: {"description": "Not a Notion connection, or it needs reconnecting"},
        429: {"description": "Notion's rate limit; retry after ``Retry-After`` seconds"},
        502: {"description": "Notion did not answer"},
    },
)
async def list_notion_pages(
    connection_id: uuid.UUID,
    principal: UserPrincipal,
    db: TenantDB,
    http: ProviderHttp,
    search: Annotated[str, Query(max_length=200)] = "",
    cursor: Annotated[str | None, Query(max_length=500)] = None,
) -> NotionPagesOut:
    """The pages and databases this Notion connection can read, most recently edited first
    (or by relevance with ``search``), 100 at a time, each with its parent."""
    conn = await _own(db, connection_id, principal)
    if conn.provider != "notion":
        raise HTTPException(status.HTTP_409_CONFLICT, "This is not a Notion connection")
    try:
        credential = await service.credential_for(db, conn, http)
    except service.ConnectionUnavailable as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    try:
        items, next_cursor = await notion.search_shared(
            http, credential.access_token, search, cursor
        )
    except ConnectorRateLimited as e:
        message, retry_after = _retry_message(e.retry_after)
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, message, headers={"Retry-After": retry_after}
        ) from None
    except ConnectorAuthError:
        message = "Notion rejected the connection; reconnect it in Settings > Connections"
        await service.mark_failure(db, conn, "expired", message)
        raise HTTPException(status.HTTP_409_CONFLICT, message) from None
    except (ConnectorError, httpx.HTTPError, ValueError):
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Notion did not answer; try again shortly"
        ) from None
    return NotionPagesOut(items=[NotionPageOut(**i) for i in items], next_cursor=next_cursor)
