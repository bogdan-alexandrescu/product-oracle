"""Simple S2 (#723): the company-wide roadmap and Oracle's date suggestions. For people:
a run's token is refused (the ``simple`` area is in no run-token scope, oracle.mcp.scopes).

- ``GET /v1/simple/roadmap``: viewer and up; what each reader sees follows the documents'
  visibility (oracle.docs.visibility).
- ``GET /v1/simple/roadmap/date-suggestions``: viewer and up, the suggestions of the items
  the reader sees, each with ``can_decide``.
- ``POST .../date-suggestions/refresh``: approver and up, regenerates them now.
- ``POST .../date-suggestions/{id}/accept|edit|dismiss``: an owner or the roadmap's decider
  (with no decider, the roadmap's owner): oracle.simple.service.can_decide.
"""

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.simple import service, suggestions
from oracle.simple.schemas import (
    DateSuggestionEdit,
    DateSuggestionOut,
    RefreshOut,
    RoadmapGroup,
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
    tracks' milestones, the horizon windows and the company's today. Filters: ``prd``
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


async def _decide(db, principal, suggestion_id, action, body=None) -> DateSuggestionOut:
    try:
        s, item, may = await suggestions.decide(
            db, principal, suggestion_id, action,
            body.start_date if body else None, body.end_date if body else None,
        )  # fmt: skip
    except suggestions.SuggestionError as e:
        raise HTTPException(e.status, str(e)) from e
    return service.suggestion_out(s, item, may)


@router.post("/date-suggestions/{suggestion_id}/accept", response_model=DateSuggestionOut)
async def accept_date_suggestion(
    suggestion_id: uuid.UUID, principal: Reader, db: TenantDB
) -> DateSuggestionOut:
    """Accept: the item takes the suggested dates (``date_source`` accepted)."""
    return await _decide(db, principal, suggestion_id, "accept")


@router.post("/date-suggestions/{suggestion_id}/edit", response_model=DateSuggestionOut)
async def edit_date_suggestion(
    suggestion_id: uuid.UUID, body: DateSuggestionEdit, principal: Reader, db: TenantDB
) -> DateSuggestionOut:
    """Edit: the item takes these dates instead (``date_source`` accepted)."""
    return await _decide(db, principal, suggestion_id, "edit", body)


@router.post("/date-suggestions/{suggestion_id}/dismiss", response_model=DateSuggestionOut)
async def dismiss_date_suggestion(
    suggestion_id: uuid.UUID, principal: Reader, db: TenantDB
) -> DateSuggestionOut:
    """Dismiss: the item stays undated."""
    return await _decide(db, principal, suggestion_id, "dismiss")
