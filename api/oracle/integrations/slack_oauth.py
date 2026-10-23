"""Oracle's Slack app for the company (F6 §4, "Slack poster", decided 2026-10-20).

An owner installs Oracle's existing Slack app once for the company through Slack's OAuth
v2 flow with the bot scopes in :data:`BOT_SCOPES`; the bot token is the company's
credential (``company_integrations``), stored encrypted and never returned. Messages post
as the app, "Product Oracle". Disconnect revokes the token at Slack (``auth.revoke``) and
deletes it. G8's Slack bridge extends this same install with its own scopes; nothing of
that is built here.

The OAuth client is Oracle's Slack app (``ORACLE_OAUTH_SLACK_CLIENT_ID`` and
``_SECRET``, as for people's own Slack connections); its redirect URL
``<ORACLE_OAUTH_REDIRECT_BASE>/v1/company-integrations/slack/callback`` must be registered
with the app. The state value is oracle.connections.oauth's (signed, encrypted, bound to
the owner who started), with :data:`STATE_PROVIDER` so a person's connection callback
cannot take it.
"""

import json
import secrets
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import crypto
from oracle.connections import oauth
from oracle.integrations import slack_api
from oracle.integrations.models import CompanyIntegration

AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"
BOT_SCOPES = (
    "chat:write",
    "chat:write.public",
    "channels:read",
    "groups:read",
    # G8 Slack bridge: who wrote a reply (users.info with the e-mail), and the replies in
    # the threads it starts (Slack sends message.channels / message.groups events only with
    # the history scopes).
    "users:read",
    "users:read.email",
    "channels:history",
    "groups:history",
)
# What mirroring discussions needs beyond F6's install: without it the Slack card asks an
# owner to reconnect, and mirroring stays off.
MIRROR_SCOPES = BOT_SCOPES[3:]
STATE_PROVIDER = "slack-notifications"
PROVIDER, PURPOSE = "slack", "notifications"
TEST_MESSAGE = "Product Oracle will post the weekly alignment report here."
ALREADY_CONNECTED = "Slack is already connected; disconnect it first"
NOT_CONFIGURED = "Slack sign-in for notifications is not configured"
# Channel pages read for the picker (200 channels each).
MAX_CHANNEL_PAGES = 10


def client() -> oauth.Client | None:
    s = oauth.get_oauth_settings()
    if not s.slack_client_id or not s.slack_client_secret:
        return None
    return oauth.Client(s.slack_client_id, s.slack_client_secret)


def redirect_uri() -> str:
    base = oauth.get_oauth_settings().redirect_base.rstrip("/")
    return f"{base}/v1/company-integrations/slack/callback"


def authorize_url(c: oauth.Client, tenant_id: uuid.UUID, user_id: uuid.UUID) -> str:
    state = oauth.encode_state(
        oauth.State(
            tenant_id=tenant_id,
            user_id=user_id,
            provider=STATE_PROVIDER,
            verifier=secrets.token_urlsafe(16),
        )
    )
    params = {
        "client_id": c.client_id,
        "scope": ",".join(BOT_SCOPES),
        "redirect_uri": redirect_uri(),
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


@dataclass(frozen=True)
class Install:
    token: str
    team_id: str
    team_name: str | None
    scopes: list[str]
    bot_user_id: str | None = None


async def exchange_code(http: httpx.AsyncClient, c: oauth.Client, code: str) -> Install:
    body = await slack_api.call(
        http,
        "oauth.v2.access",
        data={
            "client_id": c.client_id,
            "client_secret": c.client_secret,
            "code": code,
            "redirect_uri": redirect_uri(),
        },
    )
    token = body.get("access_token")
    team = body.get("team") or {}
    if not isinstance(token, str) or not token or not team.get("id"):
        raise slack_api.SlackError("Slack returned no bot token for this install")
    scopes = [s for s in str(body.get("scope") or "").split(",") if s]
    bot_user = body.get("bot_user_id")
    return Install(
        token=token,
        team_id=str(team["id"]),
        team_name=team.get("name"),
        scopes=scopes,
        bot_user_id=str(bot_user) if bot_user else None,
    )


def can_mirror(row: CompanyIntegration | None) -> bool:
    """An active install with the bridge's scopes."""
    return (
        row is not None and row.status == "active" and set(MIRROR_SCOPES) <= set(row.scopes or [])
    )


def needs_reconnect(row: CompanyIntegration | None) -> bool:
    return row is not None and row.status == "active" and not can_mirror(row)


# --- the stored credential ---------------------------------------------------------------


def seal(token: str) -> bytes:
    return crypto.encrypt(json.dumps({"access_token": token}).encode())


def token_of(row: CompanyIntegration) -> str:
    return json.loads(crypto.decrypt(row.ciphertext))["access_token"]


async def installed(
    db: AsyncSession, *, for_update: bool = False, with_revoked: bool = False
) -> CompanyIntegration | None:
    """The company's install; a disconnected (``revoked``) one only ``with_revoked`` (the
    callback reuses its row)."""
    stmt = select(CompanyIntegration).where(
        CompanyIntegration.provider == PROVIDER, CompanyIntegration.purpose == PURPOSE
    )
    if not with_revoked:
        stmt = stmt.where(CompanyIntegration.status != "revoked")
    if for_update:
        stmt = stmt.with_for_update()
    return await db.scalar(stmt)


async def revoke(http: httpx.AsyncClient, token: str) -> bool:
    """``auth.revoke`` at Slack; best effort (S5b): False when Slack did not confirm."""
    try:
        await slack_api.call(http, "auth.revoke", token=token)
    except slack_api.SlackError:
        return False
    return True


async def channels(
    http: httpx.AsyncClient, row: CompanyIntegration, *, member_only: bool = False
) -> list[dict[str, Any]]:
    """Public channels, and the private ones the bot was invited to (``groups:read``, in
    :data:`BOT_SCOPES`; an install made without it lists public ones only), by name.
    ``member_only`` keeps the ones the bot is in (G8 mirroring: Slack sends a channel's
    ``message.channels`` events only to apps in it, so replies elsewhere never come back)."""
    types = "public_channel,private_channel" if "groups:read" in row.scopes else "public_channel"
    token = token_of(row)
    out: dict[str, dict[str, Any]] = {}
    cursor = ""
    for _ in range(MAX_CHANNEL_PAGES):
        fields = {"types": types, "exclude_archived": "true", "limit": "200"}
        if cursor:
            fields["cursor"] = cursor
        body = await slack_api.call(http, "conversations.list", token=token, data=fields)
        for ch in body.get("channels") or []:
            if member_only and not (isinstance(ch, dict) and ch.get("is_member")):
                continue
            if isinstance(ch, dict) and ch.get("id") and ch.get("name"):
                out[str(ch["id"])] = {
                    "id": str(ch["id"]),
                    "name": str(ch["name"]),
                    "is_private": bool(ch.get("is_private")),
                }
        cursor = str((body.get("response_metadata") or {}).get("next_cursor") or "")
        if not cursor:
            break
    return sorted(out.values(), key=lambda c: c["name"])


async def post(http: httpx.AsyncClient, row: CompanyIntegration, channel: str, text: str) -> str:
    """Post ``text`` (mrkdwn) to ``channel`` as Product Oracle; returns Slack's ``ts``."""
    body = await slack_api.call(
        http,
        "chat.postMessage",
        token=token_of(row),
        json={"channel": channel, "text": text, "mrkdwn": True, "unfurl_links": False},
    )
    return str(body.get("ts") or "")
