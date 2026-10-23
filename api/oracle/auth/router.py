from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select

from oracle.auth import iap, service
from oracle.auth.deps import CurrentPrincipal, TenantDB, iap_claims, same_origin
from oracle.auth.models import ApiToken, User
from oracle.auth.schemas import AccessNote, AccessStateOut, LoginRequest, Me
from oracle.config import get_settings
from oracle.members import access
from oracle.tenancy import tenant_session

router = APIRouter(prefix="/v1", tags=["auth"])


@router.post("/auth/login", response_model=Me)
async def login(body: LoginRequest, response: Response) -> Me:
    signed_in = await service.sign_in(body.email, body.password)
    if signed_in is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    user, cookie = signed_in
    settings = get_settings()
    response.set_cookie(
        settings.session_cookie_name,
        cookie,
        max_age=settings.session_max_age_seconds,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )
    return Me(
        kind="user",
        tenant_id=user.tenant_id,
        role=user.role,
        user_id=user.id,
        email=user.email,
        engineering_lead=user.engineering_lead,
        name=user.name,
        invite_roles=list(access.roles_for(user.role)),
    )


@router.get("/auth/access", response_model=AccessStateOut)
async def get_access_state(request: Request) -> AccessStateOut:
    """Where the Google-signed person stands (A5), read from the Google sign-in alone (no
    member needed) and creating nothing: ``member``, ``pending`` (an owner has not
    decided their access request yet), ``approved`` (the next page load signs them in),
    ``declined``, ``invite_expired``, ``invite_only``, ``outside_domains``, ``removed``;
    ``no_google_sign_in`` without Google sign-in. Browser only: not an MCP tool."""
    claims = await iap_claims(request)
    if claims is None:
        return AccessStateOut(state="no_google_sign_in")
    state, company, details = await iap.access_state(claims)
    return AccessStateOut(
        state=state, email=claims["email"].strip().lower(), company=company, **details
    )


@router.post(
    "/auth/access/note",
    response_model=AccessStateOut,
    dependencies=[Depends(same_origin)],
    responses={409: {"description": "No pending access request"}},
)
async def send_access_note(body: AccessNote, request: Request) -> AccessStateOut:
    """Set the note an owner reads on the caller's pending access request (A5). Browser
    only: not an MCP tool."""
    claims = await iap_claims(request)
    if claims is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "You have no pending access request")
    email = claims["email"].strip().lower()
    tenant_id = await iap._default_tenant_id()
    if tenant_id is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "You have no pending access request")
    note = (body.note or "").strip() or None
    async with tenant_session(tenant_id) as s:
        try:
            row = await access.set_note(s, email, note)
        except access.AccessError as e:
            raise HTTPException(status.HTTP_409_CONFLICT, e.message) from e
        await s.commit()
        company = await s.scalar(select(iap.Tenant.name).where(iap.Tenant.id == tenant_id))
        return AccessStateOut(
            state="pending", email=email, company=company,
            requested_at=row.created_at, note=row.note,
        )  # fmt: skip


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> None:
    # The cookie is stateless and signed; logout drops it from the browser.
    response.delete_cookie(get_settings().session_cookie_name, path="/")


@router.get("/me", response_model=Me)
async def me(principal: CurrentPrincipal, db: TenantDB) -> Me:
    if principal.kind == "user":
        user = await db.get(User, principal.user_id)
        # An API token acting for this user also names itself.
        token = await db.get(ApiToken, principal.token_id) if principal.token_id else None
        return Me(
            kind="user",
            tenant_id=principal.tenant_id,
            role=principal.role,
            user_id=user.id,
            email=user.email,
            engineering_lead=user.engineering_lead,
            token_id=token.id if token else None,
            token_name=token.name if token else None,
            name=user.name,
            invite_roles=list(access.invite_roles(principal)),
        )
    token = await db.get(ApiToken, principal.token_id)
    return Me(
        kind="token",
        tenant_id=principal.tenant_id,
        role=principal.role,
        token_id=token.id,
        token_name=token.name,
        invite_roles=list(access.invite_roles(principal)),
    )
