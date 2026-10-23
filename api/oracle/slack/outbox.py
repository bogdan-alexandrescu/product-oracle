"""The Slack outbox (G8 §3.3), delivered by the minute tick within its budget.

``root`` and ``post`` and ``close`` are ``chat.postMessage`` (the last two in the link's
thread), ``update`` is ``chat.update`` and ``delete`` is ``chat.delete``. A 429 waits for
its ``Retry-After``; other failures back off 1, 5 and 30 minutes, then hourly, and give up
after 24 h (``failed``). Items of one thread go in order: one that waits holds the ones
after it. Text over 3,000 characters goes as several posts.
"""

import logging
import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.discussions.models import DiscussionMessage
from oracle.integrations import slack_api, slack_oauth
from oracle.integrations.models import CompanyIntegration
from oracle.slack import bridge
from oracle.slack.models import DiscussionSlackLink, SlackEventSeen, SlackOutbox
from oracle.tenancy import tenant_session

log = logging.getLogger(__name__)

BACKOFF_MINUTES = (1, 5, 30)
HOURLY = 60
GIVE_UP_AFTER = timedelta(hours=24)
SEEN_FOR = timedelta(days=7)
# One Slack call's worst case, as the tick budgets it.
CALL_SECONDS = slack_api.TIMEOUT_SECONDS + 1.0
BATCH = 50


class OutboxTick(BaseModel):
    queued: int = 0
    sent: int = 0
    retried: int = 0
    failed: int = 0


def backoff(attempts: int) -> timedelta:
    """The wait after the ``attempts``-th failure in a row (1, 5, 30 minutes, then hourly)."""
    if 1 <= attempts <= len(BACKOFF_MINUTES):
        return timedelta(minutes=BACKOFF_MINUTES[attempts - 1])
    return timedelta(minutes=HOURLY)


async def _send(
    http: httpx.AsyncClient, token: str, link: DiscussionSlackLink, item: SlackOutbox
) -> str | None:
    """One item to Slack; the ts of the (first) message posted."""
    text = str(item.payload.get("text") or "")
    if item.op == "update":
        await slack_api.call(
            http, "chat.update", token=token,
            json={"channel": link.channel_id, "ts": item.payload["ts"], "text": text[:3000]},
        )  # fmt: skip
        return str(item.payload["ts"])
    if item.op == "delete":
        await slack_api.call(
            http, "chat.delete", token=token,
            json={"channel": link.channel_id, "ts": item.payload["ts"]},
        )  # fmt: skip
        return str(item.payload["ts"])
    first: str | None = None
    # Parts already posted (a retry after a later part failed) are not posted again.
    done = int(item.payload.get("parts_sent") or 0)
    for i, part in enumerate(bridge.split(text)):
        if i < done:
            continue
        body = {"channel": link.channel_id, "text": part, "mrkdwn": True, "unfurl_links": False}
        if item.op != "root":
            body["thread_ts"] = link.thread_ts
        elif i > 0 and first:
            body["thread_ts"] = first
        got = await slack_api.call(http, "chat.postMessage", token=token, json=body)
        ts = str(got.get("ts") or "")
        if first is None:
            first = ts
            if item.op == "root":
                link.thread_ts = ts
        item.payload = {**item.payload, "parts_sent": i + 1}
    return first


async def deliver_one(
    db: AsyncSession,
    http: httpx.AsyncClient,
    token: str,
    item: SlackOutbox,
    now: datetime,
) -> bool:
    """Send one item and record the outcome; True when sent."""
    link = await db.get(DiscussionSlackLink, item.link_id)
    if link is None:
        item.status = "dropped"
        return False
    try:
        ts = await _send(http, token, link, item)
    except slack_api.SlackError as e:
        item.attempts += 1
        item.error = e.code[:200]
        if now - item.created_at >= GIVE_UP_AFTER:
            item.status = "failed"
        elif e.retry_after is not None:
            item.next_try_at = now + timedelta(seconds=e.retry_after)
        else:
            item.next_try_at = now + backoff(item.attempts)
        log.warning("slack outbox: item %s failed (%s)", item.id, item.error)
        return False
    item.status, item.slack_ts, item.error = "sent", ts, None
    if item.message_id is not None and ts:
        message = await db.get(DiscussionMessage, item.message_id)
        if message is not None and message.slack_ts is None:
            message.slack_ts = ts
    return True


async def deliver(
    db: AsyncSession,
    row: CompanyIntegration | None = None,
    *,
    now: datetime | None = None,
    budget_seconds: float | None = None,
    out: OutboxTick | None = None,
) -> OutboxTick:
    """The due items, oldest first, while a call still fits in the budget."""
    out = out or OutboxTick()
    now = now or datetime.now(UTC)
    deadline = None if budget_seconds is None else time.monotonic() + budget_seconds
    row = row or await slack_oauth.installed(db)
    if row is None or row.status != "active":
        return out
    due = list(
        await db.scalars(
            select(SlackOutbox)
            .where(SlackOutbox.status == "queued")
            .order_by(SlackOutbox.created_at, SlackOutbox.id)
            .limit(BATCH)
            .with_for_update(skip_locked=True)
        )
    )
    if not due:
        return out
    token = slack_oauth.token_of(row)
    held: set[uuid.UUID] = set()
    async with slack_api.http_client() as http:
        for item in due:
            if deadline is not None and deadline - time.monotonic() < CALL_SECONDS:
                break
            if item.link_id in held:
                continue
            link = await db.get(DiscussionSlackLink, item.link_id)
            waits = item.next_try_at > now or (
                item.op != "root" and link is not None and not link.thread_ts
            )
            if waits:
                held.add(item.link_id)
                continue
            if item.op != "close" and link is not None and link.unlinked_at is not None:
                item.status = "dropped"
                continue
            if await deliver_one(db, http, token, item, now):
                out.sent += 1
            else:
                held.add(item.link_id)
                if item.status == "failed":
                    out.failed += 1
                else:
                    out.retried += 1
            await db.flush()
    return out


async def deliver_closes(
    db: AsyncSession, http: httpx.AsyncClient, row: CompanyIntegration, items: list[SlackOutbox]
) -> None:
    """Disconnect: post the closing lines now, before the token is revoked (best effort:
    what fails is dropped with the token)."""
    if not items:
        return
    token = slack_oauth.token_of(row)
    now = datetime.now(UTC)
    for item in items:
        if not await deliver_one(db, http, token, item, now):
            item.status = "dropped"
    await db.flush()


async def tick(
    tenant_id: uuid.UUID, *, budget_seconds: float | None = None, now: datetime | None = None
) -> OutboxTick:
    """The tick's Slack work for one company: queue the new messages of mirrored
    discussions, deliver what is due, and forget events seen more than 7 days ago."""
    out = OutboxTick()
    async with tenant_session(tenant_id) as db:
        await db.execute(
            delete(SlackEventSeen).where(
                SlackEventSeen.tenant_id == tenant_id,
                SlackEventSeen.received_at < (now or datetime.now(UTC)) - SEEN_FOR,
            )
        )
        out.queued = await bridge.queue_new(db)
        await db.commit()
        # After the commit: what was just queued is due now.
        now = now or datetime.now(UTC)
        await deliver(db, now=now, budget_seconds=budget_seconds, out=out)
        await db.commit()
    return out
