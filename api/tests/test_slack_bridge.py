# ruff: noqa: F811 - fixtures are imported
"""G8 Slack bridge: an open discussion mirrored to a Slack thread through Oracle's Slack app,
and replies in that thread back into the discussion.

Slack is faked with an ``httpx.MockTransport`` (``oracle.integrations.slack_api``); the real
Slack API is never called. Events are signed with a test signing secret.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from sqlalchemy import select, update

from oracle.connections import oauth
from oracle.discussions.models import DiscussionMessage
from oracle.integrations import slack_api
from oracle.integrations.models import CompanyIntegration
from oracle.models import AuditEvent
from oracle.slack import bridge, events, outbox
from oracle.slack.models import DiscussionSlackLink, SlackOutbox
from oracle.sources import base, service
from oracle.sources.base import ORACLE_SLACK_USERS
from oracle.tenancy import tenant_session
from tests.sources_helpers import FakeConnector, make_connection
from tests.test_discussion_replies import fake, with_key  # noqa: F401
from tests.test_discussions import company, get, patch, section, start, uid
from tests.test_mcp import mcp_client, user_token
from tests.test_run_ticker import PATH as TICK
from tests.test_run_ticker import bearer, id_token, ticker_on  # noqa: F401

SECRET = "test-signing-secret-0123"
TOKEN = "xoxb-fake-bridge-token-0123456789"
BOT = "U0ORACLEBOT"
TEAM = "T0EXAMPLE"
EVENTS = events.PATH
CHANNEL = "C0PRODUCT"
QUIET = "Caps can ship in one sprint if detection waits."
SCOPES = "chat:write,chat:write.public,channels:read,groups:read,users:read,users:read.email,channels:history,groups:history"  # noqa: E501
F6_SCOPES = "chat:write,chat:write.public,channels:read,groups:read"


class FakeSlack:
    """Slack's Web API: records every call; answers from per-method queues, else OK."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.answers: dict[str, list[httpx.Response]] = {}
        self.scopes = SCOPES
        # Slack user id -> e-mail (users.info with users:read.email).
        self.emails: dict[str, str] = {}
        self._ts = 0

    def next_ts(self) -> str:
        self._ts += 1
        return f"1761490812.{self._ts:06d}"

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "slack.com", request.url
        method = request.url.path.rsplit("/", 1)[-1]
        raw = request.content.decode()
        if request.headers.get("content-type", "").startswith("application/json"):
            body = json.loads(raw or "{}")
        else:
            body = {k: v[0] for k, v in parse_qs(raw).items()}
        self.calls.append((method, body))
        if self.answers.get(method):
            return self.answers[method].pop(0)
        if method == "oauth.v2.access":
            return httpx.Response(200, json={
                "ok": True, "access_token": TOKEN, "token_type": "bot", "scope": self.scopes,
                "bot_user_id": BOT, "app_id": "A0ORACLE",
                "team": {"id": TEAM, "name": "Example Co"},
            })  # fmt: skip
        if method == "conversations.list":
            return httpx.Response(200, json={"ok": True, "channels": [
                {"id": CHANNEL, "name": "product", "is_private": False},
                {"id": "G0LEADS", "name": "leads", "is_private": True},
            ], "response_metadata": {"next_cursor": ""}})  # fmt: skip
        if method == "chat.postMessage":
            return httpx.Response(200, json={"ok": True, "ts": self.next_ts()})
        if method in ("chat.update", "chat.delete", "chat.postEphemeral", "auth.revoke"):
            return httpx.Response(200, json={"ok": True})
        if method == "users.info":
            email = self.emails.get(body.get("user", ""))
            profile = {"email": email} if email else {}
            return httpx.Response(200, json={"ok": True, "user": {"id": body.get("user"),
                                                                  "profile": profile}})  # fmt: skip
        return httpx.Response(404, json={"ok": False, "error": "unknown_method"})

    def of(self, method: str) -> list[dict]:
        return [body for m, body in self.calls if m == method]


@pytest.fixture
def slack(monkeypatch):
    monkeypatch.setenv("ORACLE_OAUTH_SLACK_CLIENT_ID", "slack-client")
    monkeypatch.setenv("ORACLE_OAUTH_SLACK_CLIENT_SECRET", "slack-secret")
    monkeypatch.setenv("ORACLE_OAUTH_REDIRECT_BASE", "https://oracle.example.com")
    monkeypatch.setenv("ORACLE_APP_URL", "https://oracle.example.com")
    monkeypatch.setenv("ORACLE_SLACK_SIGNING_SECRET", SECRET)
    from oracle.config import get_settings

    get_settings.cache_clear()
    oauth.get_oauth_settings.cache_clear()
    fake_slack = FakeSlack()
    previous = slack_api.set_transport(httpx.MockTransport(fake_slack.handler))
    yield fake_slack
    slack_api.set_transport(previous)
    oauth.get_oauth_settings.cache_clear()
    get_settings.cache_clear()


