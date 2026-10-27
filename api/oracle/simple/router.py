"""Simple S2 (#723): the company-wide roadmap and Oracle's date suggestions. For people:
a run's token is refused (the ``simple`` area is in no run-token scope, oracle.mcp.scopes).

- ``GET /v1/simple/roadmap``: viewer and up; what each reader sees follows the documents'
  visibility (oracle.docs.visibility).
- ``GET /v1/simple/roadmap/date-suggestions``: viewer and up, the suggestions of the items
  the reader sees, each with ``can_decide``.
- ``POST .../date-suggestions/refresh``: approver and up, regenerates them now.
- ``POST .../date-suggestions/{id}/accept|edit``: through the change engine (D-b,
  oracle.simple.changes ``accept_date_suggestion``): who decides (oracle.simple.service.
  can_decide) applies it into the roadmap's working draft, approvers and commenters
  propose it; never the published version's dates. 409 ``outdated`` when the item has
  dates now.
- ``POST .../date-suggestions/{id}/dismiss``: who decides (can_decide).
"""

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.simple import changes, drafts, service, suggestions
from oracle.simple.schemas import (
    DateSuggestionEdit,
    DateSuggestionOut,
    RefreshOut,
    RoadmapGroup,
    SimpleChangeResult,
    SimpleRoadmapOut,
)

router = APIRouter(prefix="/v1/simple/roadmap", tags=["simple"])


def _people(role: str):
    async def check(principal: Annotated[Principal, Depends(require_role(role))]) -> Principal:
        if principal.run_id is not None or principal.run_token_id is not None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Simple is not available to runs")
        return principal

    return check


Reader = Annotated[Principal, Depends(_people("viewer"))]
Commenter = Annotated[Principal, Depends(_people("commenter"))]
Approver = Annotated[Principal, Depends(_people("approver"))]
Text = Annotated[str | None, Query(max_length=200)]


@router.get("", response_model=SimpleRoadmapOut)
async def get_simple_roadmap(
    principal: Reader,
    db: TenantDB,
    group: RoadmapGroup = "goal",
    prd: Text = None,
    goal: Text = None,
    track: Text = None,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None,
) -> SimpleRoadmapOut:
    """Every roadmap's items the caller may read on one timeline, grouped by goal, track or
    PRD: each with its resolved dates (source, estimated), open date suggestion,
    milestone, waterfall phases, dependencies both ways and constraint flags; plus the
    tracks' milestones, the horizon windows, the company's today and the shown roadmaps' key
    dates (the working draft's to who sees it; roadmap-plus). Filters: ``prd``
    (slug or id), ``goal`` (key or id), ``track`` (id), ``from``/``to`` (bars overlapping)."""
    return await service.build(db, principal, group, prd, goal, track, from_, to)


@router.get("/date-suggestions", response_model=list[DateSuggestionOut])
async def list_date_suggestions(
    principal: Reader,
    db: TenantDB,
    status_: Annotated[
        Literal["open", "accepted", "edited", "dismissed"], Query(alias="status")
    ] = "open",
) -> list[DateSuggestionOut]:
    """Oracle's date suggestions for the items the caller may read, newest first."""
    return [
        service.suggestion_out(s, e.row, may)
        for s, e, may in await suggestions.visible(db, principal)
        if s.status == status_
    ]


@router.post("/date-suggestions/refresh", response_model=RefreshOut)
async def refresh_date_suggestions(principal: Approver, db: TenantDB) -> RefreshOut:
    """Regenerate the suggestions now (the minute tick does it once a day)."""
    count = await suggestions.regenerate(db)
    await db.commit()
    return RefreshOut(open=count)


async def _decide(db, principal, suggestion_id, action) -> DateSuggestionOut:
    try:
        s, item, may = await suggestions.decide(db, principal, suggestion_id, action)
    except suggestions.SuggestionError as e:
        raise HTTPException(e.status, str(e)) from e
    return service.suggestion_out(s, item, may)


async def _accept(db, principal, suggestion_id, body=None) -> SimpleChangeResult:
    try:
        return await suggestions.accept(
            db, principal, suggestion_id,
            body.start_date if body else None, body.end_date if body else None,
        )  # fmt: skip
    except suggestions.SuggestionError as e:
        raise HTTPException(e.status, str(e)) from e
    except (changes.ChangeError, drafts.DraftError) as e:
        await db.rollback()
        raise HTTPException(e.status, e.detail) from e


@router.post("/date-suggestions/{suggestion_id}/accept", response_model=SimpleChangeResult)
async def accept_date_suggestion(
    suggestion_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleChangeResult:
    """Accept: an ``accept_date_suggestion`` change (D-b). Who decides puts the suggested
    dates into the roadmap's working draft (``date_source`` accepted, undoable); others
    propose it. 409 ``outdated`` when the item has dates now."""
    return await _accept(db, principal, suggestion_id)


@router.post("/date-suggestions/{suggestion_id}/edit", response_model=SimpleChangeResult)
async def edit_date_suggestion(
    suggestion_id: uuid.UUID, body: DateSuggestionEdit, principal: Commenter, db: TenantDB
) -> SimpleChangeResult:
    """Edit: the same change with these dates instead (the suggestion becomes edited)."""
    return await _accept(db, principal, suggestion_id, body)


@router.post("/date-suggestions/{suggestion_id}/dismiss", response_model=DateSuggestionOut)
async def dismiss_date_suggestion(
    suggestion_id: uuid.UUID, principal: Reader, db: TenantDB
) -> DateSuggestionOut:
    """Dismiss: the item stays undated."""
    return await _decide(db, principal, suggestion_id, "dismiss")
