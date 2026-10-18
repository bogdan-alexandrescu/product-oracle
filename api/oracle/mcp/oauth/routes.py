"""OAuth 2.1 endpoints for MCP clients, and the discovery documents that lead to them.

Reachable without Google sign-in (MCP clients call them directly): the two
``/.well-known`` documents, ``/oauth/register``, ``/oauth/token``, ``/oauth/revoke``.
Behind Google sign-in (a person's browser): ``/oauth/authorize`` and the consent
screen's two calls, ``/oauth/authorize/request`` and ``/oauth/authorize/decision``.
"""

import time
from typing import Annotated
from urllib.parse import quote, urlsplit

from fastapi import APIRouter, Form, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, RedirectResponse, Response

from oracle.audit import record
from oracle.auth.deps import Principal, get_principal
from oracle.auth.models import User
from oracle.config import get_settings
from oracle.mcp.oauth import service
from oracle.mcp.oauth.models import OAuthClient
from oracle.mcp.oauth.schemas import (
    AuthorizationServerMetadata,
    ClientRegistrationIn,
    ClientRegistrationOut,
    ConsentDecisionIn,
    ConsentDecisionOut,
    ConsentRequestOut,
    OAuthErrorOut,
    ProtectedResourceMetadata,
    ScopeOut,
    TokenOut,
)
from oracle.mcp.oauth.service import AuthorizationRequest, OAuthError
from oracle.tenancy import tenant_session

router = APIRouter(tags=["oauth"])

_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}
_ERRORS = {400: {"model": OAuthErrorOut}, 401: {"model": OAuthErrorOut}}


def _base(request: Request) -> str:
    return service.issuer(str(request.base_url))


def _error(e: OAuthError) -> JSONResponse:
    headers = dict(_NO_STORE)
    if e.status_code == 401:
        headers["WWW-Authenticate"] = 'Bearer error="invalid_client"'
    return JSONResponse(
        {"error": e.error, "error_description": e.description},
        status_code=e.status_code,
        headers=headers,
    )


# ---------------------------------------------------------------- discovery


@router.get(
    "/.well-known/oauth-protected-resource",
    response_model=ProtectedResourceMetadata,
    response_model_exclude_none=True,
)
@router.get(
    "/.well-known/oauth-protected-resource/mcp",
    response_model=ProtectedResourceMetadata,
    include_in_schema=False,
)
async def oauth_protected_resource(request: Request) -> ProtectedResourceMetadata:
    """RFC 9728 metadata for ``/mcp``, at both the root and the path-suffixed location."""
    base = _base(request)
    return ProtectedResourceMetadata(
        resource=f"{base}/mcp",
        authorization_servers=[base],
        scopes_supported=list(service.SCOPES),
        bearer_methods_supported=["header"],
        resource_name="Product Oracle",
    )


@router.get("/.well-known/oauth-authorization-server", response_model=AuthorizationServerMetadata)
async def oauth_authorization_server(request: Request) -> AuthorizationServerMetadata:
    """RFC 8414 authorization server metadata."""
    base = _base(request)
    return AuthorizationServerMetadata(
        issuer=base,
        authorization_endpoint=f"{base}/oauth/authorize",
        token_endpoint=f"{base}/oauth/token",
        registration_endpoint=f"{base}/oauth/register",
        revocation_endpoint=f"{base}/oauth/revoke",
        scopes_supported=list(service.SCOPES),
        response_types_supported=["code"],
        response_modes_supported=["query"],
        grant_types_supported=["authorization_code", "refresh_token"],
        code_challenge_methods_supported=["S256"],
        token_endpoint_auth_methods_supported=["none"],
        revocation_endpoint_auth_methods_supported=["none"],
        authorization_response_iss_parameter_supported=True,
    )


# ---------------------------------------------------------------- registration


