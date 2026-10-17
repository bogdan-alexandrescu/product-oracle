"""Provider OAuth: client config, PKCE, the state value, code exchange and refresh.

A provider offers OAuth only when its client is configured in the environment:
``ORACLE_OAUTH_<PROVIDER>_CLIENT_ID`` and ``ORACLE_OAUTH_<PROVIDER>_CLIENT_SECRET``.
Without one, users paste a personal token instead.

The PKCE verifier is not stored in a table: it travels inside the ``state`` value,
encrypted with :mod:`oracle.crypto` and signed with a timestamp (itsdangerous), so the
callback can trust and use it for ``STATE_MAX_AGE_SECONDS``.
"""

import base64
import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any
from urllib.parse import urlencode

import httpx
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic_settings import BaseSettings, SettingsConfigDict

from oracle import crypto
from oracle.config import get_settings
from oracle.connections.providers import (
    CredentialRejected,
    Provider,
    ProviderUnavailable,
)

STATE_MAX_AGE_SECONDS = 15 * 60


class OAuthSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORACLE_OAUTH_", env_file=".env", extra="ignore")

    # Public origin the browser uses for the app; the web app proxies /v1/* to the API,
    # so the callback is <redirect_base>/v1/connections/<provider>/callback.
    redirect_base: str = "http://localhost:3000"
    github_client_id: str = ""
    github_client_secret: str = ""
    slack_client_id: str = ""
    slack_client_secret: str = ""
    notion_client_id: str = ""
    notion_client_secret: str = ""
    google_client_id: str = ""
    google_client_secret: str = ""


@lru_cache
def get_oauth_settings() -> OAuthSettings:
    return OAuthSettings()


@dataclass(frozen=True)
class Client:
    client_id: str
    client_secret: str


def client_for(provider: Provider) -> Client | None:
    """The configured OAuth client, or None (token paste only)."""
    if provider.oauth is None:
        return None
    s = get_oauth_settings()
    client_id = getattr(s, f"{provider.key}_client_id", "")
    client_secret = getattr(s, f"{provider.key}_client_secret", "")
    if not client_id or not client_secret:
        return None
    return Client(client_id, client_secret)


def redirect_uri(provider: Provider) -> str:
    base = get_oauth_settings().redirect_base.rstrip("/")
    return f"{base}/v1/connections/{provider.key}/callback"


# --- PKCE and state -----------------------------------------------------------------


def pkce_pair() -> tuple[str, str]:
    """(verifier, S256 challenge) per RFC 7636."""
    verifier = secrets.token_urlsafe(64)[:96]
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


class InvalidState(Exception):
    """The state is forged, expired, or was issued for another provider."""


@dataclass(frozen=True)
class State:
    tenant_id: uuid.UUID
    user_id: uuid.UUID
    provider: str
    verifier: str
    # The connection being reconnected, if any.
    connection_id: uuid.UUID | None = None


def _signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="oracle-oauth-state")


def encode_state(state: State) -> str:
    payload = {
        "t": str(state.tenant_id),
        "u": str(state.user_id),
        "p": state.provider,
        "v": state.verifier,
        "c": str(state.connection_id) if state.connection_id else None,
        "n": secrets.token_urlsafe(8),
    }
    ciphertext = crypto.encrypt(json.dumps(payload).encode()).decode()
    return _signer().dumps(ciphertext)


def decode_state(value: str, provider: str, max_age: int = STATE_MAX_AGE_SECONDS) -> State:
    try:
        ciphertext = _signer().loads(value, max_age=max_age)
        payload = json.loads(crypto.decrypt(ciphertext.encode()))
        state = State(
            tenant_id=uuid.UUID(payload["t"]),
            user_id=uuid.UUID(payload["u"]),
            provider=payload["p"],
            verifier=payload["v"],
            connection_id=uuid.UUID(payload["c"]) if payload.get("c") else None,
        )
    except (BadSignature, crypto.DecryptionError, KeyError, ValueError, TypeError):
        raise InvalidState("The sign-in link is invalid or has expired; start again") from None
    if state.provider != provider:
        raise InvalidState("The sign-in link was issued for another provider")
    return state


