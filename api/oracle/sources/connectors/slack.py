"""Slack: the allowlisted public and private channels of one user's workspace.

credential ``{"token"}`` (a user or bot token); config ``{"channels": [channel ids],
"since"?: "YYYY-MM-DD"}``. With ``since``, no message posted before that day (UTC) is read.

Direct messages are never ingested (S3): ``D...`` ids and conversations Slack reports as
``is_im`` or ``is_mpim`` are refused by ``validate`` and again by ``sync``.

A top-level message without replies becomes one ``message`` item; a thread becomes one
``thread`` item holding the parent and its replies, rewritten when replies arrive. Both
use the external id ``<channel>:<ts>``, so a message that later gets replies is replaced
by its thread.

Cursor::

    {"channels": {"C1": {"oldest": "1700000000.000100",
                         "threads": {"1699990000.000200": "1700000100.000300"}}}}

``oldest`` is the newest top-level message seen. Replies do not change their parent's
position in ``conversations.history``, so each sync re-reads ``THREAD_LOOKBACK`` before
``oldest`` and refetches a thread whose ``latest_reply`` moved past the one in
``threads``.
"""

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from typing import Any

import httpx

from oracle.sources.base import (
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemUpsert,
    SyncEvent,
    register,
)

API_URL = "https://slack.com/api/"
OAUTH = {
    "authorize_url": "https://slack.com/oauth/v2/authorize",
    "token_url": "https://slack.com/api/oauth.v2.access",
    # User-token scopes (Slack's ``user_scope`` parameter for a per-user connection).
    "scopes": ["channels:read", "channels:history", "groups:read", "groups:history", "users:read"],
}
# How far before the cursor a sync looks for threads with new replies (seconds).
THREAD_LOOKBACK = 14 * 24 * 3600
PAGE_SIZE = 200
TITLE_LENGTH = 80

AUTH_ERRORS = {
    "invalid_auth",
    "not_authed",
    "account_inactive",
    "token_revoked",
    "token_expired",
    "no_permission",
}
# Channel housekeeping, not conversation.
SKIPPED_SUBTYPES = {
    "channel_join",
    "channel_leave",
    "channel_topic",
    "channel_purpose",
    "channel_name",
    "channel_archive",
    "channel_unarchive",
    "channel_convert_to_private",
    "channel_convert_to_public",
    "group_join",
    "group_leave",
    "group_topic",
    "group_purpose",
    "group_name",
    "group_archive",
    "group_unarchive",
    "pinned_item",
    "unpinned_item",
    "bot_add",
    "bot_remove",
    "reminder_add",
}
MENTION = re.compile(r"<@([UW][A-Z0-9]+)(?:\|[^>]*)?>")


def _ts_time(ts: str | None) -> datetime | None:
    return datetime.fromtimestamp(float(ts), UTC) if ts else None


def _ts_shift(ts: str, seconds: int) -> str:
    return f"{max(float(ts) - seconds, 0):.6f}"


def _channels(config: dict[str, Any]) -> list[str]:
    channels = config.get("channels")
    if not isinstance(channels, list) or not channels:
        raise ConnectorConfigError("allowlist at least one channel id")
    if not all(isinstance(c, str) and c for c in channels):
        raise ConnectorConfigError("channel ids must be strings")
    for channel in channels:
        if channel.startswith("D"):
            raise ConnectorConfigError(f"{channel} is a direct message: DMs are never ingested")
    return channels


def _since(config: dict[str, Any]) -> float | None:
    """``since`` as a Slack timestamp (seconds), or ``None`` when absent."""
    since = config.get("since")
    if since is None:
        return None
    try:
        day = date.fromisoformat(since) if isinstance(since, str) else None
    except ValueError:
        day = None
    if day is None:
        raise ConnectorConfigError("since must be a date (YYYY-MM-DD)")
    return datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp()


def _token(credential: dict[str, Any] | None) -> str:
    token = (credential or {}).get("token")
    if not token:
        raise ConnectorConfigError("the Slack connection has no token")
    return token


