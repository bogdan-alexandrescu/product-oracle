"""Current state beside Desired state (``/v1/feature-states``): every confirmed feature's
mark and proof, Check again, the owner's "does it still run?" answer, Move / Not yet and
the item chat's "Mark as already shipped" (oracle.currentstate.service).

Reading is open to every member. Changing needs what confirming an entity needs
(``confirm_entity``); ``can_move`` and ``can_answer`` say whether the caller may.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from oracle import company_time
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import has_role, require_role, require_role_now
from oracle.currentstate import service
from oracle.currentstate.schemas import (
    FeatureAnswerIn,
    FeatureMoveIn,
    FeatureStateOut,
    FeatureStatesOut,
)

router = APIRouter(prefix="/v1", tags=["currentstate"])

# The role confirm_entity needs (oracle.baseline.router's ApproverNow).
CONFIRM_ROLE = "approver"
Reader = Annotated[Principal, Depends(require_role("viewer"))]
Confirmer = Annotated[Principal, Depends(require_role_now(CONFIRM_ROLE))]
NOT_FOUND = {404: {"description": "No such confirmed feature"}}


def _can_confirm(request: Request, principal: Principal) -> bool:
    from oracle.capabilities import operation_roles

    need = operation_roles(request.app).get("confirm_entity", CONFIRM_ROLE)
    return has_role(principal.role, need)


async def _feature(db, feature_id: uuid.UUID):
    try:
        return await service.feature(db, feature_id)
    except service.NotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such feature") from exc


@router.get("/feature-states", response_model=FeatureStatesOut)
async def list_feature_states(
    request: Request, principal: Reader, db: TenantDB
) -> FeatureStatesOut:
    """Every confirmed feature with its mark and proof, and the counts."""
    can = _can_confirm(request, principal)
    return await service.listing(db, company_time.now(), can_move=can, can_answer=can)


@router.post(
    "/feature-states/{feature_id}/check", response_model=FeatureStateOut, responses=NOT_FOUND
)
async def check_feature_state(
    feature_id: uuid.UUID, principal: Confirmer, db: TenantDB
) -> FeatureStateOut:
    """Check again: read the feature's proof now."""
    f = await _feature(db, feature_id)
    now = company_time.now()
    await service.reread(db, f, now)
    await db.commit()
    return await service.one(db, f, now)


@router.post(
    "/feature-states/{feature_id}/answer", response_model=FeatureStateOut, responses=NOT_FOUND
)
async def answer_feature_state(
    feature_id: uuid.UUID, body: FeatureAnswerIn, principal: Confirmer, db: TenantDB
) -> FeatureStateOut:
    """The owner's answer to "does it still run?": still_runs counts as fresh proof,
    changed keeps it in Current state, no_longer_runs puts it back in Desired state."""
    f = await _feature(db, feature_id)
    now = company_time.now()
    await service.answer(db, f, body.answer, principal.user_id, now)
    await db.commit()
    return await service.one(db, f, now)


@router.post(
    "/feature-states/{feature_id}/move",
    response_model=FeatureStateOut,
    responses={**NOT_FOUND, 409: {"description": "Not ready to move: some proof is missing"}},
)
async def move_feature_state(
    feature_id: uuid.UUID, body: FeatureMoveIn, principal: Confirmer, db: TenantDB
) -> FeatureStateOut:
    """Move a ready feature to Current state, or Not yet (off the ready band until its
    proof is read again)."""
    f = await _feature(db, feature_id)
    now = company_time.now()
    try:
        await service.move(db, f, body.decision, principal.user_id, now)
    except service.NotReady as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "Not ready to move yet") from exc
    await db.commit()
    return await service.one(db, f, now)


@router.post(
    "/feature-states/{feature_id}/shipped", response_model=FeatureStateOut, responses=NOT_FOUND
)
async def mark_feature_shipped(
    feature_id: uuid.UUID, principal: Confirmer, db: TenantDB
) -> FeatureStateOut:
    """Mark as already shipped: it exists, with no proof read yet."""
    f = await _feature(db, feature_id)
    now = company_time.now()
    await service.shipped(db, f, now)
    await db.commit()
    return await service.one(db, f, now)
