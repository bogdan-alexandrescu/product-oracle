"""Drive browse list: the Google Docs and folders a person's Google connection can read.

The same list Google's Drive picker shows in the browser, for MCP clients acting as the
person (S5, 'Browse access and narrowing', owner 2026-10-19): an assistant can find the
ids of the docs and folders to put in a Google Docs source. Only the connection's owner
may use it; API tokens without a user are refused (403), and run tokens cannot reach it
(their scopes do not cover connections). A read-only credential (an MCP client approved
with oracle:read only) is refused too (403): browsing only finds ids for a source edit,
which such a client cannot make.

The search text is sent to Drive as one escaped ``name contains '...'`` term and a folder
must be a Drive id (:data:`oracle.sources.connectors.google_docs.DRIVE_ID`), so a caller
cannot widen the query Oracle sends. So that searching cannot hammer Drive, an answer is
kept for :data:`CACHE_SECONDS` per connection and question, and one person may reach
Drive at most :data:`RATE_LIMIT` times per :data:`RATE_WINDOW` seconds (cached answers
are free). Both live in this process: with several API instances each keeps its own.
"""

import math
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from oracle.auth.deps import READ_ONLY, Principal, TenantDB
from oracle.connections import service
from oracle.connections.providers import DRIVE_READONLY, RECONNECT_TO_CHOOSE_FILES
from oracle.connections.router import ProviderHttp, UserPrincipal
from oracle.sources.base import ConnectorAuthError, ConnectorError, ConnectorRateLimited
from oracle.sources.connectors.google_docs import (
    DOC_MIME,
    FOLDER_MIME,
    NOT_A_DRIVE_ID,
    _Drive,
    query_string,
    valid_id,
)

router = APIRouter(prefix="/v1", tags=["connections"])

CACHE_SECONDS = 60
# Answers kept at most; the oldest go first.
CACHE_ENTRIES = 2000
RATE_LIMIT = 30
RATE_WINDOW = 60
DEFAULT_RETRY_SECONDS = 60
MAX_SHARED_DRIVES = 500
BROWSE_FIELDS = (
    "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,driveId,"
    "owners(displayName,emailAddress))"
)

_clock = time.monotonic
_cache: dict[tuple[uuid.UUID, tuple[Any, ...]], tuple[float, Any]] = {}
_calls: dict[uuid.UUID, list[float]] = {}


def reset() -> None:
    """Forget every cached answer and call count (tests)."""
    _cache.clear()
    _calls.clear()


def _cached(connection_id: uuid.UUID, key: tuple[Any, ...]) -> Any | None:
    hit = _cache.get((connection_id, key))
    if hit is None:
        return None
    stored_at, answer = hit
    if _clock() - stored_at >= CACHE_SECONDS:
        del _cache[(connection_id, key)]
        return None
    return answer


def _remember(connection_id: uuid.UUID, key: tuple[Any, ...], answer: Any) -> None:
    now = _clock()
    if len(_cache) >= CACHE_ENTRIES:
        for k in [k for k, (at, _) in _cache.items() if now - at >= CACHE_SECONDS]:
            del _cache[k]
        while len(_cache) >= CACHE_ENTRIES:
            del _cache[next(iter(_cache))]
    _cache[(connection_id, key)] = (now, answer)


def _admit(user_id: uuid.UUID) -> None:
    """Count one call to Drive for ``user_id``; a 429 past RATE_LIMIT a window."""
    now = _clock()
    calls = [t for t in _calls.get(user_id, []) if now - t < RATE_WINDOW]
    if len(calls) >= RATE_LIMIT:
        wait = max(1, math.ceil(RATE_WINDOW - (now - calls[0])))
        _calls[user_id] = calls
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many Drive searches: try again in {wait} seconds",
            headers={"Retry-After": str(wait)},
        )
    calls.append(now)
    _calls[user_id] = calls


class DriveFileOut(BaseModel):
    id: str
    name: str
    kind: Literal["doc", "folder"]
    modified_time: datetime | None
    url: str | None
    # The owner's email, when Drive shows it; None for a shared drive's files.
    owner: str | None
    in_shared_drive: bool


class DriveFilePage(BaseModel):
    files: list[DriveFileOut]
    # Pass back as ``cursor`` for more; null at the end.
    next_cursor: str | None


def _file(entry: dict[str, Any]) -> DriveFileOut:
    owners = entry.get("owners") or [{}]
    return DriveFileOut(
        id=entry["id"],
        name=entry.get("name") or entry["id"],
        kind="folder" if entry.get("mimeType") == FOLDER_MIME else "doc",
        modified_time=entry.get("modifiedTime"),
        url=entry.get("webViewLink"),
        owner=owners[0].get("emailAddress"),
        in_shared_drive=bool(entry.get("driveId")),
    )


def drive_query(text: str, folder: str | None) -> str:
    """The Drive query for a search: Google Docs and folders, not trashed, in ``folder``
    when given, whose name contains ``text`` (escaped: one string, never query syntax)."""
    terms = [
        "trashed = false",
        f"(mimeType = '{DOC_MIME}' or mimeType = '{FOLDER_MIME}')",
    ]
    if folder:
        terms.insert(0, f"{query_string(folder)} in parents")
    if text.strip():
        terms.append(f"name contains {query_string(text.strip())}")
    return " and ".join(terms)


