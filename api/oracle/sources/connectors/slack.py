"""Slack: the allowlisted public and private channels of one user's workspace.

credential ``{"token"}``, a user token (a bot token is refused: it reads the bot's
channels, not the person's); config ``{"channels": [channel ids], "since"?: "YYYY-MM-DD",
"until"?: "YYYY-MM-DD"}``, the date range in the same shape as Fireflies'. With
``since``, no message posted before that day (UTC) is read; with ``until`` (on or after
``since``), nothing posted after that day is read, thread replies included (S5, owner
2026-10-20): a thread started inside the range holds only the replies posted inside it.
Narrowing the config (a later ``since``, an earlier ``until``, a removed channel) deletes
the items now outside it on the next sync (:meth:`SlackConnector.scope`).

Direct messages are never ingested (S3): ``D...`` ids and conversations Slack reports as
``is_im`` or ``is_mpim`` are refused by ``validate`` and again by ``sync``.

A top-level message without replies becomes one ``message`` item; a thread becomes one
``thread`` item holding the parent and its replies, rewritten when replies arrive. Both
use the external id ``<channel>:<ts>``, so a message that later gets replies is replaced
by its thread.

Cursor::

    {"range": {"since": "2026-01-01"},
     "channels": {"C1": {"name": "general",
                         "oldest": "1700000000.000100",
                         "threads": {"1699990000.000200": "1700000100.000300"},
                         "messages": ["1699990500.000400"],
                         "walk": {...}}}}

``oldest`` is the newest top-level message seen. Replies do not change their parent's
position in ``conversations.history``, so each sync re-reads ``THREAD_LOOKBACK`` before
``oldest`` and refetches a thread whose ``latest_reply`` moved past the one in
``threads``. ``threads`` and ``messages`` hold what was pulled in within that window: one
that the window no longer lists was deleted in Slack, and is deleted here too.

History is read newest first, one page at a time, with a checkpoint after each page:
``walk`` (the window being read, the newest message of it, the oldest one handled so far
and Slack's cursor for the next page) lets an interrupted sync resume inside a channel.

``range`` is the date range the cursor was read under. When the selection changes
(:meth:`SlackConnector.rescope_cursor`), a channel still selected keeps its state as it is
if the range is the same; otherwise it keeps ``messages`` and ``threads`` (what upstream
deletes are compared against), drops ``oldest`` and ``walk`` and is marked ``refetch``:
its whole range is read again, every message and thread counts as not yet pulled in (so
each is upserted again, unchanged content writing no new version, and threads are clipped
to the new ``until``), and the flag is cleared only by the save that ends the window.
Channels no longer selected lose their state.

A private channel the person left or was removed from can no longer be read: the sync
goes on with the other channels and the source ends needing attention, naming it
(:class:`~oracle.sources.base.Attention`). Its items and state stay until the person
removes it from the allowlist (which deletes them) or rejoins it.
"""

import copy
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx

