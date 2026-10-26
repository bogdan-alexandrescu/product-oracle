"""The signed-in user's own connections. Nobody sees or uses another user's.

Connect with a pasted token (any provider) or provider OAuth with PKCE (when the
provider's client is configured); reconnect; disconnect. No endpoint ever returns a
credential.
"""

import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from oracle import audit
from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.auth.models import User
from oracle.auth.service import may_sign_in
from oracle.authz import has_role, require_role
from oracle.config import get_settings
from oracle.connections import oauth, service
from oracle.connections.models import Connection
from oracle.connections.providers import (
    PROVIDERS,
    CredentialRefused,
    CredentialRejected,
    Provider,
    ProviderUnavailable,
    get_provider,
    reconnect_reason,
)
from oracle.sources.connectors import fireflies
from oracle.tenancy import tenant_session

router = APIRouter(prefix="/v1", tags=["connections"])

SETTINGS_PAGE = "/settings/connections"


async def provider_http() -> AsyncIterator[httpx.AsyncClient]:
    """HTTP client for provider calls; tests override it with an httpx.MockTransport."""
    async with service.http_client() as client:
        yield client


ProviderHttp = Annotated[httpx.AsyncClient, Depends(provider_http)]


async def fireflies_http() -> AsyncIterator[httpx.AsyncClient]:
    """HTTP client for Fireflies calls (its configured endpoint, the default included):
    the guarded transport. Tests override it with an httpx.MockTransport."""
    async with fireflies.guarded_client() as client:
        yield client


FirefliesHttp = Annotated[httpx.AsyncClient, Depends(fireflies_http)]


async def require_user(principal: CurrentPrincipal) -> Principal:
    if principal.kind != "user" or principal.user_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Connections belong to a person: sign in as a user"
        )
    return principal


UserPrincipal = Annotated[Principal, Depends(require_user)]
Viewer = Annotated[Principal, Depends(require_role("viewer"))]


# --- Schemas ------------------------------------------------------------------------


class ConnectionOut(BaseModel):
    id: uuid.UUID
    provider: str
    auth_mode: Literal["oauth", "token"]
    account_id: str
    account_label: str | None
    scopes: list[str]
    status: Literal["active", "expired", "revoked", "error"]
    last_error: str | None
    expires_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # Set when the connection works but should be signed in again: a Google grant
    # without drive.readonly cannot read picked folders, "Reconnect to choose files".
    reconnect_reason: str | None = None
    # Fireflies: the GraphQL endpoint it reads (the default when no owner set one);
    # null for other providers. Only the URL, never the key.
    endpoint_url: str | None = None


class ProviderOut(BaseModel):
    key: str
    name: str
    source_kinds: list[str]
    oauth_configured: bool
    oauth_scopes: list[str]
    token_help: str


class TokenIn(BaseModel):
    token: str = Field(min_length=1, max_length=4096)
    label: str | None = Field(default=None, max_length=200)
    # Fireflies only, Oracle owners only: another GraphQL endpoint (https, default port,
    # no user info, query or fragment, not a private address). Omit for the default.
    endpoint_url: str | None = Field(default=None, max_length=2048)


class EndpointIn(BaseModel):
    # null: back to the default (https://api.fireflies.ai/graphql).
    endpoint_url: str | None = Field(default=None, max_length=2048)
    # The API key, entered again: a key is never carried over to another endpoint.
    token: str = Field(min_length=1, max_length=4096)


class ReconnectIn(BaseModel):
    # A new token for a token connection; omit it to refresh / re-check what is stored.
    token: str | None = Field(default=None, min_length=1, max_length=4096)


class ReconnectOut(BaseModel):
    connection: ConnectionOut | None = None
    # Set when the user has to sign in at the provider again.
    authorize_url: str | None = None


class AuthorizeOut(BaseModel):
    url: str


class PickerConfigOut(BaseModel):
    """What the browser needs to open Google's Drive picker. All of it is public."""

    # Oracle's Google OAuth client id (the browser asks Google for a drive.readonly
    # token to browse Drive in the picker).
    client_id: str
    # The Cloud project number of that client (the picker's app id).
    app_id: str
    # A browser API key restricted to Oracle's origin and the Picker API.
    developer_key: str


def _out(conn: Connection) -> ConnectionOut:
    return ConnectionOut(
        id=conn.id,
        provider=conn.provider,
        auth_mode=conn.auth_mode,  # type: ignore[arg-type]
        account_id=conn.account_id,
        account_label=conn.account_label,
        scopes=list(conn.scopes or []),
        status=conn.status,  # type: ignore[arg-type]
        last_error=conn.last_error,
        expires_at=conn.expires_at,
        last_used_at=conn.last_used_at,
        created_at=conn.created_at,
        updated_at=conn.updated_at,
        reconnect_reason=reconnect_reason(conn.provider, list(conn.scopes or [])),
        endpoint_url=endpoint_url(conn),
    )


