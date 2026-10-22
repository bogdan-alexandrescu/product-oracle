"""Feature priorities from the baseline, every number explained, and snapshots of them.

Anyone signed in reads a ranking; approvers and owners store a snapshot.
"""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import require_role_now
from oracle.priorities import service
from oracle.priorities.schemas import (
    CompareOut,
    Method,
    PriorityRanking,
    PrioritySnapshotCreate,
    PrioritySnapshotOut,
    PrioritySnapshotSummary,
)

# Which snapshots a reader sees: saved by default (C8: a run's order is proposed until its
# priority stop is approved, discarded when sent back).
StatusFilter = Literal["saved", "proposed", "discarded", "all"]

router = APIRouter(prefix="/v1", tags=["priorities"])
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]


@router.get("/priorities", response_model=PriorityRanking)
async def get_priorities(
    db: TenantDB, principal: CurrentPrincipal, method: Method = "goal_weighted"
) -> PriorityRanking:
    """Rank the baseline's features by ``method``, in dependency order.

    Features that serve no confirmed goal sink to the bottom and are flagged;
    dependency cycles are listed in ``cycles`` and their members flagged.
    """
    return await service.compute(db, method, principal)


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
    db: TenantDB,
    _: CurrentPrincipal,
    limit: int = Query(50, ge=1, le=200),
    status: StatusFilter = "saved",
) -> list[PrioritySnapshotSummary]:
    return await service.list_snapshots(db, limit, status)


@router.get("/priorities/snapshots/{snapshot_id}", response_model=PrioritySnapshotOut)
async def get_priority_snapshot(
    snapshot_id: uuid.UUID, db: TenantDB, _: CurrentPrincipal, status: StatusFilter = "saved"
) -> PrioritySnapshotOut:
    try:
        return await service.read_snapshot(db, snapshot_id, status)
    except service.NotFoundError as e:
        raise HTTPException(404, str(e)) from e


@router.get("/priorities/snapshots/{snapshot_id}/compare", response_model=CompareOut)
async def compare_priority_snapshot(
    snapshot_id: uuid.UUID, db: TenantDB, principal: CurrentPrincipal
) -> CompareOut:
    """A snapshot in any status (a run's proposed order included) next to the live
    ranking of its method: each row's run rank, live rank, delta and the check's problems,
    and the run and checkpoint that decide it."""
    try:
        return await service.compare(db, snapshot_id, principal)
    except service.NotFoundError as e:
        raise HTTPException(404, str(e)) from e
