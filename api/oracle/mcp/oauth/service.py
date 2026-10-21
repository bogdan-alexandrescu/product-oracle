"""OAuth 2.1 grants for MCP clients: registration, codes with PKCE, token rotation.

Clients are public (no secret); PKCE S256 binds a code to the client that asked for
it. Codes, access tokens and refresh tokens are random secrets stored as sha256
hashes, like API tokens. The token endpoint runs before a tenant is known, so the
client is looked up unscoped (its ``client_id`` is globally unique) and everything
after that runs in the client's tenant.

Effective rights are the user's current role intersected with the granted scope:
``oracle:write`` acts with the user's role, ``oracle:read`` alone with viewer rights.
"""

import base64
import hashlib
import ipaddress
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth import iap
from oracle.auth.models import Role, User
from oracle.auth.service import hash_token
from oracle.config import get_settings
from oracle.mcp.oauth.models import OAuthClient, OAuthCode, OAuthToken
from oracle.tenancy import tenant_session, unscoped_session

SCOPES = ("oracle:read", "oracle:write")
SCOPE_DESCRIPTIONS = {
    "oracle:read": (
        "Read the baseline, sources you can see, documents and runs, and list the titles "
        "of every Notion page shared with Product Oracle, including pages in no source."
    ),
    "oracle:write": "Make changes with your role: propose, comment, approve, edit.",
}
# Asked for when a client sends no scope; the consent screen shows it and the user's
# role still caps what the token can do.
DEFAULT_SCOPE = "oracle:read oracle:write"

CODE_TTL = timedelta(minutes=10)
ACCESS_TTL = timedelta(hours=1)
REFRESH_TTL = timedelta(days=30)
# How long a validated authorization request may sit on the consent screen.
REQUEST_TTL_SECONDS = 10 * 60

CLIENT_ID_PREFIX = "pocl_"
CODE_PREFIX = "poc_"
ACCESS_PREFIX = "poa_"
REFRESH_PREFIX = "por_"

MAX_REDIRECT_URIS = 10
MAX_URI_LENGTH = 2000
MAX_NAME_LENGTH = 200
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
# RFC 7636: 43-128 characters of [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~".
_VERIFIER = re.compile(r"^[A-Za-z0-9\-._~]{43,128}$")
_CHALLENGE = re.compile(r"^[A-Za-z0-9\-_]{43}$")


class OAuthSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORACLE_", env_file=".env", extra="ignore")

    # The origin MCP clients and browsers reach Oracle at, e.g. https://oracle.example.com.
    # It is the issuer, and <public_url>/mcp is the protected resource. Empty: derived
    # from the request (local development only).
    public_url: str = ""


@lru_cache
def oauth_settings() -> OAuthSettings:
    return OAuthSettings()


def issuer(request_base_url: str) -> str:
    return (oauth_settings().public_url or request_base_url).rstrip("/")


class OAuthError(Exception):
    """An RFC 6749 error response: ``{"error": ..., "error_description": ...}``."""

    def __init__(self, error: str, description: str, status_code: int = 400) -> None:
        super().__init__(description)
        self.error = error
        self.description = description
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------- validation


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host in _LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def valid_redirect_uri(uri: str) -> bool:
    """https anywhere, or http on a loopback host (RFC 8252 native apps). No fragment."""
    if not isinstance(uri, str) or len(uri) > MAX_URI_LENGTH:
        return False
    try:
        parts = urlsplit(uri)
        parts.port  # noqa: B018  (raises on a malformed port)
    except ValueError:
        return False
    if parts.fragment or "#" in uri or not parts.hostname:
        return False
    if parts.username or parts.password:
        return False
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and _is_loopback(parts.hostname)


