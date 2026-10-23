"""Slack's Events API for Oracle's Slack app (G8 §3.3): ``POST /integrations/slack/events``.

Public (outside IAP, on the load balancer's public path rule, docs/ops-slack-bridge.md)
and outside ``/v1`` and OpenAPI, so it is no MCP tool. Every request is checked against
``ORACLE_SLACK_SIGNING_SECRET`` (``v0=`` HMAC-SHA256 of ``v0:<timestamp>:<body>``, in
constant time, the timestamp within 300 s); anything else is 401 and nothing is stored.

An event resolves its company by the Slack team id (the active install), is processed
once (``slack_events_seen``), and is kept only when it is a reply in a live mirrored
thread: everything else (a channel message, another thread, a DM, Oracle's own posts) is
dropped before its text is read, and nothing of it is stored or logged beyond the event
id. A reply from a member who can write becomes a discussion message (``via: "slack"``);
a viewer and someone who is not a member get a notice only they can see. The answer is
200 within Slack's 3 s whatever happens; failures are logged and audited without text.
"""

import hashlib
import hmac
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.config import get_settings
from oracle.discussions import replies, service
from oracle.discussions.models import Discussion, DiscussionMessage
from oracle.discussions.schemas import DiscussionMessageIn
from oracle.integrations import slack_api, slack_oauth
from oracle.integrations.models import CompanyIntegration
from oracle.members.names import display_name
from oracle.models import Tenant
from oracle.slack.models import DiscussionSlackLink, SlackEventSeen
from oracle.tenancy import tenant_session, unscoped_session

log = logging.getLogger(__name__)

router = APIRouter()

PATH = "/integrations/slack/events"
MAX_AGE_SECONDS = 300
VIEWER_NOTICE = "You can read this discussion in Oracle, but your role cannot write in it."
NOT_MEMBER = "Only {company} members in Oracle can add to this discussion."
DM_TYPES = {"im", "mpim"}
_MENTION = re.compile(r"<@([UW][A-Z0-9]+)(?:\|[^>]*)?>")


def verify(secret: str, timestamp: str, body: bytes, signature: str, now: float) -> bool:
    """Slack's request signature, version 0."""
    if not secret or not timestamp or not signature:
        return False
    try:
        sent = int(timestamp)
    except ValueError:
        return False
    if abs(now - sent) > MAX_AGE_SECONDS:
        return False
    base = b"v0:" + timestamp.encode() + b":" + body
    expected = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


@dataclass
class Reply:
    """The parts of a message event the bridge reads."""

    kind: str  # "new", "changed", "deleted"
    channel: str
    thread_ts: str | None
    ts: str
    user: str | None
    bot_id: str | None
    text: str


def _reply_of(event: dict[str, Any]) -> Reply | None:
    if event.get("type") != "message" or event.get("channel_type") in DM_TYPES:
        return None
    channel = str(event.get("channel") or "")
    subtype = event.get("subtype")
    if subtype == "message_changed":
        inner = event.get("message") or {}
        kind = "changed"
    elif subtype == "message_deleted":
        inner = {**(event.get("previous_message") or {}), "ts": event.get("deleted_ts")}
        kind = "deleted"
    elif subtype in (None, "thread_broadcast"):
        inner, kind = event, "new"
    else:
        return None
    ts = str(inner.get("ts") or "")
    thread_ts = inner.get("thread_ts")
    if not channel or not ts or not thread_ts or thread_ts == ts:
        return None
    return Reply(
        kind=kind,
        channel=channel,
        thread_ts=str(thread_ts),
        ts=ts,
        user=inner.get("user"),
        bot_id=inner.get("bot_id") or event.get("bot_id"),
        text=str(inner.get("text") or ""),
    )


async def _company(team_id: str) -> uuid.UUID | None:
    """The company whose active install is this Slack team (an unscoped lookup, as run
    tokens resolve theirs)."""
    async with unscoped_session() as s:
        return await s.scalar(
            select(CompanyIntegration.tenant_id).where(
                CompanyIntegration.provider == slack_oauth.PROVIDER,
                CompanyIntegration.account_id == team_id,
                CompanyIntegration.status == "active",
            )
        )


class _Slack:
    def __init__(self, http: Any, token: str) -> None:
        self.http, self.token = http, token
        self.emails: dict[str, str | None] = {}

    async def email(self, user: str) -> str | None:
        if user not in self.emails:
            got = await slack_api.call(
                self.http, "users.info", token=self.token, data={"user": user}
            )
            profile = (got.get("user") or {}).get("profile") or {}
            email = profile.get("email")
            self.emails[user] = str(email).strip().lower() if email else None
        return self.emails[user]

    async def ephemeral(self, r: Reply, text: str) -> None:
        await slack_api.call(
            self.http, "chat.postEphemeral", token=self.token,
            json={"channel": r.channel, "user": r.user, "thread_ts": r.thread_ts, "text": text},
        )  # fmt: skip


async def _member(db: AsyncSession, email: str | None) -> User | None:
    if not email:
        return None
    return await db.scalar(
        select(User).where(func.lower(User.email) == email, User.disabled_at.is_(None))
    )