from oracle.sources.base import (
    Attention,
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorError,
    ConnectorForbidden,
    ConnectorNeedsAttention,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemDelete,
    ItemUpsert,
    Scope,
    SyncEvent,
    check_labels,
    normalize_labels,
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
# Channels one source may allowlist.
MAX_CHANNELS = 100
# From this many channels, validate reads conversations.list (a page holds up to
# LIST_PAGE_SIZE) instead of one conversations.info per channel, so a long allowlist
# does not run into Slack's per-method rate limit.
BATCH_FROM = 5
LIST_PAGE_SIZE = 1000
LIST_MAX_PAGES = 20
# The dates a range may use (days, UTC).
FIRST_DAY = date(2000, 1, 1)
LAST_DAY = date(2100, 12, 31)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TITLE_LENGTH = 80
BOT_TOKEN = (
    "This Slack connection holds a bot token, which reads the bot's channels rather than "
    "yours: reconnect Slack with your own sign-in or a user token (xoxp-)"
)

# What a sync says of a source whose connection holds a bot token (S5: each person
# connects their own account). Its items are kept.
BOT_TOKEN_SYNC = (
    "Reconnect with your own Slack account: this connection holds a bot token, which "
    "reads the bot's channels rather than yours. The items already pulled in are kept"
)
# A channel the token's user cannot read any more.
GONE_ERRORS = {"channel_not_found", "not_in_channel", "is_archived"}

AUTH_ERRORS = {
    "invalid_auth",
    "not_authed",
    "account_inactive",
    "token_revoked",
    "token_expired",
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
# A user mention, "<@U123>" or "<@U123|label>". The label stops at "<" (Slack escapes it in
# text as "&lt;"), so a flood of unclosed mentions is scanned once (linear).
MENTION = re.compile(r"<@([UW][A-Z0-9]++)(?:\|[^<>]*+)?>")


def _ts_time(ts: str | None) -> datetime | None:
    return datetime.fromtimestamp(float(ts), UTC) if ts else None


def _ts_shift(ts: str, seconds: int) -> str:
    return f"{max(float(ts) - seconds, 0):.6f}"


def is_dm(channel_id: str, name: str | None = None) -> bool:
    """A direct message by its id (``D...`` in any case or spacing) or a group DM by its
    name (``mpdm-...``, how Slack names legacy multi-person DMs)."""
    return channel_id.strip().upper().startswith("D") or (name or "").startswith("mpdm-")


def _channels(config: dict[str, Any]) -> list[str]:
    """The allowlisted channel ids, trimmed, in order, without repeats."""
    channels = config.get("channels")
    if not isinstance(channels, list) or not channels:
        raise ConnectorConfigError("allowlist at least one channel id")
    if not all(isinstance(c, str) and c.strip() for c in channels):
        raise ConnectorConfigError("channel ids must be strings")
    ids = list(dict.fromkeys(c.strip() for c in channels))
    if len(ids) > MAX_CHANNELS:
        raise ConnectorConfigError(f"allowlist at most {MAX_CHANNELS} channels")
    for channel in ids:
        if is_dm(channel):
            raise ConnectorConfigError(f"{channel} is a direct message: DMs are never ingested")
    return ids


def _day(config: dict[str, Any], key: str) -> date | None:
    """``config[key]`` as a day: exactly YYYY-MM-DD, from FIRST_DAY to LAST_DAY."""
    value = config.get(key)
    if value is None:
        return None
    try:
        ok = isinstance(value, str) and _DATE_RE.match(value)
        day = date.fromisoformat(value) if ok else None
    except ValueError:
        day = None
    if day is None or not FIRST_DAY <= day <= LAST_DAY:
        raise ConnectorConfigError(
            f"{key} must be a date (YYYY-MM-DD) from {FIRST_DAY} to {LAST_DAY}"
        )
    return day


def _midnight(day: date) -> float:
    return datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp()


def _since(config: dict[str, Any]) -> float | None:
    """``since`` as a Slack timestamp (seconds), or ``None`` when absent."""
    day = _day(config, "since")
    return None if day is None else _midnight(day)


def _until(config: dict[str, Any]) -> float | None:
    """Where the range ends (exclusive): the start of the day after ``until``, as a
    Slack timestamp, or ``None`` when absent. ``until`` must not be before ``since``."""
    day = _day(config, "until")
    if day is None:
        return None
    since = _day(config, "since")
    if since is not None and day < since:
        raise ConnectorConfigError("until must be on or after since")
    return _midnight(day + timedelta(days=1))


def _range_of(config: dict[str, Any]) -> dict[str, str]:
    """The date range of a config as the cursor records it."""
    return {k: config[k] for k in ("since", "until") if config.get(k) is not None}


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
        if response.status_code == 401:
            raise ConnectorAuthError("Slack rejected the token (401)")
        if response.status_code == 403:
            raise ConnectorForbidden(f"Slack refused {method} (403)")
        if response.status_code >= 400:
            raise ConnectorError(f"Slack {method} failed: HTTP {response.status_code}")
        body = response.json()
        if not body.get("ok"):
            error = body.get("error", "unknown_error")
            if error in AUTH_ERRORS:
                raise ConnectorAuthError(f"Slack rejected the token: {error}")
            if error == "no_permission":
                raise ConnectorForbidden(f"Slack refused {method}: no_permission")
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
                raise ChannelGone(f"channel {channel} not found or not visible") from e
            raise
        info = _check_channel(channel, info)
        if (info.get("is_private") or info.get("is_group")) and info.get("is_member") is False:
            raise ChannelGone(f"you are no longer in the private channel {channel}")
        return info

    async def listed(self, wanted: set[str]) -> dict[str, dict[str, Any]]:
        """The channels of ``wanted`` that ``conversations.list`` shows (public ones and
        the private ones the token's user is in), reading until all are found."""
        found: dict[str, dict[str, Any]] = {}
        cursor = None
        for _ in range(LIST_MAX_PAGES):
            page = await self.call(
                "conversations.list",
                types="public_channel,private_channel",
                exclude_archived="false",
                limit=LIST_PAGE_SIZE,
                **({"cursor": cursor} if cursor else {}),
            )
            for entry in page.get("channels") or []:
                if entry.get("id") in wanted:
                    found[entry["id"]] = entry
            cursor = (page.get("response_metadata") or {}).get("next_cursor")
            if not cursor or len(found) == len(wanted):
                break
        return found

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
        names = {user: await self.user_name(user) for user in set(MENTION.findall(text))}
        if names:
            text = MENTION.sub(lambda m: f"@{names[m.group(1)]}", text)
        files = [f.get("name") or f.get("title") for f in message.get("files") or []]
        if any(files):
            text = f"{text}\n[files: {', '.join(f for f in files if f)}]".strip()
        return text


def _check_channel(channel: str, info: dict[str, Any]) -> dict[str, Any]:
    if info.get("is_im") or info.get("is_mpim") or is_dm(channel, info.get("name")):
        raise ConnectorConfigError(f"{channel} is a direct message: DMs are never ingested")
    if not (info.get("is_channel") or info.get("is_group") or info.get("is_private")):
        raise ConnectorConfigError(f"{channel} is not a public or private channel")
    return info


class ChannelGone(ConnectorConfigError):
    """The token's user cannot read the channel any more (a private channel they left or
    were removed from, or one deleted). ``validate`` refuses it; ``sync`` goes on without
    it and the source needs attention."""


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

    def check_config(self, config: dict[str, Any]) -> None:
        """The rules a saved config must still meet (the channel cap, the dates, the
        channel names in ``labels``)."""
        _channels(config)
        _since(config)
        _until(config)
        check_labels(config, MAX_CHANNELS, "labels must map channel ids to names")

    def normalize_config(self, config: dict[str, Any]) -> dict[str, Any]:
        """Channel ids stripped, without repeats, sorted; names kept only for them."""
        channels = config.get("channels")
        if not isinstance(channels, list) or not all(isinstance(c, str) for c in channels):
            return dict(config)
        ids = sorted({c.strip() for c in channels})
        return normalize_labels({**config, "channels": ids}, ids, MAX_CHANNELS)

    def scope(self, config: dict[str, Any]) -> Scope:
        """Still selected: in an allowlisted channel, started inside the date range (a
        thread by its first message; its replies after ``until`` are clipped when it is
        read again)."""
        since, until = _since(config), _until(config)
        return Scope(
            groups=frozenset(_channels(config)),
            occurred_from=None if since is None else datetime.fromtimestamp(since, UTC),
            occurred_before=None if until is None else datetime.fromtimestamp(until, UTC),
        )

    def rescope_cursor(
        self, old_cursor: dict[str, Any] | None, new_config: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Per channel still selected: its state as it is when the range is the same,
        else what deletes are compared against (``messages``, ``threads``) with
        ``refetch`` set, so the whole new range is read again. Channels removed lose
        their state. A cursor without ``range`` (saved before it was kept) counts as of
        another range."""
        old = old_cursor or {}
        new_range = _range_of(new_config)
        same_range = "range" in old and old["range"] == new_range
        previous = old.get("channels") or {}
        kept: dict[str, Any] = {}
        for channel in _channels(new_config):
            entry = previous.get(channel)
            if not entry:
                continue
            if same_range:
                kept[channel] = copy.deepcopy(entry)
                continue
            kept[channel] = {
                **({"name": entry["name"]} if entry.get("name") else {}),
                "threads": dict(entry.get("threads") or {}),
                "messages": list(entry.get("messages") or []),
                "refetch": True,
            }
        return {"range": new_range, "channels": kept} if kept else None

    async def _person(self, slack: _Slack) -> dict[str, Any]:
        """``auth.test``, refusing a bot token (``bot_id`` is set for bots, whatever the
        token's prefix: rotated ones start ``xoxe.xoxb-``)."""
        identity = await slack.call("auth.test")
        if identity.get("bot_id"):
            raise ConnectorConfigError(BOT_TOKEN)
        return identity

    async def _person_syncing(self, slack: _Slack) -> dict[str, Any]:
        """``_person`` for a sync: a source on a bot-token connection needs its owner to
        reconnect (its items are kept), it does not fail as an error."""
        try:
            return await self._person(slack)
        except ConnectorConfigError as e:
            if str(e) == BOT_TOKEN:
                raise ConnectorNeedsAttention(BOT_TOKEN_SYNC) from None
            raise

    async def validate(self, config: dict[str, Any], credential: dict[str, Any] | None) -> None:
        channels = _channels(config)
        _since(config)
        _until(config)
        async with self._session(credential) as slack:
            await self._person(slack)
            listed = await slack.listed(set(channels)) if len(channels) >= BATCH_FROM else {}
            for channel in channels:
                if channel in listed:
                    _check_channel(channel, listed[channel])
                else:
                    await slack.conversation(channel)

    async def sync(
        self,
        config: dict[str, Any],
        credential: dict[str, Any] | None,
        cursor: dict[str, Any] | None,
    ) -> AsyncIterator[SyncEvent]:
        channels = _channels(config)
        since, until = _since(config), _until(config)
        state: dict[str, Any] = {
            "range": _range_of(config),
            "channels": {
                k: copy.deepcopy(v) for k, v in ((cursor or {}).get("channels") or {}).items()
            },
        }
        async with self._session(credential) as slack:
            base = (await self._person_syncing(slack)).get("url") or ""
            if base and not base.endswith("/"):
                base += "/"
            for channel in channels:
                try:
                    async for event in self._sync_channel(
                        slack, base, channel, state, since, until
                    ):
                        yield event
                except ChannelGone:
                    # Its items and state stay; the other channels are still read.
                    name = (state["channels"].get(channel) or {}).get("name")
                    label = f"#{name} ({channel})" if name else channel
                    yield Attention(
                        f"Slack channel {label} can no longer be read with your account "
                        "(you left it or were removed): remove it from this source, or "
                        "rejoin it in Slack."
                    )

    async def _sync_channel(
        self,
        slack: _Slack,
        base: str,
        channel: str,
        state: dict[str, Any],
        since: float | None = None,
        until: float | None = None,
    ) -> AsyncIterator[SyncEvent]:
        info = await slack.conversation(channel)
        name = info.get("name") or channel
        acl = {
            "channel": channel,
            "channel_name": name,
            "is_private": bool(info.get("is_private") or info.get("is_group")),
        }
        previous = state["channels"].get(channel) or {}
        # After a selection change: read the whole range again (see rescope_cursor).
        refetch = bool(previous.get("refetch"))
        oldest: str | None = previous.get("oldest")
        threads: dict[str, str] = dict(previous.get("threads") or {})
        # Cursors from before deletes were tracked list no plain messages: those count
        # as known when older than ``oldest``.
        tracked = "messages" in previous
        messages: set[str] = set(previous.get("messages") or [])
        walk: dict[str, Any] | None = previous.get("walk")

        if walk is None:
            window_from = float(_ts_shift(oldest, THREAD_LOOKBACK)) if oldest else None
            if since is not None and (window_from or 0) < since:
                window_from = since
            walk = {
                "from": None if window_from is None else f"{window_from:.6f}",
                # Slack's ``latest`` is exclusive. Once the range is behind the newest
                # message the window only re-reads the threads inside it, for new replies.
                "latest": None if until is None else f"{until:.6f}",
                "high": None,
                "low": None,
                "next": None,
            }

        def known(ts: str) -> bool:
            if refetch:
                return False
            if ts in messages or ts in threads:
                return True
            return not tracked and oldest is not None and float(ts) <= float(oldest)

        def save() -> CursorCheckpoint:
            state["channels"][channel] = {
                "name": name,
                **({"oldest": oldest} if oldest is not None else {}),
                **({"refetch": True} if refetch else {}),
                "threads": dict(threads),
                "messages": sorted(messages, key=float),
                **({"walk": dict(walk)} if walk is not None else {}),
            }
            return CursorCheckpoint(_copy(state))

        params: dict[str, Any] = {"channel": channel}
        if walk["from"] is not None:
            params["oldest"] = walk["from"]
        if walk["latest"] is not None:
            params["latest"] = walk["latest"]
        while True:
            try:
                page = await slack.call(
                    "conversations.history",
                    limit=PAGE_SIZE,
                    **params,
                    **({"cursor": walk["next"]} if walk["next"] else {}),
                )
            except SlackApiError as e:
                if e.error in GONE_ERRORS:
                    raise ChannelGone(f"channel {channel} can no longer be read") from e
                raise
            listed = [m for m in page.get("messages") or [] if m.get("ts")]
            next_cursor = (page.get("response_metadata") or {}).get("next_cursor") or None
            # This page covers [its oldest message, the previous page's oldest) of the
            # window; the last page reaches down to the window's start.
            top = walk["low"] or walk["latest"]
            bottom = walk["from"] if next_cursor is None else None
            if next_cursor is not None and listed:
                bottom = min((m["ts"] for m in listed), key=float)
            kept = sorted(
                (
                    m
                    for m in listed
                    if _keep(m)
                    and (since is None or float(m["ts"]) >= since)
                    and (until is None or float(m["ts"]) < until)
                ),
                key=lambda m: float(m["ts"]),
            )
            for message in kept:
                ts = message["ts"]
                latest_reply = message.get("latest_reply")
                if message.get("reply_count") and latest_reply:
                    marker = _clip(latest_reply, until)
                    if not known(ts) or threads.get(ts) != marker:
                        yield await self._thread(slack, base, channel, name, acl, message, until)
                    threads[ts] = marker
                    messages.discard(ts)
                elif message.get("subtype") != "tombstone":
                    if not known(ts):
                        yield await self._message(slack, base, channel, name, acl, message)
                    messages.add(ts)
                if walk["high"] is None or float(ts) > float(walk["high"]):
                    walk["high"] = ts

            # Pulled in before, inside what this page covers, and no longer listed:
            # deleted in Slack.
            present = {m["ts"] for m in listed}
            for ts in sorted(set(messages) | set(threads), key=float):
                inside = (bottom is None or float(ts) >= float(bottom)) and (
                    top is None or float(ts) < float(top)
                )
                if inside and (bottom is not None or next_cursor is None) and ts not in present:
                    messages.discard(ts)
                    threads.pop(ts, None)
                    yield ItemDelete(external_id=f"{channel}:{ts}")

            if listed:
                low = min((m["ts"] for m in listed), key=float)
                if walk["low"] is None or float(low) < float(walk["low"]):
                    walk["low"] = low
            walk["next"] = next_cursor
            # Forget what falls behind the lookback: later syncs never read back that far
            # (and a first sync of a long channel keeps a small cursor).
            newest = max((float(t) for t in (oldest, walk["high"]) if t), default=None)
            if newest is not None:
                horizon = newest - THREAD_LOOKBACK
                threads = {t: r for t, r in threads.items() if float(t) >= horizon}
                messages = {t for t in messages if float(t) >= horizon}
            if next_cursor is None:
                break
            yield save()

        # The window is read: move ``oldest`` up to the newest message in it.
        if walk["high"] is not None and (oldest is None or float(walk["high"]) > float(oldest)):
            oldest = walk["high"]
        walk = None
        tracked = True
        refetch = False
        yield save()

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
        self,
        slack: _Slack,
        base: str,
        channel: str,
        name: str,
        acl: dict,
        parent: dict,
        until: float | None = None,
    ) -> ItemUpsert:
        ts = parent["ts"]
        bound = {} if until is None else {"latest": f"{until:.6f}"}
        replies = [
            m
            async for m in slack.paged(
                "conversations.replies", "messages", channel=channel, ts=ts, **bound
            )
            # Nothing posted after the range, replies included (S5, owner 2026-10-20).
            if m.get("ts") and (until is None or float(m["ts"]) < until)
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


def _clip(latest_reply: str, until: float | None) -> str:
    """What a thread's ``latest_reply`` is remembered as: replies after ``until`` are
    never read, so they must not make the thread fetched again."""
    if until is not None and float(latest_reply) >= until:
        return f"{until:.6f}"
    return latest_reply


def _copy(state: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(state)


register(SlackConnector())