@router.post(
    "/oauth/register",
    response_model=ClientRegistrationOut,
    status_code=status.HTTP_201_CREATED,
    responses=_ERRORS,
)
async def oauth_register(body: ClientRegistrationIn):
    """RFC 7591 dynamic registration of a public client (no secret; PKCE required)."""
    uris = body.redirect_uris or []
    if not uris:
        return _error(OAuthError("invalid_redirect_uri", "redirect_uris is required"))
    if len(uris) > service.MAX_REDIRECT_URIS:
        return _error(
            OAuthError("invalid_redirect_uri", f"At most {service.MAX_REDIRECT_URIS} redirect URIs")
        )
    bad = [u for u in uris if not service.valid_redirect_uri(u)]
    if bad:
        return _error(
            OAuthError(
                "invalid_redirect_uri",
                "Redirect URIs must be https, or http on localhost / a loopback address, "
                f"without a fragment: {bad[0]}",
            )
        )
    if body.token_endpoint_auth_method not in (None, "none"):
        return _error(
            OAuthError(
                "invalid_client_metadata",
                "Only public clients are supported: token_endpoint_auth_method must be none",
            )
        )
    grant_types = body.grant_types or ["authorization_code", "refresh_token"]
    if not set(grant_types) <= {"authorization_code", "refresh_token"}:
        return _error(
            OAuthError(
                "invalid_client_metadata",
                "grant_types may only be authorization_code and refresh_token",
            )
        )
    if body.response_types not in (None, ["code"]):
        return _error(OAuthError("invalid_client_metadata", "response_types must be [code]"))
    try:
        scope = " ".join(service.parse_scope(body.scope))
    except OAuthError as e:
        return _error(OAuthError("invalid_client_metadata", e.description))
    name = (body.client_name or "").strip()[: service.MAX_NAME_LENGTH] or "Unnamed MCP client"

    tenant_id = await service.default_tenant_id()
    if tenant_id is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Oracle is not set up yet")
    async with tenant_session(tenant_id) as s:
        client = await service.register_client(s, name, list(dict.fromkeys(uris)))
        await record(s, None, "register", "oauth_client", client.id, {"name": name})
        await s.commit()
    return JSONResponse(
        ClientRegistrationOut(
            client_id=client.client_id,
            client_id_issued_at=int(time.time()),
            client_name=client.name,
            redirect_uris=client.redirect_uris,
            grant_types=grant_types,
            response_types=["code"],
            token_endpoint_auth_method="none",
            scope=scope,
        ).model_dump(),
        status_code=status.HTTP_201_CREATED,
        headers=_NO_STORE,
    )


# ---------------------------------------------------------------- authorization


async def _signed_in_user(request: Request) -> Principal | None:
    """The person in this browser (Google sign-in or the session cookie), else ``None``.

    Bearer tokens are deliberately not consulted: only a person can grant access.
    """
    cookie = request.cookies.get(get_settings().session_cookie_name)
    try:
        principal = await get_principal(request, None, cookie)
    except HTTPException as e:
        if e.status_code == status.HTTP_401_UNAUTHORIZED:
            return None
        raise
    return principal if principal.kind == "user" else None


def _bad_authorize(description: str) -> JSONResponse:
    # Without a trusted redirect URI the error cannot go back to the client (RFC 6749
    # 4.1.2.1), so the browser shows it.
    return JSONResponse(
        {"error": "invalid_request", "error_description": description},
        status_code=status.HTTP_400_BAD_REQUEST,
    )


@router.get(
    "/oauth/authorize",
    status_code=status.HTTP_302_FOUND,
    response_class=RedirectResponse,
    responses={302: {"description": "To the consent screen, sign-in, or back to the client"}},
)
async def oauth_authorize(
    request: Request,
    client_id: Annotated[str | None, Query()] = None,
    redirect_uri: Annotated[str | None, Query()] = None,
    response_type: Annotated[str | None, Query()] = None,
    scope: Annotated[str | None, Query()] = None,
    state: Annotated[str | None, Query()] = None,
    code_challenge: Annotated[str | None, Query()] = None,
    code_challenge_method: Annotated[str | None, Query()] = None,
    resource: Annotated[str | None, Query()] = None,
):
    """Validate an authorization request and send the browser to the consent screen.

    A browser without a signed-in user goes to sign-in first, then to the consent screen.
    """
    client = await service.find_client(client_id)
    if client is None:
        return _bad_authorize("Unknown client_id")
    if redirect_uri is None and len(client.redirect_uris) == 1:
        redirect_uri = client.redirect_uris[0]
    if not redirect_uri or not service.redirect_uri_allowed(client.redirect_uris, redirect_uri):
        return _bad_authorize("redirect_uri is not registered for this client")

    base = _base(request)

    def back(error: str, description: str) -> RedirectResponse:
        params = {"error": error, "error_description": description, "state": state, "iss": base}
        return RedirectResponse(service.append_query(redirect_uri, params), status.HTTP_302_FOUND)

    if response_type != "code":
        return back("unsupported_response_type", "response_type must be code")
    if code_challenge_method != "S256" or not service.valid_code_challenge(code_challenge):
        return back("invalid_request", "PKCE is required: code_challenge with method S256")
    if resource is not None and resource.rstrip("/") not in (f"{base}/mcp", base):
        return back("invalid_target", f"Unknown resource; this server protects {base}/mcp")
    try:
        scopes = service.parse_scope(scope)
    except OAuthError as e:
        return back(e.error, e.description)

    handle = service.sign_request(
        AuthorizationRequest(
            client_id=client.client_id,
            redirect_uri=redirect_uri,
            scope=" ".join(scopes),
            code_challenge=code_challenge,
            state=state,
        )
    )
    consent = f"/oauth/consent?request={quote(handle)}"
    if await _signed_in_user(request) is None:
        return RedirectResponse(
            f"{base}/login?next={quote(consent, safe='')}", status.HTTP_302_FOUND
        )
    return RedirectResponse(f"{base}{consent}", status.HTTP_302_FOUND)


