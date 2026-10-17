"""Request authentication and the tenant-scoped DB session dependency.

Every authenticated endpoint takes ``principal: CurrentPrincipal`` and/or
``db: TenantDB``; ``db`` is already scoped to the principal's tenant.
"""

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Annotated, Literal

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import APIKeyCookie, HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth import iap, service
from oracle.auth.models import User
from oracle.config import get_settings
from oracle.tenancy import tenant_session

_bearer = HTTPBearer(auto_error=False, description="API token for the agent track")
_cookie = APIKeyCookie(
    name=get_settings().session_cookie_name, auto_error=False, description="UI session"
)


@dataclass(frozen=True)
class Principal:
    tenant_id: uuid.UUID
    kind: Literal["user", "token"]
    user_id: uuid.UUID | None = None
    token_id: uuid.UUID | None = None

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
    except iap.KeysUnavailable:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Cannot verify the sign-in right now"
        ) from None
    user = await iap.user_for_claims(claims)
    if user is None:
        raise _unauthorized()
    return user


async def get_principal(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    cookie: Annotated[str | None, Depends(_cookie)],
) -> Principal:
    iap_user = await _iap_user(request)
    if bearer is not None:
        token = await service.resolve_api_token(bearer.credentials)
        if token is None:
            raise _unauthorized()
        return Principal(tenant_id=token.tenant_id, kind="token", token_id=token.id)
    if iap_user is not None:
        return Principal(tenant_id=iap_user.tenant_id, kind="user", user_id=iap_user.id)
    if cookie:
        ids = service.read_session_cookie(cookie)
        if ids is not None:
            user_id, tenant_id = ids
            async with tenant_session(tenant_id) as s:
                if await s.get(User, user_id) is not None:
                    return Principal(tenant_id=tenant_id, kind="user", user_id=user_id)
    raise _unauthorized()


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]


async def get_db(principal: CurrentPrincipal) -> AsyncIterator[AsyncSession]:
    async with tenant_session(principal.tenant_id) as session:
        yield session


TenantDB = Annotated[AsyncSession, Depends(get_db)]
