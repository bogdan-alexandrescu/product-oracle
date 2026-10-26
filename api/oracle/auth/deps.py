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

from oracle import safe_yaml
from oracle.auth import iap, service
from oracle.auth.jwks import KeysUnavailable
from oracle.auth.models import Role, User
from oracle.config import get_settings
from oracle.tenancy import tenant_session

# Set by Oracle's MCP server on the in-process REST call a run token makes (it acts for
# the run's creator). The value is the run id signed by the server and bound to the
# acting user (oracle.auth.service.sign_run_binding). A run sees more than people do
# (S6: the full text of what a finding shared in full), so the header is trusted only
# when its signature verifies for the authenticated user; a bare, forged, expired or
# malformed one is refused with 400 (``_run_of``, fail closed), never read as the person.
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
    # The MCP OAuth grant (its refresh-token family) the call came through: approvals
    # record it, and revoking the grant voids them, as for API tokens (C2).
    grant_id: uuid.UUID | None = None
    # An MCP client approved, or a personal API token created, without oracle:write: it
    # reads as the user and changes nothing of theirs, including what the role check
    # would allow (their own sources, preferences).
    read_only: bool = False
    # The run token of a call made for a run (below): re-read under the review gate.
    run_token_id: uuid.UUID | None = None
    # The run whose token made this call (through MCP), else None. What it writes is an
    # agent's work (oracle.docs.service.import_draft holds approved text), and it reads
    # as a run (S6).
    run_id: uuid.UUID | None = None
    # #541 part 4: a run of a flow whose output every member reads (FlowDef.member_output)
    # reads as a commenter would, whoever started it (oracle.docs.visibility.restricted);
    # its role still decides what it may write.
    as_member: bool = False

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


_READ_METHODS = frozenset({"GET", "HEAD"})
READ_ONLY = (
    "This credential can only read (oracle:read): it cannot add, change or delete anything. "
    "Approve the MCP client, or create the personal API token, with oracle:write to make "
    "changes"
)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def iap_claims(request: Request) -> dict | None:
    """The verified IAP claims of the request, ``None`` without an assertion or with IAP
    SSO off; a present but invalid assertion is a 401 (``GET /v1/auth/access``)."""
    audiences = get_settings().iap_audiences
    assertion = request.headers.get(iap.ASSERTION_HEADER)
    if not audiences or not assertion:
        return None
    try:
        return await iap.verify_assertion(assertion, audiences)
    except iap.InvalidAssertion:
        raise _unauthorized() from None
    except KeysUnavailable:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Cannot verify the sign-in right now"
        ) from None


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
    if not service.may_sign_in(user):
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
        if not service.may_sign_in(user):
            raise _unauthorized()
        return Principal(
            tenant_id=token.tenant_id,
            kind="user",
            # A personal token's scope caps the user's role (oracle:read alone: viewer)
            # and, without oracle:write (an empty or unknown scope too), it changes
            # nothing, as a read-only MCP client (AC1).
            role=service.token_role(user.role, token.scope),
            user_id=user.id,
            token_id=token.id,
            read_only=service.token_read_only(token.scope),
        )
    return Principal(
        tenant_id=token.tenant_id,
        kind="token",
        role=token.role,
        token_id=token.id,
        read_only=service.token_read_only(token.scope),
    )


# The MCP server's in-process REST call for a run token carries the run creator's session
# and this header with the run token, so the REST layer knows the call is the run's.
RUN_TOKEN_HEADER = "x-oracle-run-token"


async def _for_run(principal: Principal, raw: str) -> Principal:
    """``principal`` acting for the run of the token ``raw``: the token must be active,
    of the principal's company, and of a run the principal's user started."""
    from oracle.runs.models import Run
    from oracle.runtokens import verify_run_token

    claims = await verify_run_token(raw)
    if claims is None or claims.tenant_id != principal.tenant_id or principal.user_id is None:
        raise _unauthorized()
    async with tenant_session(claims.tenant_id) as s:
        run = await s.get(Run, claims.run_id)
        creator = await s.get(User, run.created_by) if run and run.created_by else None
    # A disabled creator's runs act for no one.
    if run is None or run.created_by != principal.user_id or not service.may_sign_in(creator):
        raise _unauthorized()
    return replace(principal, run_id=run.id, run_token_id=claims.token_id)


async def _member_run(principal: Principal) -> bool:
    """Whether the principal's run is of a flow whose output every member reads."""
    from sqlalchemy import select

    from oracle.runs.flows import reads_as_member
    from oracle.runs.models import Run

    async with tenant_session(principal.tenant_id) as s:
        flow = await s.scalar(select(Run.flow).where(Run.id == principal.run_id))
    return reads_as_member(flow)