async def install(client, ctx) -> dict:
    auth = ctx.as_("owner")
    resp = await client.get("/v1/company-integrations/slack/install", headers=auth)
    assert resp.status_code == 200, resp.text
    query = parse_qs(urlparse(resp.json()["url"]).query)
    assert set(SCOPES.split(",")) <= set(query["scope"][0].split(","))
    resp = await client.get(
        "/v1/company-integrations/slack/callback",
        params={"state": query["state"][0], "code": "code-1"},
        headers=auth,
    )
    assert resp.status_code == 303, resp.text
    (row,) = (await client.get("/v1/company-integrations", headers=auth)).json()
    return row


def signed(body: bytes, *, at: float | None = None, secret: str = SECRET) -> dict[str, str]:
    ts = str(int(at if at is not None else time.time()))
    sig = hmac.new(secret.encode(), b"v0:" + ts.encode() + b":" + body, hashlib.sha256)
    return {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": "v0=" + sig.hexdigest(),
        "Content-Type": "application/json",
    }


def envelope(event: dict, event_id: str | None = None) -> bytes:
    return json.dumps({
        "type": "event_callback", "team_id": TEAM,
        "event_id": event_id or f"Ev{uuid.uuid4().hex[:10].upper()}", "event": event,
    }).encode()  # fmt: skip


async def send(client, event: dict, event_id: str | None = None) -> httpx.Response:
    body = envelope(event, event_id)
    return await client.post(EVENTS, content=body, headers=signed(body))


def reply_event(thread_ts: str, user: str, text: str, ts: str = "1761490900.000100", **extra):
    return {"type": "message", "channel": CHANNEL, "channel_type": "channel", "user": user,
            "text": text, "ts": ts, "thread_ts": thread_ts, **extra}  # fmt: skip


async def mirrored(client, ctx, slack, **body) -> tuple[dict, str]:
    """Slack installed, an open discussion mirrored to #product, its root posted."""
    await install(client, ctx)
    _, doc = ctx_doc[ctx.tenant_id]
    d = await start(client, ctx, subject=section(doc), message={"body": "First thought."}, **body)
    resp = await client.post(
        f"/v1/discussions/{d['id']}/slack",
        json={"channel_id": CHANNEL},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json() == {"channel_name": "product", "thread_url": None, "status": "posting",
                           "error": None}  # fmt: skip
    await outbox.tick(ctx.tenant_id)
    link = await live_link(ctx, d["id"])
    assert link is not None and link.thread_ts
    return d, link.thread_ts


ctx_doc: dict = {}


async def setup(client):
    ctx, doc = await company(client)
    ctx_doc[ctx.tenant_id] = (ctx, doc)
    return ctx, doc


async def live_link(ctx, d_id) -> DiscussionSlackLink | None:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(
            select(DiscussionSlackLink).where(
                DiscussionSlackLink.discussion_id == uuid.UUID(d_id),
                DiscussionSlackLink.unlinked_at.is_(None),
            )
        )


async def outbox_items(ctx) -> list[SlackOutbox]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(await s.scalars(select(SlackOutbox).order_by(SlackOutbox.created_at)))


async def slack_messages(ctx, d_id) -> list[DiscussionMessage]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(DiscussionMessage).where(
                    DiscussionMessage.discussion_id == uuid.UUID(d_id),
                    DiscussionMessage.via == "slack",
                    DiscussionMessage.author_kind == "person",
                )
            )
        )


# --- units ----------------------------------------------------------------------------------


# protects=the signature check (card: signature and replay): only a request signed with the
# secret and at most 300 s old passes; fails_when=a bad, empty or old signature passes;
# no_claim=Slack's own delivery guarantees.
def test_signature_good_bad_and_old():
    body = b'{"type":"event_callback"}'
    now = time.time()
    headers = signed(body, at=now)
    ts, sig = headers["X-Slack-Request-Timestamp"], headers["X-Slack-Signature"]
    assert events.verify(SECRET, ts, body, sig, now)
    assert not events.verify(SECRET, ts, body + b" ", sig, now)
    assert not events.verify("another-secret", ts, body, sig, now)
    assert not events.verify("", ts, body, sig, now)
    assert not events.verify(SECRET, ts, body, sig, now + 301)
    assert events.verify(SECRET, ts, body, sig, now + 299)


# protects=splitting and the backoff schedule; fails_when=a post over 3,000 characters goes
# whole, or the waits are not 1, 5, 30 minutes then hourly; no_claim=Slack's own limits.
def test_text_splitting_and_backoff():
    assert bridge.split("short") == ["short"]
    long = ("word " * 1300).strip()
    parts = bridge.split(long)
    assert len(parts) == 3 and all(len(p) <= 3000 for p in parts)
    assert " ".join(parts) == long
    assert [outbox.backoff(n).total_seconds() / 60 for n in (1, 2, 3, 4, 9)] == [1, 5, 30, 60, 60]
    assert bridge.escape("<@U1> & <!channel>") == "&lt;@U1&gt; &amp; &lt;!channel&gt;"