async def _pending(
    request: Request, handle: str
) -> tuple[Principal, AuthorizationRequest, OAuthClient]:
    principal = await _signed_in_user(request)
    if principal is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Not authenticated", {"WWW-Authenticate": "Bearer"}
        )
    req = service.read_request(handle)
    if req is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This request has expired. Start again from your MCP client.",
        )
    client = await service.find_client(req.client_id)
    if (
        client is None
        or client.tenant_id != principal.tenant_id
        or not service.redirect_uri_allowed(client.redirect_uris, req.redirect_uri)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found")
    return principal, req, client


@router.get("/oauth/authorize/request", response_model=ConsentRequestOut)
async def oauth_consent_request(
    request: Request, handle: Annotated[str, Query(alias="request")]
) -> ConsentRequestOut:
    """The pending authorization request behind a consent URL, for the signed-in user."""
    principal, req, client = await _pending(request, handle)
    async with tenant_session(principal.tenant_id) as s:
        user = await s.get(User, principal.user_id)
    return ConsentRequestOut(
        client_id=client.client_id,
        client_name=client.name,
        redirect_uri=req.redirect_uri,
        redirect_host=urlsplit(req.redirect_uri).netloc,
        scopes=[
            ScopeOut(name=s, description=service.SCOPE_DESCRIPTIONS[s]) for s in req.scope.split()
        ],
        user_email=user.email,
        user_role=user.role,
        effective_role=service.effective_role(user.role, req.scope),
    )


@router.post("/oauth/authorize/decision", response_model=ConsentDecisionOut)
async def oauth_consent_decision(request: Request, body: ConsentDecisionIn) -> ConsentDecisionOut:
    """Approve (a 10-minute, single-use code) or deny; returns where the browser goes."""
    principal, req, client = await _pending(request, body.request)
    base = _base(request)
    if not body.approve:
        params = {
            "error": "access_denied",
            "error_description": "The user denied access",
            "state": req.state,
            "iss": base,
        }
        return ConsentDecisionOut(redirect_to=service.append_query(req.redirect_uri, params))
    async with tenant_session(principal.tenant_id) as s:
        code = await service.issue_code(s, client, principal.user_id, req)
        await record(s, principal, "authorize", "oauth_client", client.id, {"scope": req.scope})
        await s.commit()
    params = {"code": code, "state": req.state, "iss": base}
    return ConsentDecisionOut(redirect_to=service.append_query(req.redirect_uri, params))


# ---------------------------------------------------------------- tokens


@router.post("/oauth/token", response_model=TokenOut, responses=_ERRORS)
async def oauth_token(
    grant_type: Annotated[str | None, Form()] = None,
    client_id: Annotated[str | None, Form()] = None,
    code: Annotated[str | None, Form()] = None,
    redirect_uri: Annotated[str | None, Form()] = None,
    code_verifier: Annotated[str | None, Form()] = None,
    refresh_token: Annotated[str | None, Form()] = None,
    scope: Annotated[str | None, Form()] = None,
    resource: Annotated[str | None, Form()] = None,
):
    """Authorization code (with PKCE) or refresh token (rotated) for an access token."""
    try:
        if grant_type == "authorization_code":
            issued = await service.exchange_code(client_id, code, redirect_uri, code_verifier)
        elif grant_type == "refresh_token":
            issued = await service.refresh(client_id, refresh_token, scope)
        else:
            raise OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token")
    except OAuthError as e:
        return _error(e)
    out = TokenOut(
        access_token=issued.access_token,
        token_type="Bearer",
        expires_in=issued.expires_in,
        refresh_token=issued.refresh_token,
        scope=issued.scope,
    )
    return JSONResponse(out.model_dump(), headers=_NO_STORE)


@router.post("/oauth/revoke", status_code=status.HTTP_200_OK, responses=_ERRORS)
async def oauth_revoke(
    client_id: Annotated[str | None, Form()] = None,
    token: Annotated[str | None, Form()] = None,
    token_type_hint: Annotated[str | None, Form()] = None,
) -> Response:
    """RFC 7009. Ends the grant the token belongs to; unknown tokens are not an error."""
    try:
        await service.revoke(client_id, token)
    except OAuthError as e:
        return _error(e)
    return Response(status_code=status.HTTP_200_OK, headers=_NO_STORE)