class _Slack:
    """One sync's Slack Web API session: errors mapped, user names cached."""

    def __init__(self, client: httpx.AsyncClient, token: str):
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}"}
        self.users: dict[str, str] = {}

    async def call(self, method: str, **params: Any) -> dict[str, Any]:
        response = await self.client.get(API_URL + method, params=params, headers=self.headers)
        if response.status_code == 429:
            retry = response.headers.get("Retry-After")
            raise ConnectorRateLimited(
                f"Slack rate limited {method}", retry_after=float(retry) if retry else None
            )
        if response.status_code in (401, 403):
            raise ConnectorAuthError(f"Slack rejected the token ({response.status_code})")
        if response.status_code >= 400:
            raise ConnectorError(f"Slack {method} failed: HTTP {response.status_code}")
        body = response.json()
        if not body.get("ok"):
            error = body.get("error", "unknown_error")
            if error in AUTH_ERRORS:
                raise ConnectorAuthError(f"Slack rejected the token: {error}")
            if error == "ratelimited":
                raise ConnectorRateLimited(f"Slack rate limited {method}")
            if error == "missing_scope":
                needed = body.get("needed", "")
                raise ConnectorConfigError(f"the Slack token is missing a scope {needed}".strip())
            raise SlackApiError(method, error)
        return body

    async def paged(self, method: str, key: str, **params: Any) -> AsyncIterator[dict[str, Any]]:
        cursor = None
        while True:
            page = await self.call(
                method, limit=PAGE_SIZE, **params, **({"cursor": cursor} if cursor else {})
            )
            for entry in page.get(key, []):
                yield entry
            cursor = (page.get("response_metadata") or {}).get("next_cursor")
            if not cursor:
                return

    async def conversation(self, channel: str) -> dict[str, Any]:
        try:
            info = (await self.call("conversations.info", channel=channel))["channel"]
        except SlackApiError as e:
            if e.error == "channel_not_found":
                raise ConnectorConfigError(f"channel {channel} not found or not visible") from e
            raise
        if info.get("is_im") or info.get("is_mpim"):
            raise ConnectorConfigError(f"{channel} is a direct message: DMs are never ingested")
        if not (info.get("is_channel") or info.get("is_group") or info.get("is_private")):
            raise ConnectorConfigError(f"{channel} is not a public or private channel")
        return info

    async def user_name(self, user: str) -> str:
        if user not in self.users:
            try:
                info = (await self.call("users.info", user=user))["user"]
            except SlackApiError:
                self.users[user] = user
            else:
                profile = info.get("profile") or {}
                self.users[user] = (
                    profile.get("display_name")
                    or profile.get("real_name")
                    or info.get("real_name")
                    or info.get("name")
                    or user
                )
        return self.users[user]

    async def author(self, message: dict[str, Any]) -> str:
        if message.get("user"):
            return await self.user_name(message["user"])
        bot = message.get("bot_profile") or {}
        return message.get("username") or bot.get("name") or message.get("bot_id") or "unknown"

    async def text(self, message: dict[str, Any]) -> str:
        text = message.get("text") or ""
        for user in set(MENTION.findall(text)):
            name = await self.user_name(user)
            text = re.sub(rf"<@{user}(?:\|[^>]*)?>", f"@{name}", text)
        files = [f.get("name") or f.get("title") for f in message.get("files") or []]
        if any(files):
            text = f"{text}\n[files: {', '.join(f for f in files if f)}]".strip()
        return text


class SlackApiError(ConnectorError):
    def __init__(self, method: str, error: str):
        super().__init__(f"Slack {method} failed: {error}")
        self.error = error


def _keep(message: dict[str, Any]) -> bool:
    if message.get("subtype") in SKIPPED_SUBTYPES:
        return False
    # A reply broadcast to the channel belongs to its thread.
    if message.get("subtype") == "thread_broadcast":
        return False
    return message.get("thread_ts") in (None, message.get("ts"))


def _permalink(base: str, channel: str, ts: str) -> str | None:
    # The form chat.getPermalink returns, built locally to save one call per message.
    return f"{base}archives/{channel}/p{ts.replace('.', '')}" if base else None


def _title(channel_name: str, text: str) -> str:
    first = text.strip().splitlines()[0] if text.strip() else ""
    if len(first) > TITLE_LENGTH:
        first = first[: TITLE_LENGTH - 1].rstrip() + "…"
    return f"#{channel_name}: {first}" if first else f"#{channel_name}"


