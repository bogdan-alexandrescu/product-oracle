"""What Oracle knows about each provider a user can connect.

For every provider: how to check a credential and read the account it belongs to
(``identify``), its OAuth endpoints and scopes when it has OAuth, and the source kinds
it serves (``oracle.sources.models.SOURCE_KINDS``). ``identify`` takes the HTTP client
as an argument so tests drive it with ``httpx.MockTransport``.

Claude is not a connection: Oracle's own model calls run on the company's Claude account
pool (``oracle.claude_accounts``, Settings > Claude accounts).
"""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx


class CredentialRejected(Exception):
    """The provider says the credential is invalid, expired or revoked."""


class CredentialRefused(CredentialRejected):
    """The credential works, but Oracle will not use it (a Slack bot token)."""


class ProviderUnavailable(Exception):
    """The provider could not be reached or answered with an unexpected error."""


@dataclass(frozen=True)
class Identity:
    account_id: str
    label: str
    # Scopes the provider reports for the credential, when it reports any.
    scopes: list[str] = field(default_factory=list)
    # Extra values to keep inside the encrypted credential.
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

SLACK_BOT_TOKEN = (
    "This is a Slack bot token: it would read the bot's channels, not yours. Reconnect "
    "Slack with your own sign-in or a user token (xoxp-)"
)


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
    # Slack sets bot_id for a bot token, whatever its prefix (rotated: xoxe.xoxb-...).
    if data.get("bot_id"):
        raise CredentialRefused(SLACK_BOT_TOKEN)
    team = data.get("team") or data.get("team_id")
    user = data.get("user") or data.get("user_id")
    return Identity(
        account_id=f"{data['team_id']}:{data['user_id']}",
        # "pat in Example": the person and their Slack workspace, in words (qa-onboarding-22).
        label=f"{user} in {team}",
        scopes=_scope_header(resp, "X-OAuth-Scopes"),
    )


def _slack_token_response(data: dict[str, Any]) -> dict[str, Any]:
    """The user token out of ``oauth.v2.access``: under ``authed_user`` for a code, at the
    top level (``token_type: user``) for a refresh. The grant's top-level token is the
    bot's when there is one; it is never used. DMs are never requested."""
    if not data.get("ok", True):
        raise CredentialRejected(f"Slack refused the code ({data.get('error')})")
    user = data.get("authed_user")
    if isinstance(user, dict) and user.get("access_token"):
        return user
    if not user and data.get("token_type") == "user" and data.get("access_token"):
        return data
    raise CredentialRefused(
        "Slack returned no user token for this sign-in, only the app's bot token, which "
        "would read the bot's channels, not yours: sign in again and approve the user "
        "permissions, or connect with a user token (xoxp-)"
    )


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


async def identify_fireflies(
    client: httpx.AsyncClient, token: str, endpoint: str | None = None
) -> Identity:
    """The key's user, asked at ``endpoint`` (the default when None). ``client`` is the
    guarded one in the API (oracle.connections.router.fireflies_http); a redirect to
    another host is refused before the key is sent there."""
    from oracle.sources.connectors import fireflies

    try:
        resp = await fireflies.post(
            client,
            endpoint or fireflies.DEFAULT_ENDPOINT,
            token,
            {"query": "query { user { user_id email name } }"},
        )
    except fireflies.EndpointRefused as e:
        raise CredentialRefused(str(e)) from None
    except httpx.HTTPError as e:
        if fireflies.address_refused(e):
            raise CredentialRefused(fireflies._PRIVATE) from None
        host = httpx.URL(endpoint or fireflies.DEFAULT_ENDPOINT).host
        raise ProviderUnavailable(f"cannot reach {host}") from None
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

# People pick Drive files and folders in Google's Drive picker; a picked folder syncs
# every doc in it, now and later, so Oracle keeps read access to the person's Drive
# (S5, 'Drive folders', owner 2026-10-19). drive.file was asked for briefly before that
# decision; such a grant cannot list a folder's docs, so it is asked to reconnect.
DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"
DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly"
RECONNECT_TO_CHOOSE_FILES = "Reconnect to choose files"


async def _google_scopes(client: httpx.AsyncClient, token: str) -> list[str]:
    """The scopes granted to an access token, or [] when Google does not say. The token
    goes in a POST body, so it never lands in a URL (proxy and access logs)."""
    try:
        resp = await client.post(
            "https://oauth2.googleapis.com/tokeninfo", data={"access_token": token}
        )
    except httpx.HTTPError:
        return []
    if resp.status_code != 200:
        return []
    try:
        data = resp.json()
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    return [s for s in str(data.get("scope") or "").split() if s]


async def identify_google(client: httpx.AsyncClient, token: str) -> Identity:
    resp = await _get(
        client,
        "GET",
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers=_bearer(token),
    )
    _check(resp, "Google")
    data = resp.json()
    return Identity(
        account_id=data["sub"],
        label=data.get("email") or data["sub"],
        scopes=await _google_scopes(client, token),
    )


def reconnect_reason(provider: str, scopes: list[str] | None) -> str | None:
    """Why a working connection should be reconnected: a Google grant without
    drive.readonly cannot read picked folders. Scopes Google did not report (an older
    pasted token) are not judged."""
    if provider == "google" and scopes and DRIVE_READONLY not in scopes:
        return RECONNECT_TO_CHOOSE_FILES
    return None


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
                scopes=["openid", "email", DRIVE_READONLY],
                authorize_params={"access_type": "offline", "prompt": "consent"},
            ),
        ),
    )
}


def get_provider(key: str) -> Provider | None:
    return PROVIDERS.get(key)
