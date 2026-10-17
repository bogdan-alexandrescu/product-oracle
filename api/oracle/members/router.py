"""Members and invites. Owners only.

Logic lives in :mod:`oracle.members.service`; each handler commits once.
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.members import service
from oracle.members.schemas import InviteCreate, InviteOut, InviteStatus, MemberOut, MemberPatch

router = APIRouter(prefix="/v1", tags=["members"], dependencies=[Depends(require_role("owner"))])
Owner = Annotated[Principal, Depends(require_role("owner"))]

_STATUS = {"not_found": status.HTTP_404_NOT_FOUND, "conflict": status.HTTP_409_CONFLICT}


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except service.MemberError as e:
        raise HTTPException(_STATUS[e.kind], e.message) from e


@router.get("/members", response_model=list[MemberOut])
async def list_members(db: TenantDB) -> list[MemberOut]:
    """The users of this company's Oracle and their roles."""
    return [MemberOut.model_validate(u) for u in await service.list_members(db)]


@router.patch(
    "/members/{user_id}",
    response_model=MemberOut,
    responses={409: {"description": "Would demote the last owner"}},
)
async def update_member(
    user_id: uuid.UUID, body: MemberPatch, principal: Owner, db: TenantDB
) -> MemberOut:
    user = await _call(service.set_role(db, principal, user_id, body.role))
    await db.commit()
    return MemberOut.model_validate(user)


@router.get("/invites", response_model=list[InviteOut])
async def list_invites(
    db: TenantDB, status: InviteStatus | Literal["all"] = "open"
) -> list[InviteOut]:
    """Invites, newest first: open ones unless ``status`` asks for others (or ``all``)."""
    return [service.invite_out(i) for i in await service.list_invites(db, status)]


@router.post(
    "/invites",
    response_model=InviteOut,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"description": "Already a member, or an open invite exists"}},
)
async def create_invite(body: InviteCreate, principal: Owner, db: TenantDB) -> InviteOut:
    """Pre-assign a role to an email: its first Google sign-in lands with that role."""
    invite = await _call(service.create_invite(db, principal, body.email, body.role))
    await db.commit()
    await db.refresh(invite)
    return service.invite_out(invite)


@router.delete("/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(invite_id: uuid.UUID, principal: Owner, db: TenantDB) -> None:
    """Revoke an open invite. Revoking twice is a no-op; an accepted invite is a 409."""
    await _call(service.revoke_invite(db, principal, invite_id))
    await db.commit()
