"""Members, invites and API tokens. Owners only.

Logic lives in :mod:`oracle.members.service`; each handler commits once.
"""

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
    FollowUpOut,
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
    # The caller is no longer an owner, or their token or grant was revoked, by a change
    # that committed while their request waited (re-read under the gate).
    "forbidden": status.HTTP_403_FORBIDDEN,
}


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
    responses={409: {"description": "Would demote the last owner"}},
)
async def update_member(
    user_id: uuid.UUID, body: MemberPatch, principal: Owner, db: TenantDB, http: ProviderHttp
) -> MemberOut:
    """Change a member's role. A demotion lapses their approvals for good, and voids
    their pending spend approvals and not-yet-acted checkpoint decisions the new role no
    longer allows (they return to the Inbox); a run busy right then is rechecked just
    after the change commits, and by the tick."""
    user = await _call(service.set_role(db, principal, user_id, body.role))
    await db.commit()
    await service.run_follow_ups(db, principal, http, member_id=user.id)
    return MemberOut.model_validate(user)


@router.post(
    "/members/{user_id}/disable",
    response_model=MemberOut,
    responses={404: {"description": "No such member"}, 409: {"description": "The last owner"}},
)
async def disable_member(
    user_id: uuid.UUID, principal: Owner, db: TenantDB, http: ProviderHttp
) -> MemberOut:
    """Remove a member by disabling them: sign-in is refused on every path; their
    connections are disconnected (revoked at the provider) and their sources recorded
    as revoked, so documents citing them cannot publish; their API tokens and OAuth
    grants are revoked, their runs cancelled, the open invite for their email revoked;
    their approvals lapse for good; every session they signed is ended. The calls at
    the providers and the runtime are made after the disable commits, outside the
    review gate, and retried by the tick when they fail. The member stays in the list
    (history keeps the name); an owner can restore them, and they sign in fresh. A
    no-op for a disabled member."""
    user = await _call(service.disable_member(db, principal, user_id))
    await db.commit()
    # The provider and runtime calls it owes, outside the review gate (retried by the tick).
    await service.after_disable(db, principal, user.id, http)
    return MemberOut.model_validate(user)


@router.post(
    "/members/{user_id}/restore",
    response_model=MemberOut,
    responses={404: {"description": "No such member"}},
)
async def restore_member(user_id: uuid.UUID, principal: Owner, db: TenantDB) -> MemberOut:
    """Let a disabled member sign in again, with their role. Their approvals stay
    lapsed, their tokens revoked and their connections gone: nothing else comes back."""
    user = await _call(service.restore_member(db, principal, user_id))
    await db.commit()
    return MemberOut.model_validate(user)


@router.delete(
    "/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    deprecated=True,
    responses={404: {"description": "No such member"}, 409: {"description": "The last owner"}},
)
async def remove_member(
    user_id: uuid.UUID, principal: Owner, db: TenantDB, http: ProviderHttp
) -> None:
    """Remove a member: the same as ``POST /v1/members/{user_id}/disable`` (a member is
    never deleted; their row keeps the history's names)."""
    user = await _call(service.disable_member(db, principal, user_id))
    await db.commit()
    await service.after_disable(db, principal, user.id, http)


@router.get("/api-tokens", response_model=list[ApiTokenOut])
async def list_api_tokens(db: TenantDB) -> list[ApiTokenOut]:
    """Every API token of this company (never the secret), revoked ones included."""
    return [ApiTokenOut.model_validate(t) for t in await service.list_api_tokens(db)]


@router.delete(
    "/api-tokens/{token_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={404: {"description": "No such token"}},
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


# --- Follow-ups a disable owes (Inbox: Retry, Dismiss) ------------------------------------


@router.post(
    "/member-follow-ups/{follow_up_id}/retry",
    response_model=FollowUpOut,
    responses={404: {"description": "No such follow-up"}, 409: {"description": "Not open"}},
)
async def retry_member_follow_up(
    follow_up_id: uuid.UUID, principal: Owner, db: TenantDB, http: ProviderHttp
) -> FollowUpOut:
    """Make a provider revoke (or runtime cancel) a disable still owes now, whatever its
    backoff or its 24 hours of retries. A success drops Oracle's copy of the credential."""
    row = await _call(service.retry_follow_up(db, principal, follow_up_id, http))
    return FollowUpOut.model_validate(row)


@router.post(
    "/member-follow-ups/{follow_up_id}/dismiss",
    response_model=FollowUpOut,
    responses={404: {"description": "No such follow-up"}, 409: {"description": "Not open"}},
)
async def dismiss_member_follow_up(
    follow_up_id: uuid.UUID, principal: Owner, db: TenantDB
) -> FollowUpOut:
    """Stop trying a provider revoke (or runtime cancel) a disable owes: Oracle's copy of
    the credential is dropped, and the dismissal audited."""
    row = await _call(service.dismiss_follow_up(db, principal, follow_up_id))
    await db.commit()
    return FollowUpOut.model_validate(row)