def endpoint_url(conn: Connection) -> str | None:
    if conn.provider != "fireflies":
        return None
    return conn.endpoint_url or fireflies.DEFAULT_ENDPOINT


OWNER_ONLY = "Only an Oracle owner can set or change a Fireflies endpoint"


def _endpoint(provider: Provider, url: str | None, principal: Principal) -> str | None:
    """The checked endpoint for ``provider`` (None for the default), or 403 / 422."""
    if not has_role(principal.role, "owner"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, OWNER_ONLY)
    if provider.key != "fireflies":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Only a Fireflies connection takes an endpoint"
        )
    try:
        return fireflies.check_endpoint(url)
    except fireflies.EndpointRefused as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None


def _provider(key: str) -> Provider:
    provider = get_provider(key)
    if provider is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown provider {key!r}; known: {', '.join(PROVIDERS)}",
        )
    return provider


def _rejected(e: Exception) -> HTTPException:
    # Refused (it works, but Oracle will not use it, e.g. a Slack bot token): 422.
    # Rejected by the provider (invalid, expired, revoked): 400.
    if isinstance(e, CredentialRefused):
        return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e))
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(e))


def _unavailable(e: Exception) -> HTTPException:
    return HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))


async def _own(db: TenantDB, connection_id: uuid.UUID, principal: Principal) -> Connection:
    assert principal.user_id is not None
    conn = await service.get_own(db, connection_id, principal.user_id)
    if conn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
    return conn


def _start_oauth(
    principal: Principal, provider: Provider, connection_id: uuid.UUID | None = None
) -> str | None:
    client = oauth.client_for(provider)
    if client is None:
        return None
    assert principal.user_id is not None
    verifier, challenge = oauth.pkce_pair()
    state = oauth.encode_state(
        oauth.State(
            tenant_id=principal.tenant_id,
            user_id=principal.user_id,
            provider=provider.key,
            verifier=verifier,
            connection_id=connection_id,
        )
    )
    return oauth.authorize_url(provider, client, state, challenge)


# --- Endpoints ----------------------------------------------------------------------


@router.get("/connections", response_model=list[ConnectionOut])
async def list_connections(principal: UserPrincipal, db: TenantDB) -> list[ConnectionOut]:
    assert principal.user_id is not None
    return [_out(c) for c in await service.list_for_user(db, principal.user_id)]


@router.get("/connections/providers", response_model=list[ProviderOut])
async def list_providers(principal: UserPrincipal) -> list[ProviderOut]:
    return [
        ProviderOut(
            key=p.key,
            name=p.name,
            source_kinds=list(p.source_kinds),
            oauth_configured=oauth.client_for(p) is not None,
            oauth_scopes=list(p.oauth.scopes) if p.oauth else [],
            token_help=p.token_help,
        )
        for p in PROVIDERS.values()
    ]


@router.get(
    "/connections/google/picker-config",
    response_model=PickerConfigOut,
    responses={404: {"description": "The Drive picker is not configured"}},
)
async def google_picker_config(principal: UserPrincipal, _: Viewer) -> PickerConfigOut:
    """Client id, Cloud project number and browser API key for Google's Drive picker.
    Never the client secret or anyone's token."""
    client = oauth.client_for(PROVIDERS["google"])
    settings = get_settings()
    key = settings.google_picker_api_key.get_secret_value()
    if client is None or not settings.google_picker_app_id or not key:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Choosing files from Drive is not configured: it needs Google sign-in "
            "(ORACLE_OAUTH_GOOGLE_CLIENT_ID and _SECRET), ORACLE_GOOGLE_PICKER_APP_ID "
            "and ORACLE_GOOGLE_PICKER_API_KEY",
        )
    return PickerConfigOut(
        client_id=client.client_id, app_id=settings.google_picker_app_id, developer_key=key
    )


