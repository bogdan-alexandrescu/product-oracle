"""Request authentication and the tenant-scoped DB session dependency.

Every authenticated endpoint takes ``principal: CurrentPrincipal`` and/or
``db: TenantDB``; ``db`` is already scoped to the principal's tenant.
"""

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace
from typing import Annotated, Literal

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import APIKeyCookie, HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth import iap, service
from oracle.auth.jwks import KeysUnavailable
from oracle.auth.models import Role, User
from oracle.config import get_settings
from oracle.tenancy import tenant_session

# Set by Oracle's MCP server on the in-process REST call a run token makes (it acts for
# the run's creator). It only ever narrows what the caller sees (S6: a run token is
# never the author of a finding), so a client sending it itself gains nothing.
RUN_HEADER = "x-oracle-run-id"

_bearer = HTTPBearer(auto_error=False, description="API token for the agent track")
_cookie = APIKeyCookie(
    name=get_settings().session_cookie_name, auto_error=False, description="UI session"
)


@dataclass(frozen=True)
class Principal:
    tenant_id: uuid.UUID
    kind: Literal["user", "token"]
    # The user's role, or the API token's role. Checked by oracle.authz.require_role.
    role: Role
    user_id: uuid.UUID | None = None
    token_id: uuid.UUID | None = None
    # The run whose token made this call (through MCP), else None.
    run_id: uuid.UUID | None = None

    @property
    def is_run(self) -> bool:
        return self.run_id is not None

    @property
    def id(self) -> uuid.UUID:
        """User or token id: what goes into imported_by / author_id / reviewer_id."""
        return self.user_id if self.kind == "user" else self.token_id  # type: ignore[return-value]

    @property
    def actor(self) -> str:
        """Audit actor string, e.g. ``user:<uuid>``."""
        return f"{self.kind}:{self.id}"


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _iap_user(request: Request) -> User | None:
    """The IAP-signed-in user, ``None`` without an assertion or with IAP SSO off.

    A present but invalid assertion, or a valid one for a user who may not sign in,
    is a 401 even if another credential is sent.
    """
    audiences = get_settings().iap_audiences
    assertion = request.headers.get(iap.ASSERTION_HEADER)
    if not audiences or not assertion:
        return None
    try:
        claims = await iap.verify_assertion(assertion, audiences)
    except iap.InvalidAssertion:
        raise _unauthorized() from None
    except KeysUnavailable:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Cannot verify the sign-in right now"
        ) from None
    user = await iap.user_for_claims(claims)
    if user is None:
        raise _unauthorized()
    return user


async def _bearer_principal(raw: str) -> Principal:
    """An API token, or an MCP client's OAuth access token (role capped by its scope)."""
    from oracle.mcp.oauth.service import ACCESS_PREFIX

    if raw.startswith(ACCESS_PREFIX):
        from oracle.mcp.oauth.verify import verify_access_token

        principal = await verify_access_token(raw)
        if principal is None:
            raise _unauthorized()
        return principal
    token = await service.resolve_api_token(raw)
    if token is None:
        raise _unauthorized()
    if token.user_id is not None:
        # A token for a user acts as that user: the user's role and own data.
        async with tenant_session(token.tenant_id) as s:
            user = await s.get(User, token.user_id)
        if user is None:
            raise _unauthorized()
        return Principal(
            tenant_id=token.tenant_id,
            kind="user",
            role=user.role,
            user_id=user.id,
            token_id=token.id,
        )
    return Principal(tenant_id=token.tenant_id, kind="token", role=token.role, token_id=token.id)


def _run_of(request: Request) -> uuid.UUID | None:
    raw = request.headers.get(RUN_HEADER)
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Bad {RUN_HEADER}") from None


async def get_principal(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    cookie: Annotated[str | None, Depends(_cookie)],
) -> Principal:
    principal = await _authenticate(request, bearer, cookie)
    run_id = _run_of(request)
    return replace(principal, run_id=run_id) if run_id is not None else principal


async def _authenticate(
    request: Request,
    bearer: HTTPAuthorizationCredentials | None,
    cookie: str | None,
) -> Principal:
    iap_user = await _iap_user(request)
    if bearer is not None:
        return await _bearer_principal(bearer.credentials)
    if iap_user is not None:
        return Principal(
            tenant_id=iap_user.tenant_id, kind="user", role=iap_user.role, user_id=iap_user.id
        )
    if cookie:
        ids = service.read_session_cookie(cookie)
        if ids is not None:
            user_id, tenant_id = ids
            async with tenant_session(tenant_id) as s:
                user = await s.get(User, user_id)
                if user is not None:
                    return Principal(
                        tenant_id=tenant_id, kind="user", role=user.role, user_id=user_id
                    )
    raise _unauthorized()


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]


async def get_db(principal: CurrentPrincipal) -> AsyncIterator[AsyncSession]:
    async with tenant_session(principal.tenant_id) as session:
        yield session


TenantDB = Annotated[AsyncSession, Depends(get_db)]