def redirect_uri_allowed(registered: list[str], uri: str) -> bool:
    """Exact match, except that a loopback redirect may use any port (RFC 8252 7.3)."""
    if uri in registered:
        return True
    if not valid_redirect_uri(uri):
        return False
    asked = urlsplit(uri)
    if asked.scheme != "http" or not _is_loopback(asked.hostname):
        return False
    for candidate in registered:
        reg = urlsplit(candidate)
        if (
            reg.scheme == "http"
            and reg.hostname == asked.hostname
            and reg.path == asked.path
            and reg.query == asked.query
        ):
            return True
    return False


def parse_scope(scope: str | None) -> list[str]:
    """The requested scopes in canonical order; the default when none are asked for."""
    asked = (scope or DEFAULT_SCOPE).split()
    unknown = [s for s in asked if s not in SCOPES]
    if unknown:
        raise OAuthError("invalid_scope", f"Unknown scope: {' '.join(unknown)}")
    if not asked:
        raise OAuthError("invalid_scope", "No scope requested")
    return [s for s in SCOPES if s in asked]


def effective_role(user_role: str, scope: str) -> Role:
    """The user's role intersected with the scope. ``oracle:read`` alone means viewer."""
    if "oracle:write" in scope.split():
        return user_role  # type: ignore[return-value]
    return "viewer"


def s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def valid_code_challenge(challenge: str | None) -> bool:
    return bool(challenge) and bool(_CHALLENGE.match(challenge))


def append_query(uri: str, params: dict[str, str | None]) -> str:
    parts = urlsplit(uri)
    extra = urlencode({k: v for k, v in params.items() if v is not None})
    query = f"{parts.query}&{extra}" if parts.query else extra
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


# ---------------------------------------------------------------- clients


async def default_tenant_id() -> uuid.UUID | None:
    """The tenant IAP sign-in lands in: registration happens before anyone signs in."""
    return await iap._default_tenant_id()


async def register_client(
    session: AsyncSession, name: str, redirect_uris: list[str]
) -> OAuthClient:
    client = OAuthClient(
        client_id=CLIENT_ID_PREFIX + secrets.token_urlsafe(24),
        name=name,
        redirect_uris=redirect_uris,
    )
    session.add(client)
    await session.flush()
    return client


async def find_client(client_id: str | None) -> OAuthClient | None:
    """Look a client up by its public id, before a tenant is known."""
    if not client_id:
        return None
    async with unscoped_session() as s:
        return await s.scalar(select(OAuthClient).where(OAuthClient.client_id == client_id))


# ---------------------------------------------------------------- consent requests


@dataclass(frozen=True)
class AuthorizationRequest:
    """A validated ``/oauth/authorize`` request, carried to the consent screen signed."""

    client_id: str
    redirect_uri: str
    scope: str
    code_challenge: str
    state: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "c": self.client_id,
            "r": self.redirect_uri,
            "s": self.scope,
            "p": self.code_challenge,
            "st": self.state,
        }


def _request_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="oracle-oauth-authorize")


def sign_request(req: AuthorizationRequest) -> str:
    return _request_serializer().dumps(req.to_dict())


def read_request(value: str) -> AuthorizationRequest | None:
    """The request behind a signed handle, ``None`` if tampered with or older than 10 min."""
    try:
        d = _request_serializer().loads(value, max_age=REQUEST_TTL_SECONDS)
        return AuthorizationRequest(
            client_id=d["c"],
            redirect_uri=d["r"],
            scope=d["s"],
            code_challenge=d["p"],
            state=d.get("st"),
        )
    except (BadSignature, KeyError, TypeError):
        return None


async def issue_code(
    session: AsyncSession, client: OAuthClient, user_id: uuid.UUID, req: AuthorizationRequest
) -> str:
    raw = CODE_PREFIX + secrets.token_urlsafe(32)
    session.add(
        OAuthCode(
            code_hash=hash_token(raw),
            client_id=client.id,
            user_id=user_id,
            redirect_uri=req.redirect_uri,
            code_challenge=req.code_challenge,
            scope=req.scope,
            expires_at=_now() + CODE_TTL,
        )
    )
    await session.flush()
    return raw


# ---------------------------------------------------------------- tokens


