"""Feature priorities from the baseline, every number explained, and snapshots of them.

Anyone signed in reads a ranking; approvers and owners store a snapshot.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import require_role
from oracle.priorities import service
from oracle.priorities.schemas import (
    Method,
    PriorityRanking,
    PrioritySnapshotCreate,
    PrioritySnapshotOut,
    PrioritySnapshotSummary,
)

router = APIRouter(prefix="/v1", tags=["priorities"])


@router.get("/priorities", response_model=PriorityRanking)
async def get_priorities(
    db: TenantDB, _: CurrentPrincipal, method: Method = "goal_weighted"
) -> PriorityRanking:
    """Rank the baseline's features by ``method``, in dependency order.

    Features that serve no confirmed goal sink to the bottom and are flagged;
    dependency cycles are listed in ``cycles`` and their members flagged.
    """
    return await service.compute(db, method)


@router.post(
    "/priorities/snapshots", response_model=PrioritySnapshotOut, status_code=status.HTTP_201_CREATED
)
async def create_priority_snapshot(
    data: PrioritySnapshotCreate,
    db: TenantDB,
    principal: Annotated[Principal, Depends(require_role("approver"))],
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