# --- events ---------------------------------------------------------------------------------


# protects=criterion 1 (card: signature and replay): a bad signature or a 301 s old one is
# 401 and stores nothing; url_verification answers its challenge; fails_when=an unsigned or
# old event is processed; no_claim=Slack's retries.
async def test_unsigned_or_old_events_are_refused(client, slack):
    ctx, _doc = await setup(client)
    d, thread = await mirrored(client, ctx, slack)
    slack.emails["U0COMM"] = "commenter@example.com"
    body = envelope(reply_event(thread, "U0COMM", QUIET))
    bad = {**signed(body), "X-Slack-Signature": "v0=" + "0" * 64}
    assert (await client.post(EVENTS, content=body, headers=bad)).status_code == 401
    old = signed(body, at=time.time() - 301)
    assert (await client.post(EVENTS, content=body, headers=old)).status_code == 401
    unsigned = {"Content-Type": "application/json"}
    assert (await client.post(EVENTS, content=body, headers=unsigned)).status_code == 401
    assert await slack_messages(ctx, d["id"]) == []
    hello = json.dumps({"type": "url_verification", "challenge": "abc123"}).encode()
    resp = await client.post(EVENTS, content=hello, headers=signed(hello))
    assert resp.status_code == 200 and resp.json() == {"challenge": "abc123"}


# protects=criteria 2 and 3: a commenter's signed reply becomes one message via Slack,
# attributed to them, in one request answered 200 under 3 s; the same event_id again adds
# nothing; fails_when=a retry duplicates it, or it is attributed to anyone else;
# no_claim=Slack's latency.
async def test_a_commenters_reply_becomes_one_message_once(client, slack):
    ctx, _doc = await setup(client)
    d, thread = await mirrored(client, ctx, slack)
    slack.emails["U0COMM"] = "Commenter@Example.com"
    started = time.monotonic()
    resp = await send(client, reply_event(thread, "U0COMM", QUIET), event_id="Ev0001")
    assert resp.status_code == 200 and time.monotonic() - started < 3
    again = await send(client, reply_event(thread, "U0COMM", QUIET), event_id="Ev0001")
    assert again.status_code == 200
    (m,) = await slack_messages(ctx, d["id"])
    assert m.author_id == ctx.users["commenter"].id and m.body == QUIET
    assert m.slack_user_id == "U0COMM" and m.slack_ts == "1761490900.000100"
    listed = await client.get(f"/v1/discussions/{d['id']}/messages", headers=ctx.as_("viewer"))
    assert [x["via"] for x in listed.json()["items"]][-1] == "slack"
    # Its own message never goes back to Slack.
    await outbox.tick(ctx.tenant_id)
    assert [i.op for i in await outbox_items(ctx)] == ["root"]


# protects=edits and deletes in Slack edit or delete the Oracle message; fails_when=the
# message keeps the old text; no_claim=Slack's edit window.
async def test_edits_and_deletes_follow_slack(client, slack):
    ctx, _doc = await setup(client)
    d, thread = await mirrored(client, ctx, slack)
    slack.emails["U0COMM"] = "commenter@example.com"
    await send(client, reply_event(thread, "U0COMM", QUIET))
    changed = {"type": "message", "subtype": "message_changed", "channel": CHANNEL,
               "channel_type": "channel", "message": reply_event(thread, "U0COMM", "Two sprints.")}  # fmt: skip  # noqa: E501
    await send(client, changed)
    (m,) = await slack_messages(ctx, d["id"])
    assert m.body == "Two sprints." and m.edited_at is not None
    deleted = {"type": "message", "subtype": "message_deleted", "channel": CHANNEL,
               "channel_type": "channel", "deleted_ts": "1761490900.000100",
               "previous_message": reply_event(thread, "U0COMM", "Two sprints.")}  # fmt: skip
    await send(client, deleted)
    (m,) = await slack_messages(ctx, d["id"])
    assert m.deleted_at is not None and m.body == ""


