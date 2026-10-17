"""What Oracle knows about each provider a user can connect.

For every provider: how to check a credential and read the account it belongs to
(``identify``), its OAuth endpoints and scopes when it has OAuth, and the source kinds
it serves (``oracle.sources.models.SOURCE_KINDS``). ``identify`` takes the HTTP client
as an argument so tests drive it with ``httpx.MockTransport``.

The Claude plan is special: a pasted ``claude setup-token`` value is checked by running
a tiny call through Claude Code (``oracle.llm``), an Anthropic API key with
``GET /v1/models``. Neither reveals a stable account id, so a user holds at most one
plan and one API key (``account_id`` ``plan`` / ``api_key``) and pasting again replaces
the old one.
"""

import hashlib
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx


class CredentialRejected(Exception):
    """The provider says the credential is invalid, expired or revoked."""


class ProviderUnavailable(Exception):
    """The provider could not be reached or answered with an unexpected error."""


@dataclass(frozen=True)
class Identity:
    account_id: str
    label: str
    # Scopes the provider reports for the credential, when it reports any.
    scopes: list[str] = field(default_factory=list)
    # Extra values to keep inside the encrypted credential (e.g. the Claude token kind).
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OAuthMeta:
    authorize_url: str
    token_url: str
    scopes: list[str]
    # Query parameter that carries the scopes (Slack uses user_scope for user grants).
    scope_param: str = "scope"
    scope_separator: str = " "
    # Extra authorize parameters (offline access, consent prompt, ...).
    authorize_params: Mapping[str, str] = field(default_factory=dict)
    # How the client authenticates at the token endpoint: form fields or HTTP Basic.
    client_auth: str = "form"
    # Token endpoint body encoding: "form" or "json".
    token_body: str = "form"
    pkce: bool = True


Identify = Callable[[httpx.AsyncClient, str], Awaitable[Identity]]


@dataclass(frozen=True)
class Provider:
    key: str
    name: str
    identify: Identify
    source_kinds: tuple[str, ...]
    # Where a user gets a personal token, shown next to the paste box.
    token_help: str
    oauth: OAuthMeta | None = None
    # Pulls the access token bundle out of a token endpoint answer (Slack nests it).
    parse_token_response: Callable[[dict[str, Any]], dict[str, Any]] | None = None


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _check(resp: httpx.Response, name: str) -> None:
    if resp.status_code in (401, 403):
        raise CredentialRejected(f"{name} rejected the token ({resp.status_code})")
    if resp.status_code >= 400:
        raise ProviderUnavailable(f"{name} answered {resp.status_code}")


def _scope_header(resp: httpx.Response, header: str) -> list[str]:
    raw = resp.headers.get(header, "")
    return [s.strip() for s in raw.split(",") if s.strip()]


async def _get(client: httpx.AsyncClient, method: str, url: str, **kwargs) -> httpx.Response:
    try:
        return await client.request(method, url, **kwargs)
    except httpx.HTTPError as e:
        raise ProviderUnavailable(f"cannot reach {httpx.URL(url).host}: {e}") from e


# --- GitHub -------------------------------------------------------------------------


async def identify_github(client: httpx.AsyncClient, token: str) -> Identity:
    resp = await _get(
        client,
        "GET",
        "https://api.github.com/user",
        headers={**_bearer(token), "Accept": "application/vnd.github+json"},
    )
    _check(resp, "GitHub")
    data = resp.json()
    return Identity(
        account_id=str(data["id"]),
        label=data.get("login") or str(data["id"]),
        scopes=_scope_header(resp, "X-OAuth-Scopes"),
    )


# --- Slack --------------------------------------------------------------------------


async def identify_slack(client: httpx.AsyncClient, token: str) -> Identity:
    resp = await _get(client, "POST", "https://slack.com/api/auth.test", headers=_bearer(token))
    _check(resp, "Slack")
    data = resp.json()
    if not data.get("ok"):
        error = data.get("error", "unknown_error")
        if error in (
            "invalid_auth",
            "not_authed",
            "token_revoked",
            "token_expired",
            "account_inactive",
        ):
            raise CredentialRejected(f"Slack rejected the token ({error})")
        raise ProviderUnavailable(f"Slack answered {error}")
    team = data.get("team") or data.get("team_id")
    user = data.get("user") or data.get("user_id")
    return Identity(
        account_id=f"{data['team_id']}:{data['user_id']}",
        label=f"{user} @ {team}",
        scopes=_scope_header(resp, "X-OAuth-Scopes"),
    )


def _slack_token_response(data: dict[str, Any]) -> dict[str, Any]:
    # oauth.v2.access puts a user token under authed_user; DMs are never requested.
    if not data.get("ok", True):
        raise CredentialRejected(f"Slack refused the code ({data.get('error')})")
    return data.get("authed_user") or data


# --- Notion -------------------------------------------------------------------------

NOTION_VERSION = "2022-06-28"


async def identify_notion(client: httpx.AsyncClient, token: str) -> Identity:
    resp = await _get(
        client,
        "GET",
        "https://api.notion.com/v1/users/me",
        headers={**_bearer(token), "Notion-Version": NOTION_VERSION},
    )
    _check(resp, "Notion")
    data = resp.json()
    bot = data.get("bot") or {}
    label = bot.get("workspace_name") or data.get("name") or data["id"]
    return Identity(account_id=data["id"], label=label)


# --- Fireflies ----------------------------------------------------------------------


