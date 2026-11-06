"""Simple Goal map (build-goal-map), for people (a run's token is refused):

- ``GET /v1/simple/goal-map``: viewer and up; ``can_edit`` says whether they may edit.
- ``POST /areas``, ``PUT /areas/order``, ``PATCH /goals/{id}``, ``POST /milestones``
  (propose one), ``PATCH /milestones/{id}`` (set its threshold, confirm it), ``POST /links``
  (attach a feature to a cell), ``POST /goals/{id}/metric`` (pick the metric that gives
  the goal its readings), ``POST /links/move`` (goal-ladder: a feature to another
  milestone): approver and up; each answers the map as it now reads.
- ``POST /place-card`` and ``DELETE /places`` (goal-ladder place_card and Tidy up): viewer
  and up, each person's own places of cards.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.auth.models import User
from oracle.authz import has_role, require_role
from oracle.simple import goal_map
from oracle.simple.goal_map import (
    AreaIn,
    AreaOrderIn,
    AttachIn,
    GateIn,
    GoalMapOut,
    GoalTargetIn,
    MetricPickIn,
    MoveLinkIn,
    PlaceIn,
    ProposeIn,
)

router = APIRouter(prefix="/v1/simple/goal-map", tags=["simple"])


def _people(role: str):
    async def check(principal: Annotated[Principal, Depends(require_role(role))]) -> Principal:
        if principal.run_id is not None or principal.run_token_id is not None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Simple is not available to runs")
        return principal

    return check


Reader = Annotated[Principal, Depends(_people("viewer"))]
Approver = Annotated[Principal, Depends(_people("approver"))]


def _can_edit(principal: Principal) -> bool:
    return has_role(principal.role, "approver") and not principal.read_only


async def _done(db: TenantDB, principal: Principal) -> GoalMapOut:
    await db.commit()
    return await goal_map.build(db, principal, _can_edit(principal))


async def _run(db: TenantDB, principal: Principal, step) -> GoalMapOut:
    try:
        await step
    except goal_map.GoalMapError as e:
        await db.rollback()
        raise HTTPException(e.status, e.detail) from e
    return await _done(db, principal)


async def _who(db: TenantDB, principal: Principal) -> str:
    user = await db.get(User, principal.user_id) if principal.user_id else None
    return (user.name or user.email) if user else "An API token"


@router.get("", response_model=GoalMapOut)
async def get_goal_map(principal: Reader, db: TenantDB) -> GoalMapOut:
    return await goal_map.build(db, principal, _can_edit(principal))


@router.post("/areas", response_model=GoalMapOut)
async def add_area(body: AreaIn, principal: Approver, db: TenantDB) -> GoalMapOut:
    return await _run(db, principal, goal_map.add_area(db, body))


@router.put("/areas/order", response_model=GoalMapOut)
async def order_areas(body: AreaOrderIn, principal: Approver, db: TenantDB) -> GoalMapOut:
    return await _run(db, principal, goal_map.order_areas(db, body.ids))


@router.patch("/goals/{goal_id}", response_model=GoalMapOut)
async def edit_goal(
    goal_id: uuid.UUID, body: GoalTargetIn, principal: Approver, db: TenantDB
) -> GoalMapOut:
    who = await _who(db, principal)
    return await _run(db, principal, goal_map.edit_goal(db, goal_id, body.target, who))


@router.post("/milestones", response_model=GoalMapOut)
async def propose_milestone(body: ProposeIn, principal: Approver, db: TenantDB) -> GoalMapOut:
    return await _run(db, principal, goal_map.propose(db, body, principal.user_id))


@router.patch("/milestones/{milestone_id}", response_model=GoalMapOut)
async def set_gate(
    milestone_id: uuid.UUID, body: GateIn, principal: Approver, db: TenantDB
) -> GoalMapOut:
    return await _run(
        db, principal, goal_map.set_gate(db, milestone_id, body, await _who(db, principal))
    )


@router.post("/links", response_model=GoalMapOut)
async def attach_feature(body: AttachIn, principal: Approver, db: TenantDB) -> GoalMapOut:
    return await _run(db, principal, goal_map.attach(db, body))


@router.post("/links/move", response_model=GoalMapOut)
async def move_feature_link(body: MoveLinkIn, principal: Approver, db: TenantDB) -> GoalMapOut:
    """goal-ladder: a feature moved to another milestone's work (Edit ladder)."""
    return await _run(db, principal, goal_map.move_link(db, body))


@router.post("/place-card", response_model=GoalMapOut)
async def place_card(body: PlaceIn, principal: Reader, db: TenantDB) -> GoalMapOut:
    """goal-ladder place_card: where this person put a card on the canvas (viewers too: a
    place is their own view and never changes data)."""
    return await _run(db, principal, goal_map.place_card(db, principal.id, body))


@router.delete("/places", response_model=GoalMapOut)
async def tidy_up(principal: Reader, db: TenantDB) -> GoalMapOut:
    """goal-ladder Tidy up: this person's cards back where the ladder places them."""
    return await _run(db, principal, goal_map.tidy_up(db, principal.id))


@router.post("/goals/{goal_id}/metric", response_model=GoalMapOut)
async def pick_goal_metric(
    goal_id: uuid.UUID, body: MetricPickIn, principal: Approver, db: TenantDB
) -> GoalMapOut:
    """Pick the metric that gives the goal its readings: its weekly values become the
    goal's readings at once; the goal's old metric lets go."""
    try:
        metric = await goal_map.pick_metric(db, goal_id, body.metric)
    except goal_map.GoalMapError as e:
        await db.rollback()
        raise HTTPException(e.status, e.detail) from e
    await audit.record(db, principal, "metric.updated", "metric", metric.id,
                       {"fields": ["goal_id"], "goal_id": str(goal_id)})  # fmt: skip
    return await _done(db, principal)
