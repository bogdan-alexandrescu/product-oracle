"""Members, invites and API tokens. Owners only, except invites and access requests
(:data:`invites_router`: approvers too, A5); the member directory
(``GET /v1/people``, :data:`people_router`) is every member's.

Logic lives in :mod:`oracle.members.service`; each handler commits once.
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select

from oracle import audit
from oracle.auth.deps import Principal, TenantDB, same_origin
from oracle.auth.models import Role, User
from oracle.authz import has_role, not_for_runs, require_role
from oracle.config import get_settings
from oracle.connections.router import ProviderHttp
from oracle.members import access, delivery, handover, impact, service, tokens
from oracle.members.names import display_name
from oracle.members.schemas import (
    AccessApprove,
    AccessRequestOut,
    ApiTokenOut,
    FollowUpOut,
    HandOverIn,
    HandOverOut,
    ImpactOut,
    InviteCreate,
    InviteOut,
    InviteStatus,
    MemberDetailOut,
    MemberOut,
    MemberPatch,
    PersonOut,
    SignInDomain,
    SignInRulesOut,
    TokenApprovalOut,
    TokenKind,
)

router = APIRouter(
    prefix="/v1",
    tags=["members"],
    dependencies=[Depends(not_for_runs), Depends(require_role("owner"))],
)
Owner = Annotated[Principal, Depends(require_role("owner"))]
# A5: invites and access requests, for owners and approvers (viewer and commenter roles
# only for approvers: oracle.members.access.invite_roles).
invites_router = APIRouter(
    prefix="/v1",
    tags=["members"],
    dependencies=[Depends(not_for_runs), Depends(require_role("approver"))],
)
Approver = Annotated[Principal, Depends(require_role("approver"))]
# The member directory: every person picker a non-owner uses reads it (C2).
people_router = APIRouter(prefix="/v1", tags=["members"])
Viewer = Annotated[Principal, Depends(require_role("viewer"))]

_STATUS = {
    "not_found": status.HTTP_404_NOT_FOUND,
    "conflict": status.HTTP_409_CONFLICT,
    # The caller is no longer an owner, or their token or grant was revoked, by a change
    # that committed while their request waited (re-read under the gate).
    "forbidden": status.HTTP_403_FORBIDDEN,
    # An invite to a reserved example domain outside the mock/test build.
    # or to an address outside the domains that can sign in (ORACLE_IAP_ALLOWED_DOMAINS).
    "invalid": status.HTTP_422_UNPROCESSABLE_CONTENT,
}


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except service.MemberError as e:
        detail = e.detail if e.detail is not None else e.message
        raise HTTPException(_STATUS[e.kind], detail) from e


@router.get("/members", response_model=list[MemberOut])
async def list_members(db: TenantDB) -> list[MemberOut]:
    """The users of this company's Oracle, their roles, and whether each is active or
    disabled (a removed member: kept so history keeps their name), their last sign-in
    when known, and how many credentials still act for them."""
    return await service.members_out(db, await service.list_members(db))


@router.patch(
    "/members/{user_id}",
    response_model=MemberOut,
    responses={
        409: {"description": "Would demote the last owner"},
        422: {"description": "A hand-over target cannot hold it (hand_over_target)"},
    },
)
async def update_member(
    user_id: uuid.UUID, body: MemberPatch, principal: Owner, db: TenantDB
) -> MemberOut:
    """Change a member's role, name them engineering lead or clear it (A3), or both in
    one change, role first. A viewer is never the engineering lead: naming one is a 422,
    and a demotion to viewer clears the flag. Clearing it returns the engineering-stop
    decisions they gave that are not delivered yet to the Inbox."""
    name = body.name if "name" in body.model_fields_set else ...
    moves = [m.model_dump() for m in body.hand_over or []]
    user = await _call(
        service.update_member(
            db, principal, user_id, body.role, body.engineering_lead, name, hand_over=moves
        )
    )
    await db.commit()
    return (await service.members_out(db, [user]))[0]


@router.post(
    "/members/{user_id}/disable",
    response_model=MemberOut,
    dependencies=[Depends(same_origin)],
    responses={404: {"description": "No such member"}, 409: {"description": "The last owner"}},
)
async def disable_member(
    user_id: uuid.UUID,
    principal: Owner,
    db: TenantDB,
    http: ProviderHttp,
    body: HandOverIn | None = None,
) -> MemberOut:
    """Remove a member by disabling them: sign-in is refused on every path; their
    connections are disconnected (revoked at the provider) and their sources recorded
    as revoked, so documents citing them cannot publish; their API tokens and OAuth
    grants are revoked, their runs cancelled, the open invite for their email revoked;
    their approvals lapse for good; every session they signed is ended. The calls at
    the providers and the runtime are made after the disable commits, outside the
    review gate, and retried by the tick when they fail. Their Google IAP access is
    taken away, and that of the invites revoked with them (audited). The member stays
    in the list (history keeps the name); an owner can restore them, and they sign in
    fresh. A no-op for a disabled member. With ``hand_over`` (A5), those
    responsibilities move first, in the same transaction; a refused target is a 422
    (``hand_over_target``) and nothing is moved or removed."""
    moves = [m.model_dump() for m in body.hand_over or []] if body is not None else None
    user = await _call(service.disable_member(db, principal, user_id, hand_over=moves))
    await db.commit()
    # The provider and runtime calls it owes, outside the review gate (retried by the tick).
    await service.after_disable(db, principal, user.id, http)
    await delivery.release_disabled(db, principal, user)
    await db.refresh(user)
    return (await service.members_out(db, [user]))[0]


@router.post(
    "/members/{user_id}/restore",
    response_model=MemberOut,
    responses={404: {"description": "No such member"}},
)
async def restore_member(user_id: uuid.UUID, principal: Owner, db: TenantDB) -> MemberOut:
    """Let a disabled member sign in again, with their role. Their approvals stay
    lapsed, their tokens revoked and their connections gone: nothing else comes back.
    Their Google IAP access is granted again (audited)."""
    user = await _call(service.restore_member(db, principal, user_id))
    await db.commit()
    await delivery.grant_member_access(db, principal, user)
    await db.refresh(user)
    return (await service.members_out(db, [user]))[0]


@router.get(
    "/members/{user_id}",
    response_model=MemberDetailOut,
    operation_id="get_member",
    responses={404: {"description": "No such member"}},
)
async def get_member(user_id: uuid.UUID, db: TenantDB) -> MemberDetailOut:
    """One member: how they joined (``joined.via``: invite, access_request, domain,
    seeded or unknown), the responsibilities they hold (open items only) and the
    approvals and decisions a removal would lapse or void."""
    return MemberDetailOut.model_validate(await _call(impact.member_detail(db, user_id)))


@router.get(
    "/members/{user_id}/impact",
    response_model=ImpactOut,
    operation_id="get_member_impact",
    responses={404: {"description": "No such member"}},
)
async def get_member_impact(
    user_id: uuid.UUID,
    db: TenantDB,
    change: Literal["remove", "role"],
    role: Annotated[Role | None, Query()] = None,
) -> ImpactOut:
    """What removing the member (``change=remove``) or changing their role
    (``change=role&role=commenter``) would end, void and lapse, and the responsibilities
    they hold (``holder_ok``: whether they may keep each after the change). Reads only:
    the same selections the change applies, no locks, no writes. ``nothing`` is true
    when the change touches nothing (a promotion, their own role, a removed member)."""
    return ImpactOut.model_validate(
        await _call(impact.member_impact(db, user_id, change, role))  # type: ignore[arg-type]
    )


@router.get(
    "/members/{user_id}/approvals",
    response_model=list[TokenApprovalOut],
    operation_id="list_member_approvals",
    responses={404: {"description": "No such member"}},
)
async def list_member_approvals(
    user_id: uuid.UUID, db: TenantDB, lapsed: bool = False
) -> list[TokenApprovalOut]:
    """The member's section verdicts and version approvals, given in person or through
    their API tokens and grants, oldest first; ``lapsed=true`` includes lapsed ones."""
    rows = await _call(service.member_approvals(db, user_id, lapsed=lapsed))
    return [TokenApprovalOut.model_validate(r) for r in rows]


@router.post(
    "/members/{user_id}/hand-over",
    response_model=HandOverOut,
    operation_id="hand_over",
    responses={
        404: {"description": "No such member"},
        422: {"description": "An unknown kind, or a target that cannot hold it"},
    },
)
async def hand_over(
    user_id: uuid.UUID, body: HandOverIn, principal: Owner, db: TenantDB
) -> HandOverOut:
    """Move an active or removed member's responsibilities to other members (``to``)
    or clear them (``to`` null), all or none; kinds left out stay. Returns what they
    still hold."""
    moves = [m.model_dump() for m in body.hand_over or []]
    await _call(handover.hand_over(db, principal, user_id, moves))
    await db.commit()
    return HandOverOut.model_validate({"responsibilities": await handover.remaining(db, user_id)})


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
    await delivery.release_disabled(db, principal, user)


@router.get("/api-tokens", response_model=list[ApiTokenOut])
async def list_api_tokens(
    db: TenantDB,
    kind: Annotated[TokenKind | None, Query(description="Only this kind")] = None,
    user_id: Annotated[
        uuid.UUID | None, Query(description="Only those acting for this member")
    ] = None,
) -> list[ApiTokenOut]:
    """Every credential of this company (never the secret), revoked ones included,
    oldest first: personal and service API tokens, run tokens and MCP clients' OAuth
    grants, each with its kind, the member it acts for, its scopes and when it was
    created, last used, revoked and (run tokens, grants) expires."""
    return await tokens.list_tokens(db, kind=kind, user_id=user_id)


@router.delete(
    "/api-tokens/{token_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={404: {"description": "No such token"}},
)
async def revoke_api_token(token_id: uuid.UUID, principal: Owner, db: TenantDB) -> None:
    """Revoke a credential of any kind by its id: an API token, a run token or an MCP
    client's grant (its access and refresh tokens). The approvals given through an API
    token or a grant lapse for good (section verdicts and version approvals); its
    member's own approvals stand, as do spend approvals and checkpoint decisions (C2: a
    token revoke voids neither). A revoked run token ends its agents' access; the run
    goes on. Revoking twice is a no-op."""
    await _call(service.revoke_any_token(db, principal, token_id))
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


@invites_router.get("/invites", response_model=list[InviteOut])
async def list_invites(
    principal: Approver, db: TenantDB, status: InviteStatus | Literal["all"] = "open"
) -> list[InviteOut]:
    """Invites, newest first: open ones (expired included, as both still need an action)
    unless ``status`` asks for others (or ``all``). Owners see every invite, approvers the
    ones they sent."""
    return await service.invites_out(db, await service.list_invites(db, status, principal))


@invites_router.post(
    "/invites",
    response_model=InviteOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        403: {"description": "A role the caller may not invite with"},
        409: {"description": "Already a member, or an open or expired invite exists"},
        422: {"description": "Outside the company's email domains (outside_company_domains)"},
    },
)
async def create_invite(body: InviteCreate, principal: Approver, db: TenantDB) -> InviteOut:
    """Pre-assign a role (and a name) to an email: its first Google sign-in lands with
    that role, and as an engineering lead when ``engineering_lead`` (never with role
    viewer: 422). Owners invite with any role; approvers viewers and commenters (A5).
    The invite expires in 14 days (``expires_at``; Resend gives 14 more).

    The invitee is granted Google IAP access on Oracle's backend services
    (``access``: ``granted``; ``skipped`` with no backends configured; ``pending`` with
    ``access_error`` when the grant failed: the invite is kept, and
    ``POST /v1/invites/{invite_id}/access`` retries it). Oracle emails them the sign-in
    link in the background (``email_status``: ``queued``, then ``sent`` or ``failed``;
    ``not_sent`` with no sender configured: send them ``sign_in_url``). With Google
    sign-in on, refused (422) for an address outside the company's email domains."""
    invite = await _call(
        service.create_invite(
            db, principal, body.email, body.role, body.engineering_lead, body.name, body.message
        )
    )
    send = delivery.queue_email(invite)
    await db.commit()
    await delivery.grant_invite_access(db, principal, invite)
    if send:
        delivery.schedule(principal.tenant_id, invite.id)
    await db.refresh(invite)
    return (await service.invites_out(db, [invite]))[0]


