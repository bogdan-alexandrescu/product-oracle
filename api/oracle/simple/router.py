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

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.simple import approved_roadmap, changes, drafts, goal_milestones, service, suggestions
from oracle.simple.schemas import (
    DateSuggestionEdit,
    DateSuggestionOut,
    RefreshOut,
    RoadmapGroup,
    SimpleAppliedVersion,
    SimpleChangeResult,
    SimpleGoalMilestone,
    SimpleGoalMilestoneIn,
    SimpleGoalMilestonePatch,
    SimpleRoadmapOut,
    SimpleRoadmapWaiting,
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
    roadmap: Text = None,
) -> SimpleRoadmapOut:
    """Every roadmap's items the caller may read on one timeline, grouped by goal, track or
    PRD: each with its resolved dates (source, estimated), open date suggestion,
    milestone, waterfall phases, dependencies both ways and constraint flags; plus the
    tracks' milestones, the horizon windows, the company's today and the shown roadmaps' key
    dates (the working draft's to who sees it; roadmap-plus). Filters: ``prd``
    (slug or id), ``goal`` (key or id), ``track`` (id), ``from``/``to`` (bars overlapping),
    ``roadmap`` (id or slug: one roadmap's items; 404 when the caller cannot read it).
    ``roadmaps``: every roadmap the caller may read, for the Roadmap filter."""
    return await service.build(db, principal, group, prd, goal, track, from_, to, roadmap)


@router.get("/waiting", response_model=SimpleRoadmapWaiting)
async def get_simple_roadmap_waiting(principal: Reader, db: TenantDB) -> SimpleRoadmapWaiting:
    """roadmap-decide review: the side menu's light count: the broken links of the whole
    roadmap as the caller sees it (the working draft's to who sees it), no filter; the same
    ones the roadmap's strip, its Needs a decision and Home count; and the dates the caller may
    confirm, so the side menu's count equals Needs a decision."""
    links, dates = await service.waiting(db, principal)
    return SimpleRoadmapWaiting(broken_links=links, dates_to_confirm=dates)


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


@router.post("/apply-approved", response_model=SimpleAppliedVersion)
async def apply_approved_roadmap(
    principal: Approver, db: TenantDB, roadmap: Annotated[str, Query(max_length=200)]
) -> SimpleAppliedVersion:
    """approved-roadmap-to-simple: apply the roadmap's latest approved version to its items
    again (its dates, shipped and new items, milestones), approvers and up. 404: no such
    roadmap, or none approved; 409: the version has no plan to apply."""
    from sqlalchemy import or_, select

    from oracle.docs.models import Document

    key = uuid.UUID(roadmap) if _is_uuid(roadmap) else None
    doc = await db.scalar(
        select(Document).where(
            Document.kind == "roadmap",
            or_(Document.slug == roadmap, Document.id == key) if key else Document.slug == roadmap,
        )
    )
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such roadmap")
    version = await approved_roadmap.latest_approved(db, doc.id)
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This roadmap has no approved version yet")
    if not await approved_roadmap.apply(db, principal, doc, version):
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Version {version.number} has no plan table to apply"
        )
    await db.commit()
    out = await service.build(db, principal, roadmap=str(doc.id))
    [line] = [x for x in out.applied_versions if x.roadmap.id == doc.id] or [None]
    if line is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Version {version.number} has no items to apply it to"
        )
    return line


def _is_uuid(text: str) -> bool:
    try:
        uuid.UUID(text)
    except ValueError:
        return False
    return True


@router.post("/date-suggestions/refresh", response_model=RefreshOut)
async def refresh_date_suggestions(principal: Approver, db: TenantDB) -> RefreshOut:
    """Regenerate the suggestions now (the minute tick does it once a day)."""
    count = await suggestions.regenerate(db)
    await audit.record(db, principal, "roadmap_date_suggestion.refresh", "roadmap_date_suggestion",
                       data={"open": count})  # fmt: skip
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


# --------------------------------------------------------------------------- goal milestones


@router.post("/milestones", response_model=SimpleGoalMilestone,
             status_code=status.HTTP_201_CREATED)  # fmt: skip
async def create_goal_milestone(
    body: SimpleGoalMilestoneIn, principal: Commenter, db: TenantDB
) -> SimpleGoalMilestone:
    """Add a milestone to a goal on a roadmap: coded the next "M<n>" in that goal on that
    roadmap. Who may change the roadmap directly (an owner, its decider, with none its
    owner while an approver, same as a key date); a commenter is refused (403: milestones
    are not proposed here, unlike key dates)."""
    return await goal_milestones.create(db, principal, body)


@router.patch("/milestones/{milestone_id}", response_model=SimpleGoalMilestone)
async def patch_goal_milestone(
    milestone_id: uuid.UUID, body: SimpleGoalMilestonePatch, principal: Commenter, db: TenantDB
) -> SimpleGoalMilestone:
    """Edit a milestone's name, date, goal, items it waits on or counts-when rule. A PRD's
    own milestone is read-only here: a date or counts-when edit instead proposes a change
    to the PRD's owner (``pending`` filled, the milestone unchanged) through the change
    engine (``POST /v1/simple/changes/{id}/accept|decline``); its name, goal and items are
    the PRD's own and are 422 here."""
    return await goal_milestones.patch(db, principal, milestone_id, body)


@router.delete("/milestones/{milestone_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_goal_milestone(
    milestone_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> None:
    """Delete one of the roadmap's own milestones (undo: PATCH the old values back, or
    restore). A PRD's own milestone is 409: it is not deleted here."""
    await goal_milestones.delete(db, principal, milestone_id)


@router.post("/milestones/{milestone_id}/restore", response_model=SimpleGoalMilestone)
async def restore_goal_milestone(
    milestone_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleGoalMilestone:
    """Undo a delete: clears the milestone's ``deleted_at``."""
    return await goal_milestones.restore(db, principal, milestone_id)