def _run_of(request: Request, principal: Principal) -> uuid.UUID | None:
    raw = request.headers.get(RUN_HEADER)
    if not raw:
        return None
    run_id = service.read_run_binding(raw, principal.user_id)
    if run_id is None:
        # Fail closed: a header that does not verify must not leave the request acting as
        # the person (who would see author-only findings a run may not).
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Invalid {RUN_HEADER}: not a run binding issued for this credential",
        )
    return run_id


async def get_principal(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    cookie: Annotated[str | None, Depends(_cookie)],
) -> Principal:
    principal = await _authenticate(request, bearer, cookie)
    # Oracle's MCP server marks a run token's in-process REST call twice: with the run
    # token (re-read under the review gate) and with a server-signed run binding. Either
    # one alone marks the call as the run's; both must name the same run.
    run_token = request.headers.get(RUN_TOKEN_HEADER)
    if run_token is not None:
        principal = await _for_run(principal, run_token)
    run_id = _run_of(request, principal)
    if run_id is not None and principal.run_id is not None and principal.run_id != run_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{RUN_HEADER} and {RUN_TOKEN_HEADER} name different runs",
        )
    if run_id is not None:
        principal = replace(principal, run_id=run_id)
    if principal.run_id is not None:
        principal = replace(principal, as_member=await _member_run(principal))
    # Parses of this request count against one person: the user, else the token; a run
    # token's, the run (oracle.safe_yaml.MAX_PER_OWNER).
    owner = principal.run_id or principal.user_id or principal.token_id
    safe_yaml.PARSE_OWNER.set(str(owner) if owner is not None else None)
    return principal


async def _authenticate(
    request: Request,
    bearer: HTTPAuthorizationCredentials | None,
    cookie: str | None,
) -> Principal:
    iap_user = await _iap_user(request)
    if bearer is not None:
        principal = await _bearer_principal(bearer.credentials)
        if principal.read_only and request.method not in _READ_METHODS:
            # AC1: a read-only credential changes nothing, whatever the route or role
            # allows; checked here once, over MCP and on REST alike.
            raise HTTPException(status.HTTP_403_FORBIDDEN, READ_ONLY)
        return principal
    if iap_user is not None:
        return Principal(
            tenant_id=iap_user.tenant_id, kind="user", role=iap_user.role, user_id=iap_user.id
        )
    if cookie:
        session = service.read_session_cookie(cookie)
        if session is not None:
            async with tenant_session(session.tenant_id) as s:
                user = await s.get(User, session.user_id)
                # A disabled member's sessions, and every session signed before their
                # last disable or restore, no longer sign in (C2).
                if service.session_is_current(user, session.signed_at):
                    return Principal(
                        tenant_id=session.tenant_id,
                        kind="user",
                        role=user.role,
                        user_id=session.user_id,
                    )
    raise _unauthorized()


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]


def _allowed_origins(request: Request) -> set[str]:
    from urllib.parse import urlsplit

    from oracle.mcp.oauth.service import oauth_settings

    settings = get_settings()
    hosts = {request.headers.get("host"), request.headers.get("x-forwarded-host")}
    for url in (*settings.cors_origins, settings.app_url, oauth_settings().public_url):
        if url:
            hosts.add(urlsplit(url).netloc)
    return {h.lower() for h in hosts if h}


async def same_origin(request: Request) -> None:
    """Refuse a cross-site request signed in by the browser's own credentials (403).

    For a body-less POST that changes something (sign out everywhere, approve or resume
    a run, disable a member): it has no JSON body, so the browser sends it cross-site
    without a CORS preflight, and SameSite=Lax does not cover every case (a same-site
    sibling host, IAP's own cookie). Checked only when the session cookie or Google
    sign-in signs the request in: a bearer token is never sent by a browser on its own.
    A browser sends ``Sec-Fetch-Site`` and ``Origin`` on such a request; a request with
    neither is not a browser's, and passes."""
    from urllib.parse import urlsplit

    if request.headers.get("authorization"):
        return
    ambient = request.cookies.get(get_settings().session_cookie_name) or request.headers.get(
        iap.ASSERTION_HEADER
    )
    if not ambient:
        return
    refused = HTTPException(status.HTTP_403_FORBIDDEN, "Cross-site request refused")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise refused
    origin = request.headers.get("origin")
    if origin is None:
        return
    if origin == "null" or urlsplit(origin).netloc.lower() not in _allowed_origins(request):
        raise refused


async def get_db(principal: CurrentPrincipal) -> AsyncIterator[AsyncSession]:
    # H8: the request's reads follow the principal's view of documents (an update is
    # absent for a commenter or viewer).
    from oracle.docs import visibility

    async with tenant_session(principal.tenant_id) as session:
        visibility.bind(session, principal)
        yield session


TenantDB = Annotated[AsyncSession, Depends(get_db)]