# protects=criterion 4: a reply mentioning the app creates a pending Oracle reply; the next
# tick completes it and queues one post, delivered with the link's thread_ts; fails_when=no
# reply, two posts, or a post outside the thread; no_claim=the model's answer.
async def test_mentioning_oracle_gets_a_reply_posted_in_the_thread(client, slack, fake, ticker_on):
    ctx, _doc = await setup(client)
    await with_key(ctx)
    d, thread = await mirrored(client, ctx, slack)
    # Two people in it, so Oracle answers only when addressed.
    await client.post(
        f"/v1/discussions/{d['id']}/participants",
        json={"user_ids": [uid(ctx, "approver")]},
        headers=ctx.as_("commenter"),
    )
    slack.emails["U0COMM"] = "commenter@example.com"
    await send(client, reply_event(thread, "U0COMM", f"<@{BOT}> is caps one sprint?"))
    async with tenant_session(ctx.tenant_id) as s:
        (reply,) = await s.scalars(
            select(DiscussionMessage).where(
                DiscussionMessage.discussion_id == uuid.UUID(d["id"]),
                DiscussionMessage.author_kind == "oracle",
            )
        )
        asked = await s.get(DiscussionMessage, reply.reply_to)
        assert reply.status == "pending" and asked.mentions_oracle
        assert asked.body == "@Oracle is caps one sprint?"
        await s.execute(
            update(DiscussionMessage)
            .where(DiscussionMessage.id == reply.id)
            .values(created_at=datetime.now(UTC) - timedelta(seconds=11))
        )
        # The thread was mirrored before the question was asked (and after the first
        # message, which is never copied).
        await s.execute(
            update(DiscussionSlackLink)
            .where(DiscussionSlackLink.discussion_id == uuid.UUID(d["id"]))
            .values(created_at=datetime.now(UTC) - timedelta(seconds=20))
        )
        await s.execute(
            update(DiscussionMessage)
            .where(
                DiscussionMessage.discussion_id == uuid.UUID(d["id"]),
                DiscussionMessage.id.not_in([reply.id, asked.id]),
            )
            .values(created_at=datetime.now(UTC) - timedelta(seconds=30))
        )
        await s.execute(
            update(DiscussionMessage)
            .where(DiscussionMessage.id == asked.id)
            .values(created_at=datetime.now(UTC) - timedelta(seconds=12))
        )
        await s.commit()
    slack.calls.clear()
    resp = await client.post(TICK, headers=bearer(id_token()))
    assert resp.status_code == 200, resp.text
    assert resp.json()["discussion_replies"]["completed"] == 1
    posts = [i for i in await outbox_items(ctx) if i.op == "post"]
    assert len(posts) == 1 and posts[0].status == "sent"
    (sent,) = slack.of("chat.postMessage")
    assert sent["thread_ts"] == thread and sent["text"].startswith("*Oracle*: ")


# protects=criterion 5 (card: roles from Slack): a viewer's and a non-member's replies are
# not stored, and each author gets one ephemeral notice with 3.1's copy; fails_when=either
# is stored or told nothing; no_claim=Slack's channel membership.
async def test_viewers_and_non_members_are_told_privately(client, slack):
    ctx, _doc = await setup(client)
    d, thread = await mirrored(client, ctx, slack)
    slack.emails["U0VIEW"] = "viewer@example.com"
    slack.emails["U0GUEST"] = "guest@elsewhere.example"
    await send(client, reply_event(thread, "U0VIEW", "Viewer's take.", ts="1761490901.000001"))
    await send(client, reply_event(thread, "U0GUEST", "Guest's take.", ts="1761490901.000002"))
    assert await slack_messages(ctx, d["id"]) == []
    notices = slack.of("chat.postEphemeral")
    assert [(n["user"], n["text"]) for n in notices] == [
        ("U0VIEW", "You can read this discussion in Oracle, but your role cannot write in it."),
        ("U0GUEST", "Only Example Co members in Oracle can add to this discussion."),
    ]
    assert all(n["thread_ts"] == thread for n in notices)


# protects=criterion 6 (card: echo and laundering): Oracle's own posts, DMs and messages
# outside a live mirrored thread store nothing and leave no text in audit; fails_when=the
# bot's message comes back or a channel message is read; no_claim=other apps' bots.
async def test_own_posts_dms_and_other_messages_are_ignored(client, slack):
    ctx, _doc = await setup(client)
    d, thread = await mirrored(client, ctx, slack)
    slack.emails["U0COMM"] = "commenter@example.com"
    secret = "Unrelated channel chatter 7731"
    await send(client, reply_event(thread, BOT, secret, ts="1761490902.000001"))
    await send(client, reply_event(thread, "U0COMM", secret, ts="1761490902.000002", bot_id="B0X"))
    await send(client, {**reply_event(thread, "U0COMM", secret, ts="1761490902.000003"),
                        "channel_type": "im"})  # fmt: skip
    await send(client, {"type": "message", "channel": CHANNEL, "channel_type": "channel",
                        "user": "U0COMM", "text": secret, "ts": "1761490902.000004"})  # fmt: skip
    await send(client, reply_event("1761490000.000001", "U0COMM", secret, ts="1761490902.000005"))
    assert await slack_messages(ctx, d["id"]) == []
    assert slack.of("users.info") == [] and slack.of("chat.postEphemeral") == []
    async with tenant_session(ctx.tenant_id) as s:
        audits = list(await s.scalars(select(AuditEvent)))
    assert not any(secret in json.dumps(a.data or {}) for a in audits)


# --- mirroring ------------------------------------------------------------------------------


