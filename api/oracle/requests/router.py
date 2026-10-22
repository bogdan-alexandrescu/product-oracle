"""Requests and request themes (C1). Every route is also an MCP tool.

Roles: viewers read; commenters add requests and edit the words of their own while New;
approvers and owners qualify, merge, disqualify, reopen, set goals, theme, feature and
PRD, accept Oracle's suggestions, and create and archive themes. A run token reads
requests and themes under ``read:baseline`` and writes none (oracle.mcp.scopes).
Another company's ids are 404 (tenant-scoped session).

Oracle's triage run, Classify now and the requests Oracle finds in a person's own
sources come with the triage lane (issue #150, lane 3).
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role, require_role_now
from oracle.requests import service
from oracle.requests.schemas import (
    AcceptSuggestionIn,
    Channel,
    DisqualifyIn,
    MergeIn,
    QualifyIn,
    ReopenIn,
    RequestCreate,
    RequestDetail,
    RequestList,
    RequestOut,
    RequestPatch,
    RequestThemeCreate,
    RequestThemeOut,
    RequestThemePatch,
    State,
)

router = APIRouter(prefix="/v1", tags=["requests"])

Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role_now("approver"))]


def _http(exc: service.RequestError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


@router.get("/requests", response_model=RequestList)
async def list_requests(
    db: TenantDB,
    _: Viewer,
    state: State | None = None,
    theme_id: Annotated[
        str | None, Query(description="A theme id, or `none` for requests with no theme")
    ] = None,
    goal_id: uuid.UUID | None = None,
    channel: Channel | None = None,
    q: Annotated[str | None, Query(max_length=200, description="Title or body search")] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> RequestList:
    """The request queue, newest first, with the tab counts and the Sources facet."""
    theme: uuid.UUID | None = None
    if theme_id and theme_id != "none":
        try:
            theme = uuid.UUID(theme_id)
        except ValueError as e:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "theme_id: a theme id or none"
            ) from e
    return await service.list_requests(
        db,
        state=state,
        theme_id=theme,
        no_theme=theme_id == "none",
        goal_id=goal_id,
        channel=channel,
        q=q,
        limit=limit,
        offset=offset,
    )


@router.post("/requests", response_model=RequestOut, status_code=status.HTTP_201_CREATED)
async def create_request(data: RequestCreate, db: TenantDB, principal: Commenter) -> RequestOut:
    """Add a request, in the asker's words. A ``source_item_id`` of one of your own items
    shares its title, link and a 400-character excerpt with everyone who sees Requests."""
    try:
        row = await service.create(db, principal, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.get("/requests/{request_id}", response_model=RequestDetail)
async def get_request(request_id: uuid.UUID, db: TenantDB, _: Viewer) -> RequestDetail:
    """A request with what was merged into it and its linked PRD's review progress."""
    try:
        return await service.detail(db, request_id)
    except service.RequestError as e:
        raise _http(e) from e


@router.patch("/requests/{request_id}", response_model=RequestOut)
async def update_request(
    request_id: uuid.UUID, data: RequestPatch, db: TenantDB, principal: Commenter
) -> RequestOut:
    """The filer edits title and body while New; approvers set goals, theme, feature and
    the linked PRD."""
    try:
        row = await service.patch(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/qualify", response_model=RequestOut)
async def qualify_request(
    request_id: uuid.UUID, data: QualifyIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Qualify a New request; it needs a confirmed goal (decision F3b)."""
    try:
        row = await service.qualify(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/merge", response_model=RequestOut)
async def merge_request(
    request_id: uuid.UUID, data: MergeIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Merge into another request (the root of its chain); a cycle is refused (409)."""
    try:
        row = await service.merge(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/disqualify", response_model=RequestOut)
async def disqualify_request(
    request_id: uuid.UUID, data: DisqualifyIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Disqualify with a reason; Other needs a note."""
    try:
        row = await service.disqualify(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/reopen", response_model=RequestOut)
async def reopen_request(
    request_id: uuid.UUID, data: ReopenIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Bring a merged or disqualified request back to New."""
    try:
        row = await service.reopen(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/suggestion/accept", response_model=RequestOut)
async def accept_request_suggestion(
    request_id: uuid.UUID, data: AcceptSuggestionIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Accept parts of Oracle's suggestion: theme, goals, feature, or duplicate (merges)."""
    try:
        row = await service.accept_suggestion(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.get("/request-themes", response_model=list[RequestThemeOut])
async def list_request_themes(
    db: TenantDB, _: Viewer, include_archived: bool = False
) -> list[RequestThemeOut]:
    return await service.list_themes(db, include_archived)


@router.post("/request-themes", response_model=RequestThemeOut, status_code=status.HTTP_201_CREATED)
async def create_request_theme(
    data: RequestThemeCreate, db: TenantDB, principal: Approver
) -> RequestThemeOut:
    try:
        theme = await service.create_theme(db, principal, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(theme)
    return (await service.themes_out(db, [theme]))[0]


@router.patch("/request-themes/{theme_id}", response_model=RequestThemeOut)
async def update_request_theme(
    theme_id: uuid.UUID, data: RequestThemePatch, db: TenantDB, principal: Approver
) -> RequestThemeOut:
    """Rename, describe, relink or archive a theme (archived: takes no new requests)."""
    try:
        theme = await service.patch_theme(db, principal, theme_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(theme)
    return (await service.themes_out(db, [theme]))[0]