@router.get(
    "/connections/{connection_id}/google/files",
    response_model=DriveFilePage,
    responses={
        400: {"description": "folder is not a Drive folder id"},
        403: {
            "description": "Not a person (an API token without a user), or a read-only "
            "credential (oracle:read)"
        },
        404: {"description": "Not one of your Google connections"},
        409: {"description": "The connection needs reconnecting (or lacks Drive access)"},
        429: {
            "description": "Drive is rate limiting, or you searched too often; "
            "retry after Retry-After seconds"
        },
    },
)
async def list_google_drive_files(
    connection_id: uuid.UUID,
    principal: UserPrincipal,
    db: TenantDB,
    http: ProviderHttp,
    q: Annotated[str, Query(max_length=200, description="Text the name contains")] = "",
    folder: Annotated[
        str | None, Query(max_length=200, description="A folder id: list what is in it")
    ] = None,
    cursor: Annotated[str | None, Query(max_length=1000)] = None,
) -> DriveFilePage:
    """List the Google Docs and folders in your Google Drive (and shared drives) that a
    Google Docs source can pick: by name, or inside one folder, most recently modified
    first. Each has the id to put in a source's ``docs`` or ``folders``.

    Read through your own Google connection. Answers are cached for a minute, and you
    may search Drive a limited number of times a minute."""
    assert principal.user_id is not None
    if folder is not None and not valid_id(folder):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"folder {NOT_A_DRIVE_ID}")
    conn = await _own_google(db, connection_id, principal)
    key = ("files", q.strip(), folder, cursor)

    async def read(drive: _Drive) -> DriveFilePage:
        page = await drive.list(
            drive_query(q, folder), BROWSE_FIELDS, cursor, orderBy="folder,modifiedTime desc"
        )
        return DriveFilePage(
            files=[_file(f) for f in page.get("files") or [] if f.get("id")],
            next_cursor=page.get("nextPageToken") or None,
        )

    return await _read(db, http, conn, principal.user_id, key, read)


async def _own_google(db: TenantDB, connection_id: uuid.UUID, principal: Principal) -> Any:
    """The caller's own Google connection that can read their Drive, or the HTTP error."""
    assert principal.user_id is not None
    if principal.read_only:
        raise HTTPException(status.HTTP_403_FORBIDDEN, READ_ONLY)
    conn = await service.get_own(db, connection_id, principal.user_id)
    if conn is None or conn.provider != "google":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
    if conn.scopes and DRIVE_READONLY not in conn.scopes:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{RECONNECT_TO_CHOOSE_FILES}: this Google connection cannot read your Drive",
        )
    return conn


async def _read(
    db: TenantDB,
    http: httpx.AsyncClient,
    conn: Any,
    user_id: uuid.UUID,
    key: tuple[Any, ...],
    read: Callable[[_Drive], Awaitable[Any]],
) -> Any:
    """``read`` through the connection: cached per connection and question, throttled per
    person, Drive's errors as HTTP errors."""
    hit = _cached(conn.id, key)
    if hit is not None:
        return hit
    _admit(user_id)
    try:
        credential = await service.credential_for(db, conn, http)
    except service.ConnectionUnavailable as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    try:
        answer = await read(_Drive(http, credential.access_token))
    except ConnectorRateLimited as e:
        wait = max(1, round(e.retry_after or DEFAULT_RETRY_SECONDS))
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Google Drive is busy: try again in {wait} seconds",
            headers={"Retry-After": str(wait)},
        ) from None
    except ConnectorAuthError as e:
        await service.mark_failure(db, conn, "expired", f"Rejected while browsing: {e}")
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Google rejected the connection: reconnect it"
        ) from None
    except ConnectorError as e:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"Google Drive could not be read: {e}"
        ) from None
    except (httpx.HTTPError, ValueError):
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Google Drive could not be reached: try again"
        ) from None
    _remember(conn.id, key, answer)
    return answer


class SharedDriveOut(BaseModel):
    id: str
    name: str


class SharedDriveList(BaseModel):
    drives: list[SharedDriveOut]


@router.get(
    "/connections/{connection_id}/google/shared-drives",
    response_model=SharedDriveList,
    responses={
        403: {
            "description": "Not a person (an API token without a user), or a read-only "
            "credential (oracle:read)"
        },
        404: {"description": "Not one of your Google connections"},
        409: {"description": "The connection needs reconnecting (or lacks Drive access)"},
        429: {"description": "Drive is rate limiting, or you asked too often"},
    },
)
async def list_google_shared_drives(
    connection_id: uuid.UUID, principal: UserPrincipal, db: TenantDB, http: ProviderHttp
) -> SharedDriveList:
    """The Google shared drives your Google connection can see, for an owner choosing the
    company's shared drives (the ``company_shared_drives`` setting, S5): docs in a picked
    folder in any other shared drive are skipped. At most :data:`MAX_SHARED_DRIVES`."""
    conn = await _own_google(db, connection_id, principal)
    assert principal.user_id is not None

    async def read(drive: _Drive) -> SharedDriveList:
        found: dict[str, SharedDriveOut] = {}
        token: str | None = None
        while len(found) < MAX_SHARED_DRIVES:
            params: dict[str, Any] = {"pageSize": 100, "fields": "nextPageToken,drives(id,name)"}
            if token:
                params["pageToken"] = token
            page = (await drive.get("drives", **params)).json()
            for d in page.get("drives") or []:
                if valid_id(d.get("id")):
                    found[d["id"]] = SharedDriveOut(id=d["id"], name=d.get("name") or d["id"])
            token = page.get("nextPageToken")
            if not token:
                break
        drives = sorted(found.values(), key=lambda d: d.name.lower())
        return SharedDriveList(drives=drives[:MAX_SHARED_DRIVES])

    return await _read(db, http, conn, principal.user_id, ("shared-drives",), read)
