"""Claude subscription credentials: the browser sign-in, the token exchange, parsing.

Ported from SwarmCloud's ``apps/quota-broker/quota_broker/oauth.py``. The endpoints,
the client id, the scopes, the 32-byte state, the request bodies and the headers are
SwarmCloud's, measured there against the live endpoints:

* the authorization_code grant is sent as JSON (form-encoding is answered
  "Invalid request format") and carries ``state``;
* the refresh_token grant is sent FORM-encoded (JSON is answered 403);
* both present Claude Code's User-Agent (the token endpoint's WAF refuses others).

A subscription authenticates with a short-lived ACCESS token and a long-lived REFRESH
token, the pair Claude Code keeps as its saved login. Refresh tokens ROTATE, so Oracle
has exactly one writer of them (``oracle.claude_accounts.credentials``). Only httpx is
used instead of urllib; tests pass a transport so no call reaches the network.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.parse import urlencode

import httpx

#: Claude Code's public OAuth client. Not a secret, which is why the flow is PKCE.
CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token"

#: The token endpoint refuses unrecognised clients with a 403 that reads like a
#: credential problem; this identifies the client as what it is acting as.
CLIENT_USER_AGENT = "claude-cli/2.1.274 (external, cli)"

#: Refresh this far before expiry.
DEFAULT_REFRESH_WINDOW = timedelta(hours=3)

AUTHORIZE_ENDPOINT = "https://claude.com/cai/oauth/authorize"

#: The only redirect Anthropic's client permits. It DISPLAYS the code, which is why
#: the person pastes it back: the browser cannot be redirected to Oracle.
OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"

#: Exactly what Claude Code itself requests.
OAUTH_SCOPES = (
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
)

#: 32, not 16: the endpoint validates the state's LENGTH.
_STATE_BYTES = 32

#: How long a started sign-in may wait for its code.
PENDING_TTL = timedelta(minutes=15)


class CredentialError(RuntimeError):
    """Refresh or redemption failed. The message NEVER contains token material."""


class ReauthRequired(CredentialError):
    """The refresh token is dead (``invalid_grant``). Only a person can fix this."""


@dataclass(frozen=True)
class Credential:
    access_token: str
    refresh_token: str
    expires_at: datetime

    def needs_refresh(self, now: datetime, window: timedelta = DEFAULT_REFRESH_WINDOW) -> bool:
        return now + window >= self.expires_at

    def redacted(self) -> dict[str, Any]:
        """Safe to log: timing only, never material."""
        return {
            "expires_at": self.expires_at.isoformat(),
            "has_refresh_token": bool(self.refresh_token),
        }


class TokenEndpoint(Protocol):
    async def exchange(self, refresh_token: str) -> dict[str, Any]: ...

    async def redeem(
        self, *, code: str, verifier: str, redirect_uri: str, state: str = ""
    ) -> dict[str, Any]: ...


class HttpTokenEndpoint:
    """The real endpoint. ``transport`` lets tests answer without a network call."""

    def __init__(
        self,
        url: str = TOKEN_ENDPOINT,
        client_id: str = CLAUDE_CODE_CLIENT_ID,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._url = url
        self._client_id = client_id
        self._transport = transport

    async def _post(self, *, content: bytes, content_type: str) -> httpx.Response:
        async with httpx.AsyncClient(timeout=30.0, transport=self._transport) as client:
            return await client.post(
                self._url,
                content=content,
                headers={
                    "Content-Type": content_type,
                    "Accept": "application/json",
                    "User-Agent": CLIENT_USER_AGENT,
                },
            )

    async def redeem(
        self, *, code: str, verifier: str, redirect_uri: str, state: str = ""
    ) -> dict[str, Any]:
        """Trade an authorization code for a credential pair. JSON, with ``state``."""
        payload: dict[str, Any] = {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": self._client_id,
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        }
        if state:
            payload["state"] = state
        try:
            resp = await self._post(
                content=json.dumps(payload).encode("utf-8"), content_type="application/json"
            )
        except httpx.HTTPError as exc:
            raise CredentialError(f"could not reach the token endpoint: {exc}") from None
        if resp.status_code >= 400:
            detail = resp.text[:400]
            raise CredentialError(
                "the sign-in code was not accepted. Codes are single-use and expire "
                "quickly, so the usual causes are pasting one that has already been "
                "used, or starting the sign-in again in another tab. Try Add account "
                f"once more. ({resp.status_code}: {detail})"
            )
        return _json(resp)

    async def exchange(self, refresh_token: str) -> dict[str, Any]:
        """Renew a credential. FORM-encoded (JSON is answered 403)."""
        body = urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": self._client_id,
            }
        ).encode("utf-8")
        try:
            resp = await self._post(content=body, content_type="application/x-www-form-urlencoded")
        except httpx.HTTPError as exc:
            raise CredentialError(f"could not reach the token endpoint: {exc}") from None
        if resp.status_code >= 400:
            detail = resp.text[:400]
            # `invalid_grant` is terminal; anything else may be transient.
            if "invalid_grant" in detail or resp.status_code in (400, 401):
                raise ReauthRequired(
                    f"the token endpoint rejected the refresh token ({resp.status_code}); "
                    "a person must sign in again"
                )
            raise CredentialError(f"token endpoint returned {resp.status_code}")
        return _json(resp)


def _json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        raise CredentialError("the token endpoint did not answer with JSON") from None
    if not isinstance(data, dict):
        raise CredentialError("the token endpoint returned an unexpected shape")
    return data


def parse_credential(payload: str, *, now: datetime | None = None) -> Credential:
    """Read a stored or pasted credential.

    Accepts Claude Code's saved login verbatim -- the ``claudeAiOauth`` wrapper,
    camelCase ``accessToken``/``refreshToken``/``expiresAt`` -- and the snake_case shape
    the token endpoint returns. A credential with no refresh token is refused: it
    cannot be kept alive.
    """
    now = now or datetime.now(UTC)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        raise CredentialError(
            "the credential is not JSON; a subscription credential needs accessToken, "
            "refreshToken and expiresAt"
        ) from None
    if not isinstance(data, dict):
        raise CredentialError("the credential is not a JSON object")
    inner = data.get("claudeAiOauth")
    if isinstance(inner, dict):
        data = inner
    access = data.get("accessToken") or data.get("access_token") or ""
    refresh = data.get("refreshToken") or data.get("refresh_token") or ""
    if not refresh:
        raise CredentialError("the credential has no refresh token")
    return Credential(access_token=access, refresh_token=refresh, expires_at=_expiry(data, now))


def _expiry(data: dict[str, Any], now: datetime) -> datetime:
    raw = data.get("expiresAt", data.get("expires_at"))
    if isinstance(raw, int | float) and not isinstance(raw, bool):
        # Claude Code stores epoch MILLISECONDS.
        seconds = raw / 1000 if raw > 10_000_000_000 else raw
        return datetime.fromtimestamp(seconds, tz=UTC)
    if isinstance(raw, str) and raw:
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            raise CredentialError("expiresAt is not a timestamp this can read") from None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    if "expires_in" in data:
        return now + timedelta(seconds=int(data["expires_in"]))
    # No expiry at all: treat as already due, so the first sweep refreshes it.
    return now


async def refresh(
    credential: Credential, endpoint: TokenEndpoint, *, now: datetime | None = None
) -> Credential:
    """Exchange the refresh token. The presented one is carried forward if not rotated."""
    now = now or datetime.now(UTC)
    result = await endpoint.exchange(credential.refresh_token)
    if not isinstance(result, dict):
        raise CredentialError("the token endpoint returned an unexpected shape")
    access = result.get("access_token") or ""
    if not access:
        raise CredentialError("the token endpoint returned no access_token")
    expires_in = result.get("expires_in")
    expires_at = (
        now + timedelta(seconds=int(expires_in)) if expires_in else now + timedelta(hours=8)
    )
    return Credential(
        access_token=access,
        refresh_token=result.get("refresh_token") or credential.refresh_token,
        expires_at=expires_at,
    )


def credential_from_token_response(
    payload: dict[str, Any], *, now: datetime | None = None
) -> Credential:
    """A redeemed code's response as a Credential. ``expires_in`` is seconds from now."""
    access = str(payload.get("access_token") or "")
    refresh_token = str(payload.get("refresh_token") or "")
    if not access or not refresh_token:
        raise CredentialError(
            "the token endpoint returned no refresh token, so this credential could not "
            "be kept alive. Nothing was saved."
        )
    expires_in = int(payload.get("expires_in") or 3600)
    return Credential(
        access_token=access,
        refresh_token=refresh_token,
        expires_at=(now or datetime.now(UTC)) + timedelta(seconds=expires_in),
    )