@invites_router.post(
    "/invites/{invite_id}/resend",
    response_model=InviteOut,
    responses={404: {"description": "No such invite"}, 409: {"description": "Accepted or revoked"}},
    dependencies=[Depends(same_origin)],
)
async def resend_invite(invite_id: uuid.UUID, principal: Approver, db: TenantDB) -> InviteOut:
    """Give an open or expired invite 14 more days from now (A5): ``expires_at``,
    ``resent_at`` and ``resend_count``; audited ``invite.resend``. Its email goes out
    again when a sender is configured and its last one is over a minute old. Approvers
    resend only the invites they sent."""
    invite = await _call(service.resend_invite(db, principal, invite_id))
    send = (
        invite.email_status != "queued"
        and not delivery.resend_wait(invite)
        and delivery.queue_email(invite)
    )
    await db.commit()
    if send:
        delivery.schedule(principal.tenant_id, invite.id)
    await db.refresh(invite)
    return (await service.invites_out(db, [invite]))[0]


@router.post(
    "/invites/{invite_id}/access",
    response_model=InviteOut,
    responses={
        403: {"description": "No longer an owner"},
        404: {"description": "No such invite"},
        409: {"description": "Not open"},
    },
    dependencies=[Depends(same_origin)],
)
async def retry_invite_access(invite_id: uuid.UUID, principal: Owner, db: TenantDB) -> InviteOut:
    """Grant an open invite's Google IAP access again (Retry on "Access not granted
    yet"). Each attempt is audited; ``access`` says how it went."""
    invite = await _call(service.get_open_invite(db, principal, invite_id))
    await delivery.grant_invite_access(db, principal, invite)
    await db.refresh(invite)
    return (await service.invites_out(db, [invite]))[0]


