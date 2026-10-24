"""Company › Market (H7 Competitive digest): ``/v1/competitors``, ``/v1/competitor-pages``,
``/v1/competitor-changes``, ``/v1/competitor-web-findings``, ``/v1/positioning`` and
``/v1/positioning-suggestions``.

Everyone signed in reads; approvers and owners write. Each route is an MCP tool by its
operation id; run tokens read with ``read:baseline`` and never write
(oracle.mcp.scopes).
"""

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role, require_role_now
from oracle.baseline.public_links import LinkFetcher, get_link_fetcher
from oracle.market import service
from oracle.market.schemas import (
    ChangeDetail,
    ChangeOut,
    CompetitorCreate,
    CompetitorDetail,
    CompetitorOut,
    CompetitorPatch,
    FindingDismissIn,
    FindingStatus,
    Origin,
    PageIn,
    PageOut,
    PagePatch,
    PositioningIn,
    PositioningOut,
    PromoteIn,
    Rating,
    WebFindingOut,
)

router = APIRouter(prefix="/v1", tags=["market"])
Viewer = Annotated[Principal, Depends(require_role("viewer"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]
Fetcher = Annotated[LinkFetcher, Depends(get_link_fetcher)]
ERRORS = {
    403: {"description": "Role too low"},
    404: {"description": "No such alternative, page, change, finding or suggestion"},
    409: {"description": "Stale lock_version, blocked by robots.txt, or already decided"},
    422: {"description": "Invalid URL, over the limits, a duplicate, or a field too long"},
}


def _raise(e: service.MarketError) -> HTTPException:
    return HTTPException(e.status, e.message)


@router.get("/competitors", response_model=list[CompetitorOut])
async def list_competitors(
    db: TenantDB, principal: Viewer, include_archived: bool = False
) -> list[CompetitorOut]:
    """The alternatives the company tracks (direct, indirect and status quo) with their
    latest changes."""
    return await service.list_competitors(db, include_archived)


@router.post("/competitors", response_model=CompetitorOut, status_code=201, responses=ERRORS)
async def create_competitor(
    body: CompetitorCreate, db: TenantDB, principal: ApproverNow
) -> CompetitorOut:
    try:
        return await service.create_competitor(db, principal, body)
    except service.MarketError as e:
        raise _raise(e) from e


@router.get("/competitors/{competitor_id}", response_model=CompetitorDetail, responses=ERRORS)
async def get_competitor(
    competitor_id: uuid.UUID, db: TenantDB, principal: Viewer
) -> CompetitorDetail:
    """One alternative: its pages, its last 20 changes and its open web findings."""
    try:
        return await service.competitor_detail(db, competitor_id)
    except service.MarketError as e:
        raise _raise(e) from e


@router.patch("/competitors/{competitor_id}", response_model=CompetitorOut, responses=ERRORS)
async def update_competitor(
    competitor_id: uuid.UUID, body: CompetitorPatch, db: TenantDB, principal: ApproverNow
) -> CompetitorOut:
    try:
        return await service.update_competitor(db, principal, competitor_id, body)
    except service.MarketError as e:
        raise _raise(e) from e


@router.post("/competitors/{competitor_id}/archive", response_model=CompetitorOut, responses=ERRORS)
async def archive_competitor(
    competitor_id: uuid.UUID, db: TenantDB, principal: ApproverNow
) -> CompetitorOut:
    """Archive an alternative: its pages are paused."""
    try:
        return await service.set_competitor_status(db, principal, competitor_id, "archived")
    except service.MarketError as e:
        raise _raise(e) from e


@router.post("/competitors/{competitor_id}/restore", response_model=CompetitorOut, responses=ERRORS)
async def restore_competitor(
    competitor_id: uuid.UUID, db: TenantDB, principal: ApproverNow
) -> CompetitorOut:
    try:
        return await service.set_competitor_status(db, principal, competitor_id, "active")
    except service.MarketError as e:
        raise _raise(e) from e


@router.post(
    "/competitors/{competitor_id}/pages",
    response_model=PageOut,
    status_code=201,
    responses=ERRORS,
)
async def watch_competitor_page(
    competitor_id: uuid.UUID, body: PageIn, db: TenantDB, principal: ApproverNow, fetch: Fetcher
) -> PageOut:
    """Watch a public page of an alternative; it is read at once, then weekly."""
    try:
        return await service.watch_page(db, principal, competitor_id, body, fetch)
    except service.MarketError as e:
        raise _raise(e) from e


@router.patch("/competitor-pages/{page_id}", response_model=PageOut, responses=ERRORS)
async def update_competitor_page(
    page_id: uuid.UUID, body: PagePatch, db: TenantDB, principal: ApproverNow
) -> PageOut:
    try:
        return await service.update_page(db, principal, page_id, body)
    except service.MarketError as e:
        raise _raise(e) from e


@router.delete(
    "/competitor-pages/{page_id}", status_code=status.HTTP_204_NO_CONTENT, responses=ERRORS
)
async def delete_competitor_page(
    page_id: uuid.UUID, db: TenantDB, principal: ApproverNow
) -> Response:
    """Stop watching a page: its snapshots and page changes go with it."""
    try:
        await service.delete_page(db, principal, page_id)
    except service.MarketError as e:
        raise _raise(e) from e
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/competitor-pages/{page_id}/check", response_model=PageOut, responses=ERRORS)
async def check_competitor_page(
    page_id: uuid.UUID, db: TenantDB, principal: ApproverNow, fetch: Fetcher
) -> PageOut:
    """Check now: read the page at once (409 when its robots.txt disallows it)."""
    try:
        return await service.check_now(db, principal, page_id, fetch)
    except service.MarketError as e:
        raise _raise(e) from e


@router.get("/competitor-changes", response_model=list[ChangeOut])
async def list_competitor_changes(
    db: TenantDB,
    principal: Viewer,
    competitor_id: uuid.UUID | None = None,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None,
    rating: Rating | None = None,
    origin: Origin | None = None,
) -> list[ChangeOut]:
    """The change log: page changes and promoted web findings, newest first (from and to
    are UTC dates, to exclusive)."""
    return await service.list_changes(
        db, competitor_id=competitor_id, from_=service.utc(from_) if from_ else None,
        to=service.utc(to) if to else None, rating=rating, origin=origin,
    )  # fmt: skip


@router.get("/competitor-changes/{change_id}", response_model=ChangeDetail, responses=ERRORS)
async def get_competitor_change(
    change_id: uuid.UUID, db: TenantDB, principal: Viewer
) -> ChangeDetail:
    """One change: the diff lines of a page change, or its web finding."""
    try:
        return await service.change_detail(db, change_id)
    except service.MarketError as e:
        raise _raise(e) from e


@router.get("/competitor-web-findings", response_model=list[WebFindingOut])
async def list_competitor_web_findings(
    db: TenantDB,
    principal: Viewer,
    status_: Annotated[FindingStatus | None, Query(alias="status")] = "open",
    competitor_id: uuid.UUID | None = None,
    occurrence_id: uuid.UUID | None = None,
    include_older: bool = False,
) -> list[WebFindingOut]:
    """What the monthly web search found, not vetted until a person promotes it (open
    findings older than 90 days only with include_older)."""
    return await service.list_findings(
        db, status=status_, competitor_id=competitor_id, occurrence_id=occurrence_id,
        include_older=include_older,
    )  # fmt: skip


@router.post(
    "/competitor-web-findings/{finding_id}/promote", response_model=ChangeOut, responses=ERRORS
)
async def promote_web_finding(
    finding_id: uuid.UUID, body: PromoteIn, db: TenantDB, principal: ApproverNow
) -> ChangeOut:
    """Promote to change log (409 when the finding is not open)."""
    try:
        return await service.promote_finding(db, principal, finding_id, body.rating)
    except service.MarketError as e:
        raise _raise(e) from e


@router.post(
    "/competitor-web-findings/{finding_id}/dismiss",
    response_model=WebFindingOut,
    responses=ERRORS,
)
async def dismiss_web_finding(
    finding_id: uuid.UUID, body: FindingDismissIn, db: TenantDB, principal: ApproverNow
) -> WebFindingOut:
    try:
        return await service.dismiss_finding(db, principal, finding_id, body.reason)
    except service.MarketError as e:
        raise _raise(e) from e


@router.get("/positioning", response_model=PositioningOut)
async def get_positioning(db: TenantDB, principal: Viewer) -> PositioningOut:
    """The company's positioning inputs (alternatives, unique attributes, value and
    proof, best-fit customers, market category, trends) and the open suggestions."""
    return await service.positioning_out(db)


@router.put("/positioning", response_model=PositioningOut, responses=ERRORS)
async def update_positioning(
    body: PositioningIn, db: TenantDB, principal: ApproverNow
) -> PositioningOut:
    try:
        return await service.update_positioning(db, principal, body)
    except service.MarketError as e:
        raise _raise(e) from e


@router.post(
    "/positioning-suggestions/{suggestion_id}/accept",
    response_model=PositioningOut,
    responses=ERRORS,
)
async def accept_positioning_suggestion(
    suggestion_id: uuid.UUID, db: TenantDB, principal: ApproverNow
) -> PositioningOut:
    try:
        return await service.accept_suggestion(db, principal, suggestion_id)
    except service.MarketError as e:
        raise _raise(e) from e


@router.post(
    "/positioning-suggestions/{suggestion_id}/dismiss",
    response_model=PositioningOut,
    responses=ERRORS,
)
async def dismiss_positioning_suggestion(
    suggestion_id: uuid.UUID, db: TenantDB, principal: ApproverNow
) -> PositioningOut:
    try:
        return await service.dismiss_suggestion(db, principal, suggestion_id)
    except service.MarketError as e:
        raise _raise(e) from e