@dataclass(frozen=True)
class IssuedTokens:
    access_token: str
    refresh_token: str
    scope: str
    expires_in: int


def _new_token_row(
    *,
    client_id: uuid.UUID,
    user_id: uuid.UUID,
    scope: str,
    family_id: uuid.UUID | None,
    rotated_from: uuid.UUID | None = None,
    code_id: uuid.UUID | None = None,
) -> tuple[OAuthToken, IssuedTokens]:
    access = ACCESS_PREFIX + secrets.token_urlsafe(32)
    refresh = REFRESH_PREFIX + secrets.token_urlsafe(32)
    now = _now()
    row_id = uuid.uuid4()
    row = OAuthToken(
        id=row_id,
        access_hash=hash_token(access),
        refresh_hash=hash_token(refresh),
        client_id=client_id,
        user_id=user_id,
        scope=scope,
        expires_at=now + ACCESS_TTL,
        refresh_expires_at=now + REFRESH_TTL,
        rotated_from=rotated_from,
        family_id=family_id or row_id,
        code_id=code_id,
    )
    issued = IssuedTokens(access, refresh, scope, int(ACCESS_TTL.total_seconds()))
    return row, issued


async def _revoke_family(
    session: AsyncSession, family_id: uuid.UUID, client: OAuthClient, why: str
) -> None:
    """End a grant (every token of the family) and, in the same transaction, lapse for
    good the approvals made through it, as revoking an API token does (C2). Takes the
    review gate exclusively, like every change to who approves."""
    from oracle.review import publish
    from oracle.review.state import lapse_approvals

    await publish.gate_lock(session, shared=False)
    await session.execute(
        update(OAuthToken)
        .where(OAuthToken.family_id == family_id, OAuthToken.revoked_at.is_(None))
        .values(revoked_at=_now())
    )
    await lapse_approvals(
        session,
        None,
        grant_id=family_id,
        reason=f"MCP OAuth grant of {client.name!r} was revoked ({why})",
    )


async def _client_or_error(client_id: str | None) -> OAuthClient:
    client = await find_client(client_id)
    if client is None:
        raise OAuthError("invalid_client", "Unknown client_id", status_code=401)
    return client


async def exchange_code(
    client_id: str | None, code: str | None, redirect_uri: str | None, code_verifier: str | None
) -> IssuedTokens:
    """``grant_type=authorization_code``: single use, PKCE-checked, redirect-bound."""
    client = await _client_or_error(client_id)
    if not code:
        raise OAuthError("invalid_request", "code is required")
    if not code_verifier or not _VERIFIER.match(code_verifier):
        raise OAuthError("invalid_request", "code_verifier is required (43-128 characters)")
    async with tenant_session(client.tenant_id) as s:
        row = await s.scalar(
            select(OAuthCode).where(OAuthCode.code_hash == hash_token(code)).with_for_update()
        )
        if row is None or row.client_id != client.id:
            raise OAuthError("invalid_grant", "Unknown authorization code")
        if row.used_at is not None:
            # A replayed code: revoke whatever was issued from it (RFC 6749 4.1.2).
            families = (
                await s.scalars(select(OAuthToken.family_id).where(OAuthToken.code_id == row.id))
            ).all()
            # The gate comes before any row lock (a disable's order): release the code's.
            await s.rollback()
            for family_id in set(families):
                await _revoke_family(s, family_id, client, "authorization code replayed")
            await s.commit()
            raise OAuthError("invalid_grant", "Authorization code already used")
        if row.expires_at <= _now():
            raise OAuthError("invalid_grant", "Authorization code expired")
        if redirect_uri != row.redirect_uri:
            raise OAuthError("invalid_grant", "redirect_uri does not match the authorization")
        if not secrets.compare_digest(s256(code_verifier), row.code_challenge):
            raise OAuthError("invalid_grant", "PKCE verification failed")
        # Shared lock on the member: a disable running now finishes first (and refuses).
        user = await s.get(User, row.user_id, with_for_update={"read": True})
        if user is None or user.disabled_at is not None:
            raise OAuthError("invalid_grant", "The user no longer exists or is disabled")
        if user.sessions_valid_after is not None and row.created_at < user.sessions_valid_after:
            # Issued before a disable (a restored member authorizes again, C2), a sign-out
            # everywhere or a password change (which also void unused codes, AC1).
            raise OAuthError("invalid_grant", "Authorization code issued before a sign-out")
        row.used_at = _now()
        token, issued = _new_token_row(
            client_id=client.id,
            user_id=row.user_id,
            scope=row.scope,
            family_id=None,
            code_id=row.id,
        )
        s.add(token)
        await s.commit()
        return issued