async def _text_and_mentions(
    db: AsyncSession, slack: _Slack, row: CompanyIntegration, text: str
) -> tuple[str, list[uuid.UUID], bool]:
    """Slack mentions as G1 mentions (members only) and ``mention_oracle`` for the app."""
    mentions: list[uuid.UUID] = []
    oracle = False
    names: dict[str, str] = {}
    for slack_user in dict.fromkeys(_MENTION.findall(text)):
        if slack_user == row.bot_user_id:
            oracle = True
            names[slack_user] = "@Oracle"
            continue
        member = await _member(db, await slack.email(slack_user))
        if member is not None:
            mentions.append(member.id)
            names[slack_user] = f"@{display_name(member.email)}"
    body = _MENTION.sub(lambda m: names.get(m.group(1), "@someone"), text).strip()
    return body, mentions, oracle


async def _store(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    row: CompanyIntegration,
    link: DiscussionSlackLink,
    r: Reply,
    slack: _Slack,
) -> str:
    """One reply in a mirrored thread; what happened (for the audit, never the text)."""
    d = await db.get(Discussion, link.discussion_id, with_for_update=True)
    if d is None or d.visibility != "open":
        return "dropped"
    if r.kind in ("changed", "deleted"):
        message = await db.scalar(
            select(DiscussionMessage).where(
                DiscussionMessage.discussion_id == d.id,
                DiscussionMessage.via == "slack",
                DiscussionMessage.slack_ts == r.ts,
                DiscussionMessage.deleted_at.is_(None),
            )
        )
        if message is None:
            return "dropped"
        if r.kind == "deleted":
            message.body, message.deleted_at = "", datetime.now(UTC)
            return "deleted"
        body, _mentions, _oracle = await _text_and_mentions(db, slack, row, r.text)
        if body:
            message.body = body[: service.MAX_BODY]
            message.edited_at = datetime.now(UTC)
        return "edited"
    user = await _member(db, await slack.email(r.user)) if r.user else None
    if user is None:
        tenant = await db.get(Tenant, tenant_id)
        await slack.ephemeral(r, NOT_MEMBER.format(company=tenant.name if tenant else "company"))
        return "not_member"
    if not has_role(user.role, "commenter"):
        await slack.ephemeral(r, VIEWER_NOTICE)
        return "viewer"
    if d.status == "closed":
        return "dropped"
    body, mentions, oracle = await _text_and_mentions(db, slack, row, r.text)
    if not body:
        return "dropped"
    principal = Principal(tenant_id=tenant_id, kind="user", role=user.role, user_id=user.id)  # type: ignore[arg-type]
    parts = await service._participants(db, d)
    seat = await service._seat(db, principal, d, parts)
    said = DiscussionMessageIn(
        body=body[: service.MAX_BODY], mentions=mentions, mention_oracle=oracle
    )
    message = await service._post(db, principal, d, parts, seat, said, "slack")
    message.slack_ts, message.slack_user_id = r.ts, r.user
    await db.flush()
    if await replies.wants_reply(db, d, message):
        try:
            await replies.ask(db, d, message)
        except replies.ReplyLimited:
            pass
    return "stored"


async def handle(tenant_id: uuid.UUID, event_id: str, event: dict[str, Any]) -> str:
    """Process one event for its company: once, and only a reply in a live mirrored
    thread. Returns what happened."""
    async with tenant_session(tenant_id) as db:
        seen = await db.execute(
            insert(SlackEventSeen)
            .values(event_id=event_id, tenant_id=tenant_id)
            .on_conflict_do_nothing(index_elements=["event_id"])
            .returning(SlackEventSeen.event_id)
        )
        if seen.first() is None:
            return "repeat"
        await db.commit()
        r = _reply_of(event)
        if r is None:
            return "ignored"
        link = await db.scalar(
            select(DiscussionSlackLink).where(
                DiscussionSlackLink.channel_id == r.channel,
                DiscussionSlackLink.thread_ts == r.thread_ts,
                DiscussionSlackLink.unlinked_at.is_(None),
            )
        )
        if link is None:
            return "ignored"
        row = await slack_oauth.installed(db)
        if row is None or row.status != "active":
            return "ignored"
        # No echo: Oracle's own posts never come back as messages.
        if r.bot_id or (r.user and r.user == row.bot_user_id) or not r.user:
            return "ignored"
        async with slack_api.http_client() as http:
            slack = _Slack(http, slack_oauth.token_of(row))
            outcome = await _store(db, tenant_id, row, link, r, slack)
        await db.commit()
        return outcome


@router.post(PATH, include_in_schema=False)
async def slack_events(request: Request) -> dict[str, Any]:
    body = await request.body()
    ok = verify(
        get_settings().slack_signing_secret,
        request.headers.get("x-slack-request-timestamp", ""),
        body,
        request.headers.get("x-slack-signature", ""),
        time.time(),
    )
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not a signed Slack request")
    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        return {}
    if not isinstance(payload, dict):
        return {}
    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge")}
    if payload.get("type") != "event_callback":
        return {}
    event_id = str(payload.get("event_id") or "")
    team_id = str(payload.get("team_id") or "")
    event = payload.get("event")
    if not event_id or not team_id or not isinstance(event, dict):
        return {}
    tenant_id = await _company(team_id)
    if tenant_id is None:
        return {}
    try:
        await handle(tenant_id, event_id, event)
    except Exception as e:
        log.warning("slack events: event %s failed (%s)", event_id, type(e).__name__)
        try:
            async with tenant_session(tenant_id) as db:
                await audit.record(
                    db, None, "slack.event_failed", "slack_event", None,
                    {"event_id": event_id, "error": type(e).__name__},
                )  # fmt: skip
                await db.commit()
        except Exception:
            log.exception("slack events: could not audit event %s", event_id)
    return {}
