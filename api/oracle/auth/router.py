from fastapi import APIRouter, HTTPException, Response, status

from oracle.auth import service
from oracle.auth.deps import CurrentPrincipal, TenantDB
from oracle.auth.models import ApiToken, User
from oracle.auth.schemas import LoginRequest, Me
from oracle.config import get_settings
from oracle.tenant_settings_api import company_timezone

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
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> None:
    # The cookie is stateless and signed; logout drops it from the browser.
    response.delete_cookie(get_settings().session_cookie_name, path="/")


@router.get("/me", response_model=Me)
async def me(principal: CurrentPrincipal, db: TenantDB) -> Me:
    zone = (await company_timezone(db)).key
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
            company_timezone=zone,
        )
    token = await db.get(ApiToken, principal.token_id)
    return Me(
        kind="token",
        tenant_id=principal.tenant_id,
        role=principal.role,
        token_id=token.id,
        token_name=token.name,
        company_timezone=zone,
    )