def serialise(credential: Credential) -> str:
    """The canonical stored form, in the shape Claude Code uses."""
    return json.dumps(
        {
            "accessToken": credential.access_token,
            "refreshToken": credential.refresh_token,
            "expiresAt": int(credential.expires_at.timestamp() * 1000),
        }
    )


def new_verifier() -> str:
    """A PKCE code verifier: 32 random bytes, base64url, unpadded."""
    return secrets.token_urlsafe(32)


def challenge_for(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def new_state() -> str:
    return secrets.token_urlsafe(_STATE_BYTES)


def build_authorize_url(
    *,
    state: str,
    code_challenge: str,
    client_id: str = CLAUDE_CODE_CLIENT_ID,
    redirect_uri: str = OAUTH_REDIRECT_URI,
) -> str:
    """The URL a person opens to sign in, parameters in Claude Code's order."""
    if len(state) < 40:
        raise CredentialError(
            f"state is {len(state)} characters; the authorize endpoint refuses anything "
            "built from fewer than 32 random bytes"
        )
    query = urlencode(
        [
            ("code", "true"),
            ("client_id", client_id),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri),
            ("scope", " ".join(OAUTH_SCOPES)),
            ("code_challenge", code_challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ]
    )
    return f"{AUTHORIZE_ENDPOINT}?{query}"


def split_pasted_code(pasted: str) -> tuple[str, str | None]:
    """The code, and the state if the person pasted ``<code>#<state>`` as shown."""
    value = (pasted or "").strip()
    if "#" in value:
        code, _, state = value.partition("#")
        return code.strip(), (state.strip() or None)
    return value, None
