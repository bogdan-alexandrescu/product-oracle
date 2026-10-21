"""``/v1/me/...``: My account, for every signed-in member (any role).

Each route acts on the caller's own account only. A credential that acts for no member
(a service API token) has no account, and a run's agents never manage one: both are
refused here, and run tokens never see these operations as MCP tools
(oracle.mcp.scopes). Logic lives in :mod:`oracle.account.service`.
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from oracle.account import service
from oracle.account.schemas import (
    McpClientOut,
    MyAccountOut,
    PasswordChange,
    PersonalTokenCreate,
    PersonalTokenCreated,
    SignedOutEverywhere,
)
from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB, same_origin
from oracle.auth.models import User
from oracle.auth.service import make_session_cookie
from oracle.authz import not_for_runs
from oracle.config import get_settings
from oracle.members import tokens
from oracle.members.schemas import ApiTokenOut
from oracle.members.service import MemberError


async def _member(principal: CurrentPrincipal) -> Principal:
    if principal.user_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This credential acts for no member, so it has no account; use a member's sign-in",
        )
    return principal


Member = Annotated[Principal, Depends(_member)]
router = APIRouter(
    prefix="/v1/me", tags=["account"], dependencies=[Depends(not_for_runs), Depends(_member)]
)

_STATUS = {
    "not_found": status.HTTP_404_NOT_FOUND,
    "conflict": status.HTTP_409_CONFLICT,
    "forbidden": status.HTTP_403_FORBIDDEN,
    "invalid_password": status.HTTP_400_BAD_REQUEST,
}


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except MemberError as e:
        raise HTTPException(_STATUS[e.kind], e.message) from e
    except service.RateLimited as e:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            str(e),
            headers={"Retry-After": str(e.retry_after)},
        ) from e


@router.get("/account", response_model=MyAccountOut)
async def get_my_account(principal: Member, db: TenantDB) -> MyAccountOut:
    """Your email, role, when you last signed in and how you sign in: with a password,
    with Google (when this deployment signs in through Google), or both."""
    user = await db.get(User, principal.user_id)
    methods = ["password"] if user.password_sign_in else []
    if get_settings().iap_audiences:
        methods.append("google")
    via = "mcp_client" if principal.grant_id else "api_token" if principal.token_id else "browser"
    return MyAccountOut(
        user_id=user.id,
        email=user.email,
        role=principal.role,
        created_at=user.created_at,
        last_sign_in_at=user.last_sign_in_at,
        sign_in_methods=methods,
        signed_in_via=via,
    )


@router.post(
    "/password",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(same_origin)],
    responses={
        400: {"description": "The current password is not correct, or the new one is it"},
        403: {
            "description": "Not from the signed-in browser (a token, an MCP client or another site)"
        },
        409: {"description": "You sign in with Google only: no password to change"},
        429: {"description": "Too many wrong attempts; see Retry-After"},
    },
)
async def change_password(
    body: PasswordChange, principal: Member, db: TenantDB, request: Request, response: Response
) -> None:
    """Change your password (the current one, then a new, different one of at least
    ``password_min_length`` characters), from the signed-in browser only (a token or an
    MCP client is refused). Every other session ends and this browser gets a fresh one;
    your personal API tokens, the MCP clients you authorized (and their unexchanged
    authorization codes) and the current run tokens of your runs still going are revoked
    (those runs keep running; their next segment is given a new run token). Five wrong
    current passwords in 15 minutes lock changes for the rest of the window."""
    user, _ = await _call(
        service.change_password(db, principal, body.current_password, body.new_password)
    )
    await db.commit()
    settings = get_settings()
    if request.cookies.get(settings.session_cookie_name) and principal.token_id is None:
        response.set_cookie(
            settings.session_cookie_name,
            make_session_cookie(user),
            max_age=settings.session_max_age_seconds,
            httponly=True,
            samesite="lax",
            secure=settings.cookie_secure,
            path="/",
        )


@router.post(
    "/sign-out-everywhere",
    response_model=SignedOutEverywhere,
    dependencies=[Depends(same_origin)],
    responses={403: {"description": "Not from the signed-in browser"}},
)
async def sign_out_everywhere(
    principal: Member, db: TenantDB, response: Response
) -> SignedOutEverywhere:
    """Sign out of every device, from the signed-in browser only: every session you
    signed in with ends, this one too; your personal API tokens, every MCP client you
    authorized (access and refresh tokens, and authorization codes not yet exchanged)
    and the current run tokens of the runs you started that are still going are
    revoked. Sign-out ends today's tokens and grants, not the runs: a run started
    earlier keeps running, and its next segment is given a new run token. With Google
    sign-in, Google signs the browser in again on its next visit."""
    at, revoked = await _call(service.sign_out_everywhere(db, principal))
    await db.commit()
    response.delete_cookie(get_settings().session_cookie_name, path="/")
    return SignedOutEverywhere(
        sessions_valid_after=at,
        mcp_clients_revoked=len(revoked["mcp_grants"]),
        api_tokens_revoked=len(revoked["api_tokens"]),
        runs_tokens_revoked=len(revoked["run_token_runs"]),
    )


@router.get("/tokens", response_model=list[ApiTokenOut])
async def list_my_tokens(principal: Member, db: TenantDB) -> list[ApiTokenOut]:
    """Your personal API tokens, revoked ones included (never a secret)."""
    return await service.my_tokens(db, principal)


@router.post(
    "/tokens",
    response_model=PersonalTokenCreated,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(same_origin)],
    responses={
        403: {
            "description": "Not from the signed-in browser (a token, an MCP client or another site)"
        }
    },
)
async def create_personal_token(
    body: PersonalTokenCreate, principal: Member, db: TenantDB
) -> PersonalTokenCreated:
    """Create a personal API token that acts as you, from the signed-in browser only (a
    token or an MCP client never mints one). ``oracle:read`` alone acts as a viewer;
    with ``oracle:write`` it has your role. It expires after ``expires_in_days`` (30, 90
    or 365; null: never), then is listed as expired and refused. The secret is in this
    answer only: copy it now, only its hash is kept."""
    token, raw = await _call(
        service.create_personal_token(db, principal, body.name, body.scopes, body.expires_in_days)
    )
    await db.commit()
    user = await db.get(User, principal.user_id)
    return PersonalTokenCreated(token=tokens.api_token_out(token, user), secret=raw)


@router.delete(
    "/tokens/{token_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        403: {"description": "A read-only credential changes nothing"},
        404: {"description": "Not one of your tokens"},
    },
)
async def revoke_my_token(token_id: uuid.UUID, principal: Member, db: TenantDB) -> None:
    """Revoke one of your personal API tokens. The approvals given through it lapse for
    good; yours given in person stand. Twice is a no-op."""
    await _call(service.revoke_my_token(db, principal, token_id))
    await db.commit()


@router.get("/oauth-clients", response_model=list[McpClientOut])
async def list_my_oauth_clients(principal: Member, db: TenantDB) -> list[McpClientOut]:
    """The MCP clients you authorized (one row per authorization), revoked ones
    included."""
    return [
        McpClientOut(
            id=g.id,
            client_id=g.client_id,
            client_name=g.client_name,
            scopes=tokens.scopes_of(g.scope),
            authorized_at=g.authorized_at,
            last_used_at=g.last_used_at,
            expires_at=g.expires_at,
            revoked_at=g.revoked_at,
        )
        for g in await service.my_grants(db, principal)
    ]


@router.delete(
    "/oauth-clients/{grant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        403: {"description": "A read-only credential changes nothing"},
        404: {"description": "Not one of your MCP clients"},
    },
)
async def revoke_my_oauth_client(grant_id: uuid.UUID, principal: Member, db: TenantDB) -> None:
    """Revoke an MCP client you authorized: its access and refresh tokens stop working
    and the approvals made through it lapse. Twice is a no-op."""
    await _call(service.revoke_my_grant(db, principal, grant_id))
    await db.commit()
