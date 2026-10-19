"""Members, invites and API tokens. Owners only.

Logic lives in :mod:`oracle.members.service`; each handler commits once.
"""

import logging
import uuid
from collections.abc import Awaitable
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.connections.router import ProviderHttp
from oracle.members import service
from oracle.members.schemas import (
    ApiTokenOut,
    InviteCreate,
    InviteOut,
    InviteStatus,
    MemberOut,
    MemberPatch,
    TokenApprovalOut,
)

router = APIRouter(prefix="/v1", tags=["members"], dependencies=[Depends(require_role("owner"))])
Owner = Annotated[Principal, Depends(require_role("owner"))]

_STATUS = {
    "not_found": status.HTTP_404_NOT_FOUND,
    "conflict": status.HTTP_409_CONFLICT,
    "forbidden": status.HTTP_403_FORBIDDEN,
}
log = logging.getLogger(__name__)
_REFUSED = {403: {"description": "The caller is no longer an owner (re-read under the lock)"}}


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except service.MemberError as e:
        raise HTTPException(_STATUS[e.kind], e.message) from e


@router.get("/members", response_model=list[MemberOut])
async def list_members(db: TenantDB) -> list[MemberOut]:
    """The users of this company's Oracle, their roles, and whether each is active or
    disabled (a removed member: kept so history keeps their name)."""
    return [MemberOut.model_validate(u) for u in await service.list_members(db)]


@router.patch(
    "/members/{user_id}",
    response_model=MemberOut,
    responses={409: {"description": "Would demote the last owner"}, **_REFUSED},
)
async def update_member(
    user_id: uuid.UUID, body: MemberPatch, principal: Owner, db: TenantDB
) -> MemberOut:
    user = await _call(service.set_role(db, principal, user_id, body.role))
    await db.commit()
    return MemberOut.model_validate(user)


@router.post(
    "/members/{user_id}/disable",
    response_model=MemberOut,
    responses={
        404: {"description": "No such member"},
        409: {"description": "The last owner"},
        **_REFUSED,
    },
)
async def disable_member(
    user_id: uuid.UUID, principal: Owner, db: TenantDB, http: ProviderHttp
) -> MemberOut:
    """Remove a member by disabling them: sign-in is refused on every path; their
    connections are disconnected (revoked at the provider) and their sources recorded
    as revoked, so documents citing them cannot publish; their API tokens and OAuth
    grants are revoked, their runs cancelled, the open invite for their email revoked;
    their approvals lapse for good; the invites they sent are revoked, their queued
    model jobs cancelled and their spend approval of a run not yet started voided. Every
    session ends: after a restore they sign in fresh. The member stays in the list
    (history keeps the name); an owner can restore them. A no-op for a disabled member.

    The revoke at the provider and the cancel at SwarmCloud are made after the disable
    commits; a failed call is retried by ``POST /v1/internal/tick``."""
    user = await _call(service.disable_member(db, principal, user_id))
    await db.commit()
    out = MemberOut.model_validate(user)
    await _followups(db, http, principal, user.id)
    return out


async def _followups(db: TenantDB, http: ProviderHttp, principal: Principal, user_id) -> None:
    """The provider and SwarmCloud calls the disable owes, after it committed (never
    under the review gate). A failure is recorded and retried by the ticker."""
    try:
        await service.run_followups(db, http, principal, user_id=user_id)
    except Exception:  # the disable stands; the ticker retries
        log.exception("disable follow-ups for member %s failed", user_id)
        await db.rollback()


@router.post(
    "/members/{user_id}/restore",
    response_model=MemberOut,
    responses={404: {"description": "No such member"}, **_REFUSED},
)
async def restore_member(user_id: uuid.UUID, principal: Owner, db: TenantDB) -> MemberOut:
    """Let a disabled member sign in again, with their role. Their approvals stay
    lapsed, their tokens revoked and their connections gone: nothing else comes back,
    and no session from before the disable works: they sign in fresh."""
    user = await _call(service.restore_member(db, principal, user_id))
    await db.commit()
    return MemberOut.model_validate(user)


@router.delete(
    "/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    deprecated=True,
    responses={
        404: {"description": "No such member"},
        409: {"description": "The last owner"},
        **_REFUSED,
    },
)
async def remove_member(
    user_id: uuid.UUID, principal: Owner, db: TenantDB, http: ProviderHttp
) -> None:
    """Remove a member: the same as ``POST /v1/members/{user_id}/disable`` (a member is
    never deleted; their row keeps the history's names)."""
    user = await _call(service.disable_member(db, principal, user_id))
    await db.commit()
    await _followups(db, http, principal, user.id)


@router.get("/api-tokens", response_model=list[ApiTokenOut])
async def list_api_tokens(db: TenantDB) -> list[ApiTokenOut]:
    """Every API token of this company (never the secret), revoked ones included."""
    return [ApiTokenOut.model_validate(t) for t in await service.list_api_tokens(db)]


@router.delete(
    "/api-tokens/{token_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={404: {"description": "No such token"}, **_REFUSED},
)
async def revoke_api_token(token_id: uuid.UUID, principal: Owner, db: TenantDB) -> None:
    """Revoke an API token. The approvals given through it lapse for good (section
    verdicts and version approvals); its user's own approvals stand. Revoking twice is
    a no-op."""
    await _call(service.revoke_api_token(db, principal, token_id))
    await db.commit()


@router.get(
    "/api-tokens/{token_id}/approvals",
    response_model=list[TokenApprovalOut],
    responses={404: {"description": "No such token"}},
)
async def token_approvals(token_id: uuid.UUID, db: TenantDB) -> list[TokenApprovalOut]:
    """The approvals given through an API token, oldest first, lapsed ones included
    (``lapsed_at``): what revoking it voids, or voided."""
    rows = await service.token_approvals(db, token_id)
    if rows is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"API token {token_id} not found")
    return [TokenApprovalOut.model_validate(r) for r in rows]


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
    responses={409: {"description": "Already a member, or an open invite exists"}, **_REFUSED},
)
async def create_invite(body: InviteCreate, principal: Owner, db: TenantDB) -> InviteOut:
    """Pre-assign a role to an email: its first Google sign-in lands with that role."""
    invite = await _call(service.create_invite(db, principal, body.email, body.role))
    await db.commit()
    await db.refresh(invite)
    return service.invite_out(invite)


@router.delete("/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT, responses=_REFUSED)
async def revoke_invite(invite_id: uuid.UUID, principal: Owner, db: TenantDB) -> None:
    """Revoke an open invite. Revoking twice is a no-op; an accepted invite is a 409."""
    await _call(service.revoke_invite(db, principal, invite_id))
    await db.commit()
