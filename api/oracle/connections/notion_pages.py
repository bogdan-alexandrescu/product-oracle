"""The Notion page picker: what a person's Notion connection can read, for them only.

A Notion source is chosen by ticking roots among the pages and databases the person shared
with Product Oracle when connecting (OAuth with ``owner=user``); sub-pages and databases
come with a ticked root. This lists them through Notion's search. The token stays here:
the browser sees titles, ids and parents, never the credential.
"""

import math
import time
import uuid
from collections import deque
from datetime import datetime
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ValidationError

from oracle.auth.deps import TenantDB
from oracle.connections import service
from oracle.connections.router import ProviderHttp, UserPrincipal
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


# A light per-person, per-connection limit on browsing, so a client looping over the list
# (an MCP agent, say) cannot spend the Notion rate limit that syncs share. In process: each
# API worker counts on its own, which is enough to stop a runaway loop.
BROWSE_LIMIT = 30
BROWSE_WINDOW_SECONDS = 60.0
_browses: dict[tuple[uuid.UUID, uuid.UUID], deque[float]] = {}


def _throttle(user_id: uuid.UUID, connection_id: uuid.UUID) -> None:
    now = time.monotonic()
    recent = _browses.setdefault((user_id, connection_id), deque())
    while recent and recent[0] <= now - BROWSE_WINDOW_SECONDS:
        recent.popleft()
    if len(recent) >= BROWSE_LIMIT:
        wait = max(1, math.ceil(recent[0] + BROWSE_WINDOW_SECONDS - now))
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many Notion page lists; try again in {wait} second{'s' if wait != 1 else ''}",
            headers={"Retry-After": str(wait)},
        )
    recent.append(now)
    # Forget idle callers so the table stays small.
    if len(_browses) > 10_000:
        for key in [
            k for k, v in _browses.items() if not v or v[-1] <= now - BROWSE_WINDOW_SECONDS
        ]:
            del _browses[key]


def _page(item: dict[str, Any]) -> NotionPageOut | None:
    try:
        return NotionPageOut(**item)
    except ValidationError:
        return None


@router.get(
    "/connections/{connection_id}/notion/pages",
    response_model=NotionPagesOut,
    summary="List Notion pages",
    responses={
        404: {"description": "Not one of your connections"},
        409: {
            "description": "Not a Notion connection, it needs reconnecting, or the "
            "integration lacks a capability"
        },
        429: {
            "description": "Too many lists, or Notion's rate limit; retry after "
            "``Retry-After`` seconds"
        },
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
    """Lists the titles of every Notion page and database shared with Product Oracle
    through this Notion connection, including pages that are in no source. Most recently
    edited first (or by relevance with ``search``), 100 at a time, each with its parent.
    Limited to 30 lists a minute per connection."""
    assert principal.user_id is not None
    _throttle(principal.user_id, connection_id)
    try:
        # Locks the row, as a sync does: parallel lists never spend a rotating refresh
        # token twice.
        credential = await service.get_credential(db, connection_id, principal.user_id, http=http)
    except service.ConnectionUnavailable as e:
        if e.status is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found") from None
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    if credential.provider != "notion":
        raise HTTPException(status.HTTP_409_CONFLICT, "This is not a Notion connection")
    try:
        items, next_cursor = await notion.search_shared(
            http, credential.access_token, search, cursor
        )
    except ConnectorRateLimited as e:
        message, retry_after = _retry_message(e.retry_after)
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, message, headers={"Retry-After": retry_after}
        ) from None
    except notion.NotionForbidden:
        # A valid token without a capability (restricted_resource): reconnecting won't help.
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Notion refused: the integration lacks a capability"
        ) from None
    except ConnectorAuthError:
        message = "Notion rejected the connection; reconnect it in Settings > Connections"
        conn = await service.get_own(db, connection_id, principal.user_id)
        if conn is not None:
            await service.mark_failure(db, conn, "expired", message)
        raise HTTPException(status.HTTP_409_CONFLICT, message) from None
    except (ConnectorError, httpx.HTTPError, ValueError):
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Notion did not answer; try again shortly"
        ) from None
    pages = [page for item in items if (page := _page(item)) is not None]
    return NotionPagesOut(items=pages, next_cursor=next_cursor)