class SlackConnector:
    kind = "slack"

    def __init__(self, client: httpx.AsyncClient | None = None):
        self._client = client

    @asynccontextmanager
    async def _session(self, credential: dict[str, Any] | None):
        token = _token(credential)
        if self._client is not None:
            yield _Slack(self._client, token)
            return
        async with httpx.AsyncClient(timeout=30) as client:
            yield _Slack(client, token)

    async def validate(self, config: dict[str, Any], credential: dict[str, Any] | None) -> None:
        channels = _channels(config)
        _since(config)
        async with self._session(credential) as slack:
            await slack.call("auth.test")
            for channel in channels:
                await slack.conversation(channel)

    async def sync(
        self,
        config: dict[str, Any],
        credential: dict[str, Any] | None,
        cursor: dict[str, Any] | None,
    ) -> AsyncIterator[SyncEvent]:
        channels = _channels(config)
        since = _since(config)
        state: dict[str, Any] = {
            "channels": {k: dict(v) for k, v in ((cursor or {}).get("channels") or {}).items()}
        }
        async with self._session(credential) as slack:
            base = (await slack.call("auth.test")).get("url") or ""
            if base and not base.endswith("/"):
                base += "/"
            for channel in channels:
                async for event in self._sync_channel(slack, base, channel, state, since):
                    yield event

    async def _sync_channel(
        self,
        slack: _Slack,
        base: str,
        channel: str,
        state: dict[str, Any],
        since: float | None = None,
    ) -> AsyncIterator[SyncEvent]:
        info = await slack.conversation(channel)
        name = info.get("name") or channel
        acl = {
            "channel": channel,
            "channel_name": name,
            "is_private": bool(info.get("is_private") or info.get("is_group")),
        }
        previous = state["channels"].get(channel) or {}
        oldest: str | None = previous.get("oldest")
        threads: dict[str, str] = dict(previous.get("threads") or {})

        params: dict[str, Any] = {"channel": channel}
        if oldest:
            params["oldest"] = _ts_shift(oldest, THREAD_LOOKBACK)
        if since is not None and float(params.get("oldest") or 0) < since:
            params["oldest"] = f"{since:.6f}"
        messages = [m async for m in slack.paged("conversations.history", "messages", **params)]
        messages = sorted(
            (m for m in messages if _keep(m) and (since is None or float(m["ts"]) >= since)),
            key=lambda m: float(m["ts"]),
        )

        newest = oldest
        for message in messages:
            ts = message["ts"]
            is_new = oldest is None or float(ts) > float(oldest)
            latest_reply = message.get("latest_reply")
            if message.get("reply_count") and latest_reply:
                if is_new or threads.get(ts) != latest_reply:
                    yield await self._thread(slack, base, channel, name, acl, message)
                threads[ts] = latest_reply
            elif is_new and message.get("subtype") != "tombstone":
                yield await self._message(slack, base, channel, name, acl, message)
            if newest is None or float(ts) > float(newest):
                newest = ts

        if newest is not None:
            horizon = float(newest) - THREAD_LOOKBACK
            threads = {ts: r for ts, r in threads.items() if float(ts) >= horizon}
            state["channels"][channel] = {"oldest": newest, "threads": threads}
            yield CursorCheckpoint(_copy(state))

    async def _message(
        self, slack: _Slack, base: str, channel: str, name: str, acl: dict, message: dict
    ) -> ItemUpsert:
        author = await slack.author(message)
        text = await slack.text(message)
        edited = (message.get("edited") or {}).get("ts")
        return ItemUpsert(
            external_id=f"{channel}:{message['ts']}",
            kind="message",
            title=_title(name, text),
            url=_permalink(base, channel, message["ts"]),
            author=author,
            content=f"{author}: {text}",
            acl=acl,
            occurred_at=_ts_time(message["ts"]),
            source_updated_at=_ts_time(edited or message["ts"]),
        )

    async def _thread(
        self, slack: _Slack, base: str, channel: str, name: str, acl: dict, parent: dict
    ) -> ItemUpsert:
        ts = parent["ts"]
        replies = [
            m
            async for m in slack.paged("conversations.replies", "messages", channel=channel, ts=ts)
        ]
        if not any(m.get("ts") == ts for m in replies):
            replies.insert(0, parent)
        replies.sort(key=lambda m: float(m["ts"]))
        lines = []
        for reply in replies:
            if reply.get("subtype") in SKIPPED_SUBTYPES:
                continue
            when = _ts_time(reply["ts"]).strftime("%Y-%m-%d %H:%M")
            lines.append(f"{await slack.author(reply)} ({when}): {await slack.text(reply)}")
        parent_text = await slack.text(parent)
        latest = max(float(m["ts"]) for m in replies)
        return ItemUpsert(
            external_id=f"{channel}:{ts}",
            kind="thread",
            title=_title(name, parent_text),
            url=_permalink(base, channel, ts),
            author=await slack.author(parent),
            content="\n".join(lines),
            acl=acl,
            occurred_at=_ts_time(ts),
            source_updated_at=datetime.fromtimestamp(latest, UTC),
        )


def _copy(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "channels": {
            c: {"oldest": s["oldest"], "threads": dict(s.get("threads") or {})}
            for c, s in state["channels"].items()
        }
    }


register(SlackConnector())