async def identify_fireflies(client: httpx.AsyncClient, token: str) -> Identity:
    resp = await _get(
        client,
        "POST",
        "https://api.fireflies.ai/graphql",
        headers=_bearer(token),
        json={"query": "query { user { user_id email name } }"},
    )
    _check(resp, "Fireflies")
    data = resp.json()
    user = (data.get("data") or {}).get("user")
    if not user:
        errors = data.get("errors") or [{}]
        code = (errors[0].get("extensions") or {}).get("code", "")
        message = errors[0].get("message", "no user returned")
        if code in ("invalid_api_key", "UNAUTHENTICATED", "FORBIDDEN") or "auth" in message.lower():
            raise CredentialRejected(f"Fireflies rejected the API key ({message})")
        raise ProviderUnavailable(f"Fireflies answered: {message}")
    return Identity(account_id=str(user["user_id"]), label=user.get("email") or user.get("name"))


# --- Google -------------------------------------------------------------------------


async def identify_google(client: httpx.AsyncClient, token: str) -> Identity:
    resp = await _get(
        client,
        "GET",
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers=_bearer(token),
    )
    _check(resp, "Google")
    data = resp.json()
    return Identity(account_id=data["sub"], label=data.get("email") or data["sub"])


# --- Claude -------------------------------------------------------------------------

# Built from parts so the source holds no credential-shaped literal.
PLAN_TOKEN_PREFIX = "-".join(("sk", "ant", "oat"))
API_KEY_PREFIX = "-".join(("sk", "ant", "api"))
ANTHROPIC_API = "https://api.anthropic.com"
ANTHROPIC_VERSION = "2023-06-01"


def claude_token_kind(token: str) -> str:
    """``plan`` for a ``claude setup-token`` value, ``api_key`` for an API key."""
    if token.startswith(PLAN_TOKEN_PREFIX):
        return "plan"
    if token.startswith(API_KEY_PREFIX):
        return "api_key"
    raise CredentialRejected(
        "Not a Claude credential: paste the value printed by `claude setup-token` "
        "or an Anthropic API key"
    )


def _tail(token: str) -> str:
    return token[-4:]


async def identify_claude(client: httpx.AsyncClient, token: str) -> Identity:
    """An API key is checked with ``GET /v1/models``; a plan token through Claude Code."""
    kind = claude_token_kind(token)
    fingerprint = hashlib.sha256(token.encode()).hexdigest()[:12]
    if kind == "api_key":
        resp = await _get(
            client,
            "GET",
            f"{ANTHROPIC_API}/v1/models",
            params={"limit": 1},
            headers={"x-api-key": token, "anthropic-version": ANTHROPIC_VERSION},
        )
        _check(resp, "Anthropic")
        return Identity(
            account_id="api_key",
            label=f"Anthropic API key …{_tail(token)}",
            extra={"kind": "api_key", "fingerprint": fingerprint},
        )

    from oracle.llm import gateway

    await gateway.verify_plan_token(token)
    return Identity(
        account_id="plan",
        label=f"Claude plan (setup-token …{_tail(token)})",
        extra={"kind": "plan", "fingerprint": fingerprint},
    )


# --- Registry -----------------------------------------------------------------------

PROVIDERS: dict[str, Provider] = {
    p.key: p
    for p in (
        Provider(
            key="github",
            name="GitHub",
            identify=identify_github,
            source_kinds=("github",),
            token_help="A fine-grained personal access token with read access to the repos "
            "to pull in (github.com/settings/personal-access-tokens).",
            oauth=OAuthMeta(
                authorize_url="https://github.com/login/oauth/authorize",
                token_url="https://github.com/login/oauth/access_token",
                scopes=["read:user", "repo"],
            ),
        ),
        Provider(
            key="slack",
            name="Slack",
            identify=identify_slack,
            source_kinds=("slack",),
            token_help="A Slack user token from a Slack app with channels:history, "
            "channels:read, groups:history, groups:read and users:read. Direct messages "
            "are never read.",
            oauth=OAuthMeta(
                authorize_url="https://slack.com/oauth/v2/authorize",
                token_url="https://slack.com/api/oauth.v2.access",
                scopes=[
                    "channels:history",
                    "channels:read",
                    "groups:history",
                    "groups:read",
                    "users:read",
                ],
                scope_param="user_scope",
                scope_separator=",",
            ),
            parse_token_response=_slack_token_response,
        ),
        Provider(
            key="notion",
            name="Notion",
            identify=identify_notion,
            source_kinds=("notion",),
            token_help="An internal integration secret (notion.so/profile/integrations); "
            "share the pages to pull in with the integration.",
            oauth=OAuthMeta(
                authorize_url="https://api.notion.com/v1/oauth/authorize",
                token_url="https://api.notion.com/v1/oauth/token",
                scopes=[],
                authorize_params={"owner": "user"},
                client_auth="basic",
                token_body="json",
            ),
        ),
        Provider(
            key="fireflies",
            name="Fireflies",
            identify=identify_fireflies,
            source_kinds=("fireflies",),
            token_help="Your API key from app.fireflies.ai, Settings > Developer settings.",
        ),
        Provider(
            key="google",
            name="Google Docs",
            identify=identify_google,
            source_kinds=("google_docs",),
            token_help="Google access tokens expire within an hour; connect with Google "
            "sign-in when it is configured.",
            oauth=OAuthMeta(
                authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
                token_url="https://oauth2.googleapis.com/token",
                scopes=[
                    "openid",
                    "email",
                    "https://www.googleapis.com/auth/drive.readonly",
                ],
                authorize_params={"access_type": "offline", "prompt": "consent"},
            ),
        ),
        Provider(
            key="claude",
            name="Claude plan",
            identify=identify_claude,
            source_kinds=(),
            token_help="Run `claude setup-token` on your machine and paste the token it "
            "prints, or paste an Anthropic API key.",
        ),
    )
}


def get_provider(key: str) -> Provider | None:
    return PROVIDERS.get(key)
