from fastapi import APIRouter, HTTPException, Response, status

from oracle.audit import record
from oracle.auth import service
from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.auth.models import ApiToken, User
from oracle.auth.schemas import LoginRequest, Me
from oracle.config import get_settings
from oracle.tenancy import tenant_session

router = APIRouter(prefix="/v1", tags=["auth"])


@router.post("/auth/login", response_model=Me)
async def login(body: LoginRequest, response: Response) -> Me:
    user = await service.authenticate_user(body.email, body.password)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    settings = get_settings()
    response.set_cookie(
        settings.session_cookie_name,
        service.make_session_cookie(user),
        max_age=settings.session_max_age_seconds,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )
    async with tenant_session(user.tenant_id) as s:
        principal = Principal(
            tenant_id=user.tenant_id, kind="user", role=user.role, user_id=user.id
        )
        await record(s, principal, "login", "user", user.id)
        await s.commit()
    return Me(
        kind="user", tenant_id=user.tenant_id, role=user.role, user_id=user.id, email=user.email
    )


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
            token_id=token.id if token else None,
            token_name=token.name if token else None,
        )
    token = await db.get(ApiToken, principal.token_id)
    return Me(
        kind="token",
        tenant_id=principal.tenant_id,
        role=principal.role,
        token_id=token.id,
        token_name=token.name,
    )