@router.post(
    "/connections/{provider}/token",
    response_model=ConnectionOut,
    responses={
        400: {"description": "The provider rejected the token"},
        422: {"description": "A token Oracle will not use (a Slack bot token)"},
    },
)
async def connect_with_token(
    provider: str,
    body: TokenIn,
    principal: UserPrincipal,
    db: TenantDB,
    http: ProviderHttp,
    ff_http: FirefliesHttp,
) -> ConnectionOut:
    p = _provider(provider)
    assert principal.user_id is not None
    endpoint = _endpoint(p, body.endpoint_url, principal) if body.endpoint_url else None
    before = None
    if p.key == "fireflies":
        before = {c.account_id: endpoint_url(c) for c in await service.list_for_user(
            db, principal.user_id) if c.provider == "fireflies"}  # fmt: skip
    try:
        conn = await service.connect_token(
            db,
            ff_http if p.key == "fireflies" else http,
            user_id=principal.user_id,
            provider=p,
            token=body.token.strip(),
            label=body.label.strip() if body.label and body.label.strip() else None,
            endpoint=endpoint,
            may_change_endpoint=has_role(principal.role, "owner"),
        )
    except service.EndpointChangeRefused as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from None
    except CredentialRejected as e:
        raise _rejected(e) from None
    except ProviderUnavailable as e:
        raise _unavailable(e) from None
    except service.MemberDisabled as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from None
    await audit.record(
        db, principal, "connection.connect", "connection", conn.id,
        {"provider": p.key, "auth_mode": "token", "account": conn.account_label,
         **({"endpoint": endpoint} if endpoint else {})},
    )  # fmt: skip
    if before and conn.account_id in before and before[conn.account_id] != endpoint_url(conn):
        await audit.record(
            db, principal, "connection.endpoint", "connection", conn.id,
            {"provider": p.key, "from": before[conn.account_id], "to": endpoint_url(conn)},
        )  # fmt: skip
    await db.commit()
    return _out(conn)


@router.put(
    "/connections/{connection_id}/endpoint",
    response_model=ConnectionOut,
    responses={
        400: {"description": "Fireflies rejected the key, or it belongs to another account"},
        403: {"description": "Only an Oracle owner sets an endpoint"},
        422: {"description": "An endpoint Oracle does not call, or not a Fireflies connection"},
    },
)
async def set_connection_endpoint(
    connection_id: uuid.UUID,
    body: EndpointIn,
    principal: UserPrincipal,
    _: Annotated[Principal, Depends(require_role("owner"))],
    db: TenantDB,
    http: FirefliesHttp,
) -> ConnectionOut:
    """Change a Fireflies connection's GraphQL endpoint (null: back to the default).
    Oracle owners only; the API key is entered again and checked at the new endpoint
    (a stored key is never sent to another endpoint). Recorded in the audit log."""
    conn = await _own(db, connection_id, principal)
    p = _provider(conn.provider)
    endpoint = _endpoint(p, body.endpoint_url, principal)
    token = body.token.strip()
    try:
        identity = await service.identify(p, http, token, endpoint)
    except CredentialRejected as e:
        raise _rejected(e) from None
    except ProviderUnavailable as e:
        raise _unavailable(e) from None
    if identity.account_id != conn.account_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"That key belongs to {identity.label}, not {conn.account_label}; "
            "connect it as a new connection",
        )
    before = endpoint_url(conn)
    try:
        conn = await service.save(
            db,
            user_id=conn.user_id,
            provider=p,
            auth_mode="token",
            identity=identity,
            bundle={"access_token": token},
            label=conn.account_label,
            endpoint_url=endpoint,
        )
    except service.MemberDisabled as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from None
    await audit.record(
        db, principal, "connection.endpoint", "connection", conn.id,
        {"provider": p.key, "from": before, "to": endpoint_url(conn)},
    )  # fmt: skip
    await db.commit()
    return _out(conn)


@router.get(
    "/connections/{provider}/authorize",
    response_model=AuthorizeOut,
    responses={409: {"description": "OAuth is not configured for this provider"}},
)
async def authorize_connection(provider: str, principal: UserPrincipal) -> AuthorizeOut:
    p = _provider(provider)
    url = _start_oauth(principal, p)
    if url is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Sign-in with {p.name} is not configured; paste a token instead",
        )
    return AuthorizeOut(url=url)


def _back(**params: str) -> RedirectResponse:
    return RedirectResponse(f"{SETTINGS_PAGE}?{urlencode(params)}", status.HTTP_303_SEE_OTHER)