@router.post(
    "/invites/{invite_id}/email",
    response_model=InviteOut,
    responses={
        403: {"description": "No longer an owner"},
        404: {"description": "No such invite"},
        409: {"description": "Not open, or its email is being sent"},
        429: {"description": "Its email went out under a minute ago (Retry-After: seconds)"},
    },
    dependencies=[Depends(same_origin)],
)
async def resend_invite_email(invite_id: uuid.UUID, principal: Owner, db: TenantDB) -> InviteOut:
    """Email an open invite again (Resend): queued and sent in the background
    (``email_status``), or ``not_sent`` with no sender configured. Refused (429) under
    a minute after its last send."""
    invite = await _call(service.get_open_invite(db, principal, invite_id))
    if invite.email_status == "queued":
        raise HTTPException(status.HTTP_409_CONFLICT, "Oracle is sending this invite's email")
    wait = delivery.resend_wait(invite)
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Oracle emailed this invite under a minute ago; resend it in {wait} seconds",
            headers={"Retry-After": str(wait)},
        )
    send = delivery.queue_email(invite)
    await audit.record(
        db, principal, "invite_email.resend", "invite", invite.id, {"email": invite.email}
    )
    await db.commit()
    if send:
        delivery.schedule(principal.tenant_id, invite.id)
    await db.refresh(invite)
    return (await service.invites_out(db, [invite]))[0]


