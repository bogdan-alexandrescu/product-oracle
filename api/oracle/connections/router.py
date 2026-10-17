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

from oracle import audit
from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.auth.models import User
from oracle.connections import oauth, service
from oracle.connections.models import Connection
from oracle.connections.providers import (
    PROVIDERS,
    CredentialRejected,
    Provider,
    ProviderUnavailable,
    get_provider,
)
from oracle.llm.gateway import choose_plan
from oracle.tenancy import tenant_session
from oracle.tenant_settings_api import clear_setting, get_setting

router = APIRouter(prefix="/v1", tags=["connections"])

SETTINGS_PAGE = "/settings/connections"


async def provider_http() -> AsyncIterator[httpx.AsyncClient]:
    """HTTP client for provider calls; tests override it with an httpx.MockTransport."""
    async with service.http_client() as client:
        yield client


ProviderHttp = Annotated[httpx.AsyncClient, Depends(provider_http)]


async def require_user(principal: CurrentPrincipal) -> Principal:
    if principal.kind != "user" or principal.user_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Connections belong to a person: sign in as a user"
        )
    return principal


UserPrincipal = Annotated[Principal, Depends(require_user)]


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
    # A Claude connection the company uses for people without their own plan.
    is_company_default: bool = False


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


class ReconnectIn(BaseModel):
    # A new token for a token connection; omit it to refresh / re-check what is stored.
    token: str | None = Field(default=None, min_length=1, max_length=4096)


class ReconnectOut(BaseModel):
    connection: ConnectionOut | None = None
    # Set when the user has to sign in at the provider again.
    authorize_url: str | None = None


class AuthorizeOut(BaseModel):
    url: str


class ClaudePlanOut(BaseModel):
    source: Literal["own", "company", "none"]
    connection_id: uuid.UUID | None = None
    account_label: str | None = None
    via: Literal["plan", "api_key"] | None = None
    reason: str | None = None


def _out(conn: Connection, default_id: str | None) -> ConnectionOut:
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
        is_company_default=default_id is not None and str(conn.id) == default_id,
    )


def _provider(key: str) -> Provider:
    provider = get_provider(key)
    if provider is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown provider {key!r}; known: {', '.join(PROVIDERS)}",
        )
    return provider


def _rejected(e: Exception) -> HTTPException:
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
    default_id = await get_setting(db, "default_claude_connection_id")
    return [_out(c, default_id) for c in await service.list_for_user(db, principal.user_id)]


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


@router.get("/claude-plan", response_model=ClaudePlanOut)
async def get_claude_plan(principal: UserPrincipal, db: TenantDB) -> ClaudePlanOut:
    """Which Claude connection pays for this user's model calls, if any."""
    assert principal.user_id is not None
    choice = await choose_plan(db, principal.user_id)
    conn = choice.connection
    if conn is None:
        return ClaudePlanOut(source="none", reason=choice.reason)
    return ClaudePlanOut(
        source=choice.source,
        connection_id=conn.id,
        # The company plan's owner is another user: show only that it is the company's.
        account_label=conn.account_label if choice.source == "own" else None,
        via="api_key" if conn.account_id == "api_key" else "plan",
    )


@router.post(
    "/connections/{provider}/token",
    response_model=ConnectionOut,
    responses={400: {"description": "The provider rejected the token"}},
)
async def connect_with_token(
    provider: str, body: TokenIn, principal: UserPrincipal, db: TenantDB, http: ProviderHttp
) -> ConnectionOut:
    p = _provider(provider)
    assert principal.user_id is not None
    try:
        conn = await service.connect_token(
            db,
            http,
            user_id=principal.user_id,
            provider=p,
            token=body.token.strip(),
            label=body.label.strip() if body.label and body.label.strip() else None,
        )
    except CredentialRejected as e:
        raise _rejected(e) from None
    except ProviderUnavailable as e:
        raise _unavailable(e) from None
    await audit.record(
        db, principal, "connection.connect", "connection", conn.id,
        {"provider": p.key, "auth_mode": "token", "account": conn.account_label},
    )  # fmt: skip
    await db.commit()
    return _out(conn, await get_setting(db, "default_claude_connection_id"))


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
        if await db.get(User, st.user_id) is None:
            return _back(provider=p.key, error="Unknown user")
        try:
            tokens = await oauth.exchange_code(http, p, client, code, st.verifier)
            conn = await service.connect_oauth(
                db, http, user_id=st.user_id, provider=p, tokens=tokens
            )
        except (CredentialRejected, ProviderUnavailable) as e:
            return _back(provider=p.key, error=str(e))
        await audit.record(
            db, principal, "connection.connect", "connection", conn.id,
            {"provider": p.key, "auth_mode": "oauth", "account": conn.account_label},
        )  # fmt: skip
        await db.commit()
    return _back(connected=p.key)


@router.delete("/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(
    connection_id: uuid.UUID, principal: UserPrincipal, db: TenantDB
) -> None:
    conn = await _own(db, connection_id, principal)
    if await get_setting(db, "default_claude_connection_id") == str(conn.id):
        await clear_setting(db, "default_claude_connection_id")
    await audit.record(
        db, principal, "connection.disconnect", "connection", conn.id,
        {"provider": conn.provider, "account": conn.account_label},
    )  # fmt: skip
    await db.delete(conn)
    await db.commit()


@router.post(
    "/connections/{connection_id}/reconnect",
    response_model=ReconnectOut,
    responses={400: {"description": "The provider rejected the token"}},
)
async def reconnect_connection(
    connection_id: uuid.UUID,
    principal: UserPrincipal,
    db: TenantDB,
    http: ProviderHttp,
    body: ReconnectIn | None = None,
) -> ReconnectOut:
    """New token: replace it (same account only). No token: refresh or re-check; when
    the provider needs a fresh sign-in, returns ``authorize_url`` instead."""
    conn = await _own(db, connection_id, principal)
    p = _provider(conn.provider)
    default_id = await get_setting(db, "default_claude_connection_id")
    if body is not None and body.token:
        try:
            identity = await p.identify(http, body.token.strip())
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
        conn = await service.save(
            db,
            user_id=conn.user_id,
            provider=p,
            auth_mode="token",
            identity=identity,
            bundle={"access_token": body.token.strip()},
            label=conn.account_label if conn.auth_mode == "token" else None,
        )
    else:
        try:
            conn = await service.recheck(db, http, conn)
        except service.ConnectionUnavailable as e:
            url = _start_oauth(principal, p, conn.id) if conn.auth_mode == "oauth" else None
            if url:
                return ReconnectOut(connection=_out(conn, default_id), authorize_url=url)
            raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
        except ProviderUnavailable as e:
            raise _unavailable(e) from None
    await audit.record(
        db, principal, "connection.reconnect", "connection", conn.id, {"provider": p.key}
    )
    await db.commit()
    return ReconnectOut(connection=_out(conn, default_id))