def authorize_url(provider: Provider, client: Client, state: str, challenge: str) -> str:
    meta = provider.oauth
    assert meta is not None
    params: dict[str, str] = {
        "client_id": client.client_id,
        "redirect_uri": redirect_uri(provider),
        "response_type": "code",
        "state": state,
        **meta.authorize_params,
    }
    if meta.scopes:
        params[meta.scope_param] = meta.scope_separator.join(meta.scopes)
    if meta.pkce:
        params["code_challenge"] = challenge
        params["code_challenge_method"] = "S256"
    return f"{meta.authorize_url}?{urlencode(params)}"


# --- Token endpoint -----------------------------------------------------------------


@dataclass(frozen=True)
class Tokens:
    access_token: str
    refresh_token: str | None
    expires_at: datetime | None
    scopes: list[str]

    def bundle(self) -> dict[str, Any]:
        """What gets encrypted into ``connections.ciphertext``."""
        return {"access_token": self.access_token, "refresh_token": self.refresh_token}


async def _token_request(
    http: httpx.AsyncClient, provider: Provider, client: Client, fields: dict[str, str]
) -> dict[str, Any]:
    meta = provider.oauth
    assert meta is not None
    headers = {"Accept": "application/json"}
    if meta.client_auth == "basic":
        basic = base64.b64encode(f"{client.client_id}:{client.client_secret}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    else:
        fields = {**fields, "client_id": client.client_id, "client_secret": client.client_secret}
    kwargs: dict[str, Any] = {"json": fields} if meta.token_body == "json" else {"data": fields}
    try:
        resp = await http.post(meta.token_url, headers=headers, **kwargs)
    except httpx.HTTPError as e:
        raise ProviderUnavailable(f"cannot reach {provider.name}: {e}") from e
    try:
        data = resp.json()
    except ValueError:
        data = {}
    # Some providers (GitHub) answer 200 with an "error" field.
    error = data.get("error") if isinstance(data, dict) else None
    if resp.status_code in (400, 401, 403) or error in (
        "invalid_grant",
        "bad_verification_code",
        "bad_refresh_token",
        "invalid_client",
    ):
        raise CredentialRejected(
            f"{provider.name} refused: {data.get('error_description') or error or resp.status_code}"
        )
    if resp.status_code >= 400 or error:
        answer = error or resp.status_code
        raise ProviderUnavailable(f"{provider.name} token endpoint answered {answer}")
    if provider.parse_token_response:
        data = provider.parse_token_response(data)
    return data


def _tokens(
    data: dict[str, Any], provider: Provider, previous_refresh: str | None = None
) -> Tokens:
    access = data.get("access_token")
    if not access:
        raise ProviderUnavailable(f"{provider.name} returned no access token")
    expires_in = data.get("expires_in")
    expires_at = datetime.now(UTC) + timedelta(seconds=int(expires_in)) if expires_in else None
    raw_scope = data.get("scope") or ""
    scopes = [s for s in raw_scope.replace(",", " ").split() if s]
    return Tokens(
        access_token=access,
        refresh_token=data.get("refresh_token") or previous_refresh,
        expires_at=expires_at,
        scopes=scopes,
    )


async def exchange_code(
    http: httpx.AsyncClient, provider: Provider, client: Client, code: str, verifier: str
) -> Tokens:
    fields = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(provider),
    }
    if provider.oauth and provider.oauth.pkce:
        fields["code_verifier"] = verifier
    return _tokens(await _token_request(http, provider, client, fields), provider)


async def refresh(
    http: httpx.AsyncClient, provider: Provider, client: Client, refresh_token: str
) -> Tokens:
    data = await _token_request(
        http, provider, client, {"grant_type": "refresh_token", "refresh_token": refresh_token}
    )
    return _tokens(data, provider, previous_refresh=refresh_token)