@invites_router.delete("/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(invite_id: uuid.UUID, principal: Approver, db: TenantDB) -> None:
    """Revoke an open invite (approvers: one they sent). Revoking twice is a no-op; an
    accepted invite is a 409.
    The invitee's Google IAP access is taken away, unless they are an active member or
    have another open invite (audited)."""
    invite = await _call(service.revoke_invite(db, principal, invite_id))
    targets = {invite.email: invite.id}
    await db.commit()
    await delivery.release_access(db, principal, targets, "invite_access.remove")


# --- Follow-ups a disable owes (Inbox: Retry, Dismiss) ------------------------------------


@router.post(
    "/member-follow-ups/{follow_up_id}/retry",
    response_model=FollowUpOut,
    responses={404: {"description": "No such follow-up"}, 409: {"description": "Not open"}},
    dependencies=[Depends(same_origin)],
)
async def retry_member_follow_up(
    follow_up_id: uuid.UUID, principal: Owner, db: TenantDB, http: ProviderHttp
) -> FollowUpOut:
    """Make a provider revoke (or runtime cancel) a disable still owes now, or a change
    to someone's Google IAP access that keeps failing (under the address's lock, checked
    first: no longer needed is done), whatever its backoff or its 24 hours of retries.
    Audited. A success drops Oracle's copy of the credential."""
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


@people_router.get("/people", response_model=list[PersonOut])
async def list_people(
    principal: Viewer,
    db: TenantDB,
    q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 20,
    ids: Annotated[list[uuid.UUID] | None, Query(max_length=100)] = None,
) -> list[PersonOut]:
    """The company's active members for a person picker, matched on email (``q``):
    each one's name (from their email), email, role and whether they can write
    (commenter or above: answer, comment, be asked). Disabled members are not listed;
    the full member list (``GET /v1/members``) stays the owner's.

    ``ids`` names people instead ("Waiting on <name>", "Answered by <name>"): the
    company's members with those ids, however many the company has, a disabled one too
    (it keeps its name and cannot write); ``q`` and ``limit`` do not apply."""
    if ids:
        stmt = select(User).where(User.id.in_(ids))
    else:
        stmt = select(User).where(User.disabled_at.is_(None))
        if q and q.strip():
            needle = q.strip().lower()
            stmt = stmt.where(
                func.lower(User.email).contains(needle, autoescape=True)
                | func.lower(func.coalesce(User.name, "")).contains(needle, autoescape=True)
            )
        stmt = stmt.limit(limit)
    rows = (await db.scalars(stmt.order_by(User.email))).all()
    return [
        PersonOut(
            user_id=u.id, name=display_name(u.email, u.name), email=u.email, role=u.role,  # type: ignore[arg-type]
            can_write=u.disabled_at is None and has_role(u.role, "commenter"),
        )
        for u in rows
    ]  # fmt: skip


# --- Access requests and sign-in rules (A5) ---------------------------------------------

_ACCESS_STATUS = {**_STATUS}


async def _access[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except access.AccessError as e:
        raise HTTPException(_ACCESS_STATUS[e.kind], e.message) from e


def _request_out(row) -> AccessRequestOut:
    return AccessRequestOut.model_validate(row)


@invites_router.get("/access-requests", response_model=list[AccessRequestOut])
async def list_access_requests(
    principal: Approver,
    db: TenantDB,
    status: Literal["pending", "approved", "declined", "closed", "all"] = "pending",
) -> list[AccessRequestOut]:
    """People from the company's email domains who signed in with Google without an
    invite (rule ``request``), newest first: pending ones unless ``status`` asks for
    others."""
    if not access.invite_roles(principal):
        raise HTTPException(403, "Requires the approver role")
    return [_request_out(r) for r in await access.list_requests(db, status)]


@invites_router.post(
    "/access-requests/{request_id}/approve",
    response_model=AccessRequestOut,
    responses={
        403: {"description": "A role the caller may not approve with"},
        404: {"description": "No such request"},
        409: {"description": "Not pending, or already a member"},
    },
)
async def approve_access_request(
    request_id: uuid.UUID, body: AccessApprove, principal: Approver, db: TenantDB
) -> AccessRequestOut:
    """Let them in with ``role`` (and a ``name``): an open invite is made for their email
    (14 days), so their next page load signs them in. Owners approve with any role,
    approvers as viewer or commenter. Audited."""
    try:
        row = await access.approve(db, principal, request_id, body.role, body.name)
    except access.AccessError as e:
        if e.kind == "conflict":
            await db.commit()  # a request whose email became a member is closed
        raise HTTPException(_ACCESS_STATUS[e.kind], e.message) from e
    await db.commit()
    return _request_out(row)


@invites_router.post(
    "/access-requests/{request_id}/decline",
    response_model=AccessRequestOut,
    responses={404: {"description": "No such request"}, 409: {"description": "Not pending"}},
    dependencies=[Depends(same_origin)],
)
async def decline_access_request(
    request_id: uuid.UUID, principal: Approver, db: TenantDB
) -> AccessRequestOut:
    """Turn the request down: later sign-ins stay refused (an invite still lets them in)."""
    row = await _access(access.decline(db, principal, request_id))
    await db.commit()
    return _request_out(row)


@invites_router.post(
    "/access-requests/{request_id}/reopen",
    response_model=AccessRequestOut,
    responses={
        403: {"description": "An approval another person gave (approvers)"},
        404: {"description": "No such request"},
        409: {"description": "Cannot reopen"},
    },
    dependencies=[Depends(same_origin)],
)
async def reopen_access_request(
    request_id: uuid.UUID, principal: Approver, db: TenantDB
) -> AccessRequestOut:
    """Undo: a declined request, or an approved one whose invite is not claimed yet (the
    invite is revoked), is pending again. Approvers undo only the approvals they gave:
    they revoke only the invites they sent."""
    row = await _access(access.reopen(db, principal, request_id))
    await db.commit()
    return _request_out(row)


@router.get("/sign-in-rules", response_model=SignInRulesOut)
async def get_sign_in_rules(db: TenantDB) -> SignInRulesOut:
    """Who becomes a member through Google sign-in: whether it is on, whether new
    sign-ins are off where Oracle is deployed, the company's email domains and where
    each is set, the rule for people without an invite and the default role. Change
    them with ``PUT /v1/settings/{key}`` (``sign_in_without_invite``,
    ``iap_default_role``, ``company_email_domains``)."""
    from oracle.tenant_settings_api import get_setting

    settings = get_settings()
    return SignInRulesOut(
        google_sign_in=bool(settings.iap_audiences),
        new_sign_ins_off=not settings.iap_auto_provision,
        domains=[SignInDomain(domain=d, source=f) for d, f in await access.domain_sources(db)],
        without_invite=await access.sign_in_rule(db),
        default_role=await get_setting(db, "iap_default_role"),
    )