@router.get(
    "/connections/{provider}/callback",
    response_class=RedirectResponse,
    status_code=status.HTTP_303_SEE_OTHER,
)
async def oauth_callback(
    provider: str,
    principal: CurrentPrincipal,
    http: ProviderHttp,
    state: Annotated[str, Query()] = "",
    code: Annotated[str | None, Query()] = None,
    error: Annotated[str | None, Query()] = None,
    error_description: Annotated[str | None, Query()] = None,
) -> RedirectResponse:
    """Where the provider sends the browser back; ends on the Connections page."""
    p = _provider(provider)
    try:
        st = oauth.decode_state(state, p.key)
    except oauth.InvalidState as e:
        return _back(provider=p.key, error=str(e))
    # The state is bound to the user who started; a link opened by anyone else fails.
    if principal.kind != "user" or principal.user_id != st.user_id:
        return _back(provider=p.key, error="This sign-in was started by another user")
    if error or not code:
        return _back(provider=p.key, error=error_description or error or "No code returned")
    client = oauth.client_for(p)
    if client is None:
        return _back(provider=p.key, error=f"Sign-in with {p.name} is not configured")
    async with tenant_session(st.tenant_id) as db:
        # "is None" alone let a removed member's callback through (C2); the credential
        # is stored only after their row is locked and re-read (service.save).
        if not may_sign_in(await db.get(User, st.user_id)):
            return _back(provider=p.key, error="Unknown user")
        try:
            tokens = await oauth.exchange_code(http, p, client, code, st.verifier)
            conn = await service.connect_oauth(
                db, http, user_id=st.user_id, provider=p, tokens=tokens
            )
        except (CredentialRejected, ProviderUnavailable, service.MemberDisabled) as e:
            return _back(provider=p.key, error=str(e))
        await audit.record(
            db, principal, "connection.connect", "connection", conn.id,
            {"provider": p.key, "auth_mode": "oauth", "account": conn.account_label},
        )  # fmt: skip
        await db.commit()
    return _back(connected=p.key)


@router.delete("/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(
    connection_id: uuid.UUID, principal: UserPrincipal, db: TenantDB, http: ProviderHttp
) -> None:
    """Disconnect: revoke the grant at the provider where it has an endpoint (GitHub,
    Slack, Google; best effort), record a ``source_permission`` revocation for each
    source it synced, then delete Oracle's copy of the credential."""
    conn = await _own(db, connection_id, principal)
    revoked = await service.revoke_at_provider(http, conn)
    await audit.record(
        db, principal, "connection.disconnect", "connection", conn.id,
        {"provider": conn.provider, "account": conn.account_label, "provider_revoke": revoked},
    )  # fmt: skip
    # The sources it synced keep their items, but Oracle may no longer read them: record
    # the revocation so the publish gate refuses documents built on them.
    from oracle.review.publish import record_source_revocation
    from oracle.sources.models import Source

    sources = list(await db.scalars(select(Source).where(Source.connection_id == conn.id)))
    await record_source_revocation(db, principal, sources, "connection_revoked", drop_links=False)
    await db.delete(conn)
    await db.commit()


@router.post(
    "/connections/{connection_id}/reconnect",
    response_model=ReconnectOut,
    responses={
        400: {"description": "The provider rejected the token"},
        422: {"description": "A token Oracle will not use (a Slack bot token)"},
    },
)
async def reconnect_connection(
    connection_id: uuid.UUID,
    principal: UserPrincipal,
    db: TenantDB,
    http: ProviderHttp,
    ff_http: FirefliesHttp,
    body: ReconnectIn | None = None,
) -> ReconnectOut:
    """New token: replace it (same account only). No token: refresh or re-check; when
    the provider needs a fresh sign-in, returns ``authorize_url`` instead."""
    conn = await _own(db, connection_id, principal)
    p = _provider(conn.provider)
    if p.key == "fireflies":
        http = ff_http
    if body is not None and body.token:
        try:
            identity = await service.identify(p, http, body.token.strip(), conn.endpoint_url)
        except CredentialRejected as e:
            raise _rejected(e) from None
        except ProviderUnavailable as e:
            raise _unavailable(e) from None
        if identity.account_id != conn.account_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"That token belongs to {identity.label}, not {conn.account_label}; "
                "connect it as a new connection",
            )
        try:
            conn = await service.save(
                db,
                user_id=conn.user_id,
                provider=p,
                auth_mode="token",
                identity=identity,
                bundle={"access_token": body.token.strip()},
                label=conn.account_label if conn.auth_mode == "token" else None,
                endpoint_url=conn.endpoint_url,
            )
        except service.MemberDisabled as e:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from None
    else:
        if reconnect_reason(conn.provider, list(conn.scopes or [])):
            # Only a Google grant without drive.readonly: a refresh keeps the old grant,
            # so sign in again for the scopes Oracle needs. drive.readonly grants refresh.
            url = _start_oauth(principal, p, conn.id)
            if url:
                return ReconnectOut(connection=_out(conn), authorize_url=url)
        try:
            conn = await service.recheck(db, http, conn)
        except service.ConnectionUnavailable as e:
            url = _start_oauth(principal, p, conn.id) if conn.auth_mode == "oauth" else None
            if url:
                return ReconnectOut(connection=_out(conn), authorize_url=url)
            raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
        except ProviderUnavailable as e:
            raise _unavailable(e) from None
    await audit.record(
        db, principal, "connection.reconnect", "connection", conn.id, {"provider": p.key}
    )
    await db.commit()
    return ReconnectOut(connection=_out(conn))
