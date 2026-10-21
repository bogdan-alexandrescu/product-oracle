"""Feature priorities from the baseline, every number explained, and snapshots of them.

Anyone signed in reads a ranking and the log of people's changes to it; approvers and
owners store a snapshot, and move, pin or remove a feature with a reason (C9). Oracle
pushes back once (409) when the numbers or the evidence disagree with a change.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import require_role_now
from oracle.priorities import service
from oracle.priorities.schemas import (
    Method,
    OverrideCreate,
    OverrideOut,
    OverrideRemove,
    PriorityRanking,
    PrioritySnapshotCreate,
    PrioritySnapshotOut,
    PrioritySnapshotSummary,
    PushbackOut,
)

router = APIRouter(prefix="/v1", tags=["priorities"])
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]


@router.get("/priorities", response_model=PriorityRanking)
async def get_priorities(
    db: TenantDB,
    principal: CurrentPrincipal,
    method: Method = "goal_weighted",
    overrides: Annotated[
        bool, Query(description="false: Oracle's order only, without people's moves and pins")
    ] = True,
) -> PriorityRanking:
    """Rank the baseline's features by ``method``, in dependency order.

    Features that serve no confirmed goal sink to the bottom and are flagged;
    dependency cycles are listed in ``cycles`` and their members flagged. People's
    active moves and pins apply after the formula (``overrides=false`` leaves them out):
    each row carries ``formula_rank`` (Oracle's rank) and the ``override`` that placed it.
    """
    return await service.compute(db, method, principal, overrides=overrides)


@router.post(
    "/priorities/overrides",
    response_model=OverrideOut,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"model": PushbackOut, "description": "Oracle disagrees: nothing stored"}},
)
async def create_priority_override(
    data: OverrideCreate, db: TenantDB, principal: ApproverNow
) -> OverrideOut | JSONResponse:
    """Move a feature directly above another, or pin it at a rank, with a reason.

    Oracle checks the change first: four rules on the ranking's numbers, then its own
    model reads the reason against the evidence (at most one more message). When any
    message results, nothing is stored and the answer is 409 with Oracle's pushback;
    the same body with ``confirm: true`` keeps the change (no second check). A move or
    pin never puts a feature above one it depends on (``held_below``). A new change on a
    feature replaces its active one.
    """
    try:
        return await service.create_override(db, data, principal)
    except service.Pushback as e:
        return JSONResponse(PushbackOut.model_validate(e.body).model_dump(mode="json"), 409)
    except service.InvalidError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    except service.ConflictError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    except service.ForbiddenError as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e


@router.delete("/priorities/overrides/{override_id}", response_model=OverrideOut)
async def remove_priority_override(
    override_id: uuid.UUID,
    db: TenantDB,
    principal: ApproverNow,
    data: Annotated[OverrideRemove | None, Body()] = None,
) -> OverrideOut:
    """End a move or pin: the feature returns to Oracle's order. The log keeps it."""
    try:
        return await service.remove_override(
            db, override_id, data.reason if data else None, principal
        )
    except service.NotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    except service.ConflictError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    except service.ForbiddenError as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e


@router.get("/priorities/overrides", response_model=list[OverrideOut])
async def list_priority_overrides(
    db: TenantDB,
    _: CurrentPrincipal,
    snapshot_id: uuid.UUID | None = None,
    include_removed: bool = False,
    limit: int = Query(50, ge=1, le=200),
) -> list[OverrideOut]:
    """People's moves and pins, newest first: active ones, or all ever made
    (``include_removed``), with Oracle's pushback and whether each was kept."""
    return await service.list_overrides(db, snapshot_id, include_removed, limit)


@router.post(
    "/priorities/snapshots", response_model=PrioritySnapshotOut, status_code=status.HTTP_201_CREATED
)
async def create_priority_snapshot(
    data: PrioritySnapshotCreate,
    db: TenantDB,
    principal: ApproverNow,
) -> PrioritySnapshotOut:
    return await service.create_snapshot(db, data.method, data.note, principal)


@router.get("/priorities/snapshots", response_model=list[PrioritySnapshotSummary])
async def list_priority_snapshots(
    db: TenantDB, _: CurrentPrincipal, limit: int = Query(50, ge=1, le=200)
) -> list[PrioritySnapshotSummary]:
    return await service.list_snapshots(db, limit)


@router.get("/priorities/snapshots/{snapshot_id}", response_model=PrioritySnapshotOut)
async def get_priority_snapshot(
    snapshot_id: uuid.UUID, db: TenantDB, _: CurrentPrincipal
) -> PrioritySnapshotOut:
    try:
        return await service.read_snapshot(db, snapshot_id)
    except service.NotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