async def refresh(
    client_id: str | None, refresh_token: str | None, scope: str | None
) -> IssuedTokens:
    """``grant_type=refresh_token``: rotates; a reused refresh token revokes the family."""
    client = await _client_or_error(client_id)
    if not refresh_token:
        raise OAuthError("invalid_request", "refresh_token is required")
    async with tenant_session(client.tenant_id) as s:
        digest = hash_token(refresh_token)
        found = await s.scalar(select(OAuthToken.user_id).where(OAuthToken.refresh_hash == digest))
        if found is not None:
            # The member's row first (shared), then the token's: a disable's order (it
            # locks the member, then revokes their tokens). A refresh that arrives while
            # a disable runs waits for it and is refused; none rotates past its revoke.
            await s.execute(select(User.id).where(User.id == found).with_for_update(read=True))
        row = await s.scalar(
            select(OAuthToken)
            .where(OAuthToken.refresh_hash == digest)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if row is None or row.client_id != client.id:
            raise OAuthError("invalid_grant", "Unknown refresh token")
        if row.revoked_at is not None:
            rotated = await s.scalar(
                select(OAuthToken.id).where(OAuthToken.rotated_from == row.id).limit(1)
            )
            if rotated is not None:
                # Already exchanged once: someone else holds a copy. End the grant. The
                # gate comes before any row lock (a disable's order): release the row's.
                family_id = row.family_id
                await s.rollback()
                await _revoke_family(s, family_id, client, "refresh token reused")
                await s.commit()
                raise OAuthError("invalid_grant", "Refresh token reused; the grant is revoked")
            raise OAuthError("invalid_grant", "Refresh token revoked")
        if row.refresh_expires_at <= _now():
            raise OAuthError("invalid_grant", "Refresh token expired")
        granted = row.scope.split()
        if scope is not None:
            asked = parse_scope(scope)
            if not set(asked) <= set(granted):
                raise OAuthError("invalid_scope", "Cannot widen the scope on refresh")
            granted = asked
        user = await s.get(User, row.user_id, populate_existing=True)
        if user is None or user.disabled_at is not None:
            raise OAuthError("invalid_grant", "The user no longer exists or is disabled")
        row.revoked_at = _now()
        token, issued = _new_token_row(
            client_id=client.id,
            user_id=row.user_id,
            scope=" ".join(granted),
            family_id=row.family_id,
            rotated_from=row.id,
            code_id=row.code_id,
        )
        s.add(token)
        await s.commit()
        return issued


async def revoke(client_id: str | None, token: str | None) -> None:
    """RFC 7009. Revoking either token of a grant ends the grant (the whole family).

    Unknown tokens, and tokens of another client, are ignored: the answer is always 200.
    """
    client = await _client_or_error(client_id)
    if not token:
        raise OAuthError("invalid_request", "token is required")
    digest = hash_token(token)
    async with tenant_session(client.tenant_id) as s:
        row = await s.scalar(
            select(OAuthToken).where(
                (OAuthToken.access_hash == digest) | (OAuthToken.refresh_hash == digest)
            )
        )
        if row is None or row.client_id != client.id:
            return
        await _revoke_family(s, row.family_id, client, "revoked by the client")
        await s.commit()