# protects=criterion 7: a private discussion is refused with 422; making a mirrored one
# private queues a close without the link and unlinks it; after its starter makes a private
# one open, mirroring answers 201; fails_when=a private discussion mirrors or the title
# reaches the channel on close; no_claim=the screens.
async def test_private_discussions_stay_in_oracle(client, slack):
    ctx, doc = await setup(client)
    d, _thread = await mirrored(client, ctx, slack)
    root = slack.of("chat.postMessage")[0]
    assert "Open in Oracle" in root["text"] and "First thought." in root["text"]
    got = await get(client, ctx, d["id"], "viewer")
    assert got["slack"]["channel_name"] == "product" and got["slack"]["status"] == "live"
    assert got["slack"]["thread_url"].startswith(f"https://slack.com/archives/{CHANNEL}/p")
    await patch(client, ctx, d["id"], "commenter", visibility="private")
    assert await live_link(ctx, d["id"]) is None
    close = [i for i in await outbox_items(ctx) if i.op == "close"]
    assert len(close) == 1 and close[0].payload["text"] == "This discussion is no longer mirrored."
    await outbox.tick(ctx.tenant_id)
    assert slack.of("chat.postMessage")[-1]["text"] == "This discussion is no longer mirrored."
    resp = await client.post(
        f"/v1/discussions/{d['id']}/slack",
        json={"channel_id": CHANNEL},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422 and resp.json()["detail"] == "Private discussions stay in Oracle"
    exposes = (await get(client, ctx, d["id"], "commenter"))["exposure"]
    await patch(client, ctx, d["id"], "commenter", visibility="open", exposes=exposes)
    resp = await client.post(
        f"/v1/discussions/{d['id']}/slack",
        json={"channel_id": CHANNEL},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 201, resp.text
    again = await client.post(
        f"/v1/discussions/{d['id']}/slack",
        json={"channel_id": CHANNEL},
        headers=ctx.as_("approver"),
    )
    assert again.status_code == 409 and again.json()["detail"] == "Already mirrored to #product"


# protects=who mirrors and the status every member reads; fails_when=a viewer or another
# commenter mirrors, or an F6-only install claims mirroring; no_claim=the screens.
async def test_who_mirrors_and_the_status(client, slack):
    ctx, doc = await setup(client)
    status = await client.get("/v1/company-integrations/slack/status", headers=ctx.as_("viewer"))
    assert status.json() == {"connected": False, "label": None, "mirroring": False,
                             "needs_reconnect": False}  # fmt: skip
    slack.scopes = F6_SCOPES
    await install(client, ctx)
    status = await client.get("/v1/company-integrations/slack/status", headers=ctx.as_("viewer"))
    assert status.json()["needs_reconnect"] is True and status.json()["mirroring"] is False
    d = await start(client, ctx, subject=section(doc))
    resp = await client.post(
        f"/v1/discussions/{d['id']}/slack",
        json={"channel_id": CHANNEL},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Reconnect Slack to allow mirroring discussions"
    slack.scopes = SCOPES
    await install(client, ctx)  # the owner reconnects with the bridge's scopes
    status = await client.get("/v1/company-integrations/slack/status", headers=ctx.as_("viewer"))
    assert status.json() == {"connected": True, "label": "Example Co", "mirroring": True,
                             "needs_reconnect": False}  # fmt: skip
    channels = await client.get(
        "/v1/company-integrations/slack/channels", headers=ctx.as_("commenter")
    )
    assert [c["name"] for c in channels.json()] == ["leads", "product"]
    viewer = await client.post(
        f"/v1/discussions/{d['id']}/slack", json={"channel_id": CHANNEL}, headers=ctx.as_("viewer")
    )
    assert viewer.status_code == 403
    other = await start(client, ctx, who="approver", subject=section(doc, key="users"))
    resp = await client.post(
        f"/v1/discussions/{other['id']}/slack", json={"channel_id": CHANNEL},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 403
    resp = await client.delete(f"/v1/discussions/{d['id']}/slack", headers=ctx.as_("commenter"))
    assert resp.status_code == 404


# protects=new Oracle messages are posted in the thread with the author's name, and Stop
# mirroring posts the closing line with the link; fails_when=earlier messages are copied or
# a post goes after Stop; no_claim=Slack's rendering.
async def test_new_messages_post_in_the_thread_until_stopped(client, slack):
    ctx, _doc = await setup(client)
    d, thread = await mirrored(client, ctx, slack)
    resp = await client.post(
        f"/v1/discussions/{d['id']}/messages",
        json={"body": "Second <thought>"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201
    await outbox.tick(ctx.tenant_id)
    root, post = slack.of("chat.postMessage")
    assert post == {"channel": CHANNEL, "text": "*Approver* in Oracle: Second &lt;thought&gt;",
                    "mrkdwn": True, "unfurl_links": False, "thread_ts": thread}  # fmt: skip
    resp = await client.delete(f"/v1/discussions/{d['id']}/slack", headers=ctx.as_("approver"))
    assert resp.status_code == 204
    await client.post(f"/v1/discussions/{d['id']}/messages",
                      json={"body": "After the stop"}, headers=ctx.as_("approver"))  # fmt: skip
    await outbox.tick(ctx.tenant_id)
    *_, closing = slack.of("chat.postMessage")
    assert closing["text"].startswith("This discussion is no longer mirrored. Continue in Oracle: ")
    assert f"discussion={d['id']}" in closing["text"]
    assert not any("After the stop" in c["text"] for c in slack.of("chat.postMessage"))
    assert (await get(client, ctx, d["id"], "viewer"))["slack"] is None


# protects=criterion 8: a 429 with Retry-After 30 is not retried before 30 s; after 24 h of
# failures the item is failed, and after 3 in a row the discussion shows it failing;
# fails_when=Slack is hammered or an item retries forever; no_claim=Slack's limits.
async def test_rate_limits_wait_and_failures_give_up(client, slack):
    ctx, _doc = await setup(client)
    await install(client, ctx)
    d = await start(client, ctx, subject=section(ctx_doc[ctx.tenant_id][1]))
    resp = await client.post(
        f"/v1/discussions/{d['id']}/slack",
        json={"channel_id": CHANNEL},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 201
    slack.answers["chat.postMessage"] = [
        httpx.Response(429, headers={"Retry-After": "30"}, json={"ok": False})
    ]
    now = datetime.now(UTC)
    await outbox.tick(ctx.tenant_id, now=now)
    (item,) = await outbox_items(ctx)
    assert item.status == "queued" and item.attempts == 1 and item.error == "ratelimited"
    assert item.next_try_at >= now + timedelta(seconds=30)
    await outbox.tick(ctx.tenant_id, now=now + timedelta(seconds=29))
    assert len(slack.of("chat.postMessage")) == 1
    slack.answers["chat.postMessage"] = [
        httpx.Response(200, json={"ok": False, "error": "channel_not_found"}) for _ in range(3)
    ]
    for minutes in (1, 3, 10):
        await outbox.tick(ctx.tenant_id, now=now + timedelta(minutes=minutes))
    (item,) = await outbox_items(ctx)
    assert item.attempts == 3 and item.status == "queued"
    got = await get(client, ctx, d["id"], "commenter")
    assert got["slack"]["status"] == "failing" and got["slack"]["error"] == "channel_not_found"
    slack.answers["chat.postMessage"] = [
        httpx.Response(200, json={"ok": False, "error": "channel_not_found"})
    ]
    await outbox.tick(ctx.tenant_id, now=now + timedelta(hours=24, minutes=1))
    (item,) = await outbox_items(ctx)
    assert item.status == "failed"


async def mirror_to(client, ctx, d_id: str) -> None:
    resp = await client.post(
        f"/v1/discussions/{d_id}/slack", json={"channel_id": CHANNEL}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 201, resp.text


async def queue_posts(ctx, d_id: str, n: int) -> None:
    """``n`` posts queued for the discussion's live link (made-up text)."""
    link = await live_link(ctx, d_id)
    assert link is not None
    async with tenant_session(ctx.tenant_id) as s:
        for i in range(n):
            s.add(SlackOutbox(tenant_id=ctx.tenant_id, link_id=link.id, op="post",
                              payload={"text": f"Queued line {i}"}))  # fmt: skip
        await s.commit()


# protects=review #431 item 1: one mirror whose root post waits (backing off) with a full
# batch of posts behind it does not stop another discussion's mirror; fails_when=delivery
# takes the oldest items whatever their next try and holds them, so nothing else is sent;
# no_claim=Slack's ordering.
async def test_a_waiting_mirror_does_not_stop_the_others(client, slack):
    ctx, doc = await setup(client)
    await install(client, ctx)
    stuck = await start(client, ctx, subject=section(doc), message={"body": "Stuck one."})
    await mirror_to(client, ctx, stuck["id"])
    slack.answers["chat.postMessage"] = [
        httpx.Response(200, json={"ok": False, "error": "not_in_channel"})
    ]
    now = datetime.now(UTC)
    await outbox.tick(ctx.tenant_id, now=now)
    await queue_posts(ctx, stuck["id"], outbox.BATCH + 5)
    other = await start(client, ctx, subject=section(doc), message={"body": "Other one."})
    await mirror_to(client, ctx, other["id"])
    await outbox.tick(ctx.tenant_id, now=now + timedelta(seconds=10))
    link = await live_link(ctx, other["id"])
    assert link is not None and link.thread_ts
    assert (await get(client, ctx, other["id"], "commenter"))["slack"]["status"] == "live"
    # The stuck root was not due: it was not tried again.
    assert len(slack.of("chat.postMessage")) == 2


# protects=review #431 item 1: a root post that gives up marks its mirror failed and fails
# the posts queued behind it, with Slack's reason on the discussion; the other mirrors keep
# flowing; fails_when=the posts stay queued forever or the starter is not told why;
# no_claim=a retry of the failed mirror (Stop mirroring, then Mirror again).
async def test_a_failed_root_post_fails_its_mirror_only(client, slack):
    ctx, doc = await setup(client)
    await install(client, ctx)
    stuck = await start(client, ctx, subject=section(doc), message={"body": "Stuck one."})
    await mirror_to(client, ctx, stuck["id"])
    no_channel = httpx.Response(200, json={"ok": False, "error": "not_in_channel"})
    slack.answers["chat.postMessage"] = [no_channel]
    now = datetime.now(UTC)
    await outbox.tick(ctx.tenant_id, now=now)
    await queue_posts(ctx, stuck["id"], 3)
    other = await start(client, ctx, subject=section(doc), message={"body": "Other one."})
    await mirror_to(client, ctx, other["id"])
    slack.answers["chat.postMessage"] = [no_channel]
    await outbox.tick(ctx.tenant_id, now=now + timedelta(hours=24, minutes=1))
    link = await live_link(ctx, stuck["id"])
    assert link is not None and link.failed_at is not None and link.error == "not_in_channel"
    items = [i for i in await outbox_items(ctx) if i.link_id == link.id]
    assert [i.status for i in items] == ["failed"] * 4
    assert {i.error for i in items} == {"not_in_channel"}
    got = await get(client, ctx, stuck["id"], "commenter")
    assert got["slack"]["status"] == "failed" and got["slack"]["error"] == "not_in_channel"
    other_link = await live_link(ctx, other["id"])
    assert other_link is not None and other_link.thread_ts
    # New messages of the failed mirror are not queued for it any more.
    await client.post(f"/v1/discussions/{stuck['id']}/messages",
                      json={"body": "After it failed"}, headers=ctx.as_("approver"))  # fmt: skip
    await outbox.tick(ctx.tenant_id, now=now + timedelta(hours=25))
    assert not any("After it failed" in c["text"] for c in slack.of("chat.postMessage"))
    assert all(i.status != "queued" for i in await outbox_items(ctx) if i.link_id == link.id)
    # Stop mirroring still works, so the starter can mirror again to another channel.
    resp = await client.delete(f"/v1/discussions/{stuck['id']}/slack", headers=ctx.as_("approver"))
    assert resp.status_code == 204
    assert (await get(client, ctx, stuck["id"], "commenter"))["slack"] is None


# protects=criterion 9: Disconnect posts a closing line to every mirrored thread, calls
# auth.revoke, unlinks and sets the install ``revoked`` (its row and ``bot_user_id`` kept, no
# credential left); a reconnect makes the same row active again; fails_when=a thread is left
# open, the token stays, or the row is deleted; no_claim=Slack's revoke.
async def test_disconnect_closes_every_mirror_then_revokes(client, slack):
    ctx, _doc = await setup(client)
    d, thread = await mirrored(client, ctx, slack)
    (row,) = (await client.get("/v1/company-integrations", headers=ctx.as_("owner"))).json()
    resp = await client.delete(f"/v1/company-integrations/{row['id']}", headers=ctx.as_("owner"))
    assert resp.status_code == 204, resp.text
    methods = [m for m, _ in slack.calls]
    assert methods[-2:] == ["chat.postMessage", "auth.revoke"]
    closing = slack.of("chat.postMessage")[-1]
    assert closing["thread_ts"] == thread
    assert closing["text"].startswith("This discussion is no longer mirrored. Continue in Oracle")
    assert await live_link(ctx, d["id"]) is None
    async with tenant_session(ctx.tenant_id) as s:
        (kept,) = list(await s.scalars(select(CompanyIntegration)))
    assert str(kept.id) == row["id"]
    assert kept.status == "revoked" and kept.bot_user_id == BOT
    assert TOKEN.encode() not in kept.ciphertext and not kept.ciphertext
    # Settings shows it disconnected, and nothing uses it any more.
    assert (await client.get("/v1/company-integrations", headers=ctx.as_("owner"))).json() == []
    status = await client.get("/v1/company-integrations/slack/status", headers=ctx.as_("viewer"))
    assert status.json()["connected"] is False
    again = await client.delete(f"/v1/company-integrations/{row['id']}", headers=ctx.as_("owner"))
    assert again.status_code == 404
    # Connecting again brings the same row back.
    back = await install(client, ctx)
    assert back["id"] == row["id"] and back["status"] == "active"


# protects=S6/AUD-9 through sync.py: after Disconnect, a person's Slack source sync is still
# handed Oracle's app user, so the connector keeps skipping Oracle's own mirrored posts;
# fails_when=the revoked install's ``bot_user_id`` is lost and Oracle's posts become
# evidence; no_claim=the connector's own skip (tests/connectors/test_slack_oracle_skip.py).
async def test_a_slack_source_sync_skips_oracle_after_disconnect(client, slack, monkeypatch):
    service.load_connectors()
    connector = FakeConnector(kind="slack")
    monkeypatch.setitem(base._registry, "slack", connector)
    ctx, _doc = await setup(client)
    row = await install(client, ctx)
    owner = ctx.users["owner"]
    conn = await make_connection(ctx.tenant_id, owner, "slack")
    resp = await client.post(
        "/v1/sources",
        json={"kind": "slack", "name": "Team chat", "connection_id": str(conn),
              "config": {"channels": ["C0PRODUCT"]}},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    source = resp.json()["id"]

    async def synced_with() -> list[str]:
        got = await client.post(f"/v1/sources/{source}/sync", headers=ctx.as_("owner"))
        assert got.status_code == 200, got.text
        return connector.calls[-1]["config"][ORACLE_SLACK_USERS]

    assert await synced_with() == [BOT]
    resp = await client.delete(f"/v1/company-integrations/{row['id']}", headers=ctx.as_("owner"))
    assert resp.status_code == 204
    assert await synced_with() == [BOT]


# protects=review #451 item 1: a mirror stopped before its root post is unlinked with nothing
# left queued for it, so a full batch of such mirrors never stops a later one; fails_when=a
# ``close`` waits forever for a thread that never comes and BATCH of them fill every tick;
# no_claim=Slack's ordering.
async def test_mirrors_stopped_before_their_root_post_do_not_stop_later_ones(client, slack):
    ctx, doc = await setup(client)
    await install(client, ctx)
    stopped = []
    for i in range(outbox.BATCH + 1):
        d = await start(client, ctx, subject=section(doc), message={"body": f"Idea {i}."})
        await mirror_to(client, ctx, d["id"])
        resp = await client.delete(f"/v1/discussions/{d['id']}/slack", headers=ctx.as_("approver"))
        assert resp.status_code == 204
        stopped.append(d["id"])
    later = await start(client, ctx, subject=section(doc), message={"body": "Later one."})
    await mirror_to(client, ctx, later["id"])
    await outbox.tick(ctx.tenant_id)
    link = await live_link(ctx, later["id"])
    assert link is not None and link.thread_ts
    # Only the later root was posted: no closing line for a thread that never existed.
    (root,) = slack.of("chat.postMessage")
    assert "thread_ts" not in root
    for d_id in stopped:
        assert (await get(client, ctx, d_id, "commenter"))["slack"] is None
    assert all(i.status != "queued" for i in await outbox_items(ctx))


# protects=review #451 item 2: Disconnect sends no closing line for a mirror whose root was
# not posted yet; fails_when=a ``close`` goes to the channel without a thread;
# no_claim=Slack's revoke.
async def test_disconnect_sends_no_close_for_a_mirror_without_a_thread(client, slack):
    ctx, doc = await setup(client)
    row = await install(client, ctx)
    d = await start(client, ctx, subject=section(doc), message={"body": "Not posted yet."})
    await mirror_to(client, ctx, d["id"])
    resp = await client.delete(f"/v1/company-integrations/{row['id']}", headers=ctx.as_("owner"))
    assert resp.status_code == 204, resp.text
    assert slack.of("chat.postMessage") == []
    assert [m for m, _ in slack.calls][-1] == "auth.revoke"
    assert await live_link(ctx, d["id"]) is None
    assert all(i.status != "queued" for i in await outbox_items(ctx))


# protects=review #451 item 3: reconnecting a disconnected install to another Slack keeps the
# first Slack's app user for its sources' syncs, next to the new one; fails_when=the old
# ``bot_user_id`` is overwritten and Oracle's earlier posts there become evidence;
# no_claim=the connector's own skip.
async def test_reconnecting_to_another_slack_keeps_the_first_apps_user(client, slack, monkeypatch):
    service.load_connectors()
    connector = FakeConnector(kind="slack")
    monkeypatch.setitem(base._registry, "slack", connector)
    ctx, _doc = await setup(client)
    row = await install(client, ctx)
    conn = await make_connection(ctx.tenant_id, ctx.users["owner"], "slack")
    resp = await client.post(
        "/v1/sources",
        json={"kind": "slack", "name": "Team chat", "connection_id": str(conn),
              "config": {"channels": ["C0PRODUCT"]}},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    source = resp.json()["id"]
    resp = await client.delete(f"/v1/company-integrations/{row['id']}", headers=ctx.as_("owner"))
    assert resp.status_code == 204
    slack.answers["oauth.v2.access"] = [httpx.Response(200, json={
        "ok": True, "access_token": TOKEN, "token_type": "bot", "scope": SCOPES,
        "bot_user_id": "U0OTHERBOT", "app_id": "A0ORACLE",
        "team": {"id": "T0ELSEWHERE", "name": "Elsewhere Ltd"},
    })]  # fmt: skip
    back = await install(client, ctx)
    assert back["id"] == row["id"] and back["status"] == "active"
    got = await client.post(f"/v1/sources/{source}/sync", headers=ctx.as_("owner"))
    assert got.status_code == 200, got.text
    assert sorted(connector.calls[-1]["config"][ORACLE_SLACK_USERS]) == [BOT, "U0OTHERBOT"]


# protects=criterion 11: the MCP tool list has the mirror routes but no Slack events or
# callback tool; fails_when=the public endpoint becomes a tool; no_claim=the tools' use.
async def test_no_mcp_tool_for_slack_events(client):
    ctx, _doc = await setup(client)
    token = await user_token(ctx.tenant_id, ctx.users["owner"])
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
    assert not any("slack_event" in n or "callback" in n for n in names), names
