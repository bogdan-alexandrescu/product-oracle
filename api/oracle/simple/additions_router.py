"""Simple S7 (#723, D15): Oracle's goal suggestions (oracle.simple.additions). Adding an
item, merging a draft and keeping both are change-engine ops (``POST /v1/simple/changes``).

- ``GET /v1/simple/goal-suggestions``: viewer and up; each goal's suggestions (default the
  open ones), whether Oracle is suggesting for it now and whether it has no items.
- ``POST /v1/simple/goals/{goal_id}/suggest``: commenter and up; "Suggest features".
- ``POST /v1/simple/goals/{goal_id}/suggestions``: commenter and up; a person's own
  suggestion (origin ``person``), next to Oracle's; 409 for a title like an open or
  rejected one of the goal.
- ``POST /v1/simple/goal-suggestions/{id}/accept``: who decides the goal's suggestions (an
  owner, the goal roadmap's decider, with none its approving owners); an ``add_item`` on
  its goal, applied at once (with Undo).
- ``POST /v1/simple/goal-suggestions/{id}/reject``: the same people, an optional reason.
"""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query

from oracle.auth.deps import Principal, TenantDB
from oracle.simple import additions
from oracle.simple.changes_router import _run
from oracle.simple.router import _people
from oracle.simple.schemas import (
    SimpleChangeResult,
    SimpleGoalSuggestion,
    SimpleGoalSuggestionIn,
    SimpleGoalSuggestionsOut,
    SimpleSuggestionAcceptIn,
    SimpleSuggestionRejectIn,
    SimpleSuggestJobOut,
)

router = APIRouter(prefix="/v1/simple", tags=["simple"])

Reader = Annotated[Principal, Depends(_people("viewer"))]


@router.get("/goal-suggestions", response_model=SimpleGoalSuggestionsOut,
            name="list_goal_suggestions")  # fmt: skip
async def list_goal_suggestions(
    principal: Reader,
    db: TenantDB,
    goal_id: uuid.UUID | None = None,
    status: Annotated[Literal["open", "accepted", "rejected"] | None, Query()] = "open",
) -> SimpleGoalSuggestionsOut:
    """S7: goal suggestions and each goal's pending and empty state."""
    return await _run(db, additions.listing(db, principal, goal_id, status))


@router.post("/goals/{goal_id}/suggest", response_model=SimpleSuggestJobOut,
             name="suggest_goal_features")  # fmt: skip
async def suggest_goal_features(
    goal_id: uuid.UUID, principal: Reader, db: TenantDB
) -> SimpleSuggestJobOut:
    """S7: Suggest features (a job proposes 3-5)."""
    out = await _run(db, additions.suggest(db, principal, goal_id))
    await db.commit()
    return out


@router.post("/goals/{goal_id}/suggestions", response_model=SimpleGoalSuggestion,
             status_code=201, name="create_goal_suggestion")  # fmt: skip
async def create_goal_suggestion(
    goal_id: uuid.UUID, body: SimpleGoalSuggestionIn, principal: Reader, db: TenantDB
) -> SimpleGoalSuggestion:
    """People's suggestions: file one on a goal, next to Oracle's."""
    return await _run(
        db, additions.create_suggestion(db, principal, goal_id, body.title, body.outcome)
    )


@router.post("/goal-suggestions/{suggestion_id}/accept", response_model=SimpleChangeResult,
             name="accept_goal_suggestion")  # fmt: skip
async def accept_goal_suggestion(
    suggestion_id: uuid.UUID, principal: Reader, db: TenantDB,
    body: SimpleSuggestionAcceptIn | None = None,
) -> SimpleChangeResult:  # fmt: skip
    """S7: accept a goal suggestion (an add_item change)."""
    body = body or SimpleSuggestionAcceptIn()
    return await _run(
        db, additions.accept(db, principal, suggestion_id, body.roadmap_id, body.session_id)
    )


@router.post("/goal-suggestions/{suggestion_id}/reject", response_model=SimpleGoalSuggestion,
             name="reject_goal_suggestion")  # fmt: skip
async def reject_goal_suggestion(
    suggestion_id: uuid.UUID, principal: Reader, db: TenantDB,
    body: SimpleSuggestionRejectIn | None = None,
) -> SimpleGoalSuggestion:  # fmt: skip
    """S7: reject a goal suggestion with an optional reason."""
    out = await _run(
        db,
        additions.reject(db, principal, suggestion_id, (body or SimpleSuggestionRejectIn()).reason),
    )
    await db.commit()
    return out
