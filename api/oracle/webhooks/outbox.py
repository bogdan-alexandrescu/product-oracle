"""The webhooks outbox (I1 "Delivery, retries and backoff"), delivered by the minute tick
within its budget, modelled on :mod:`oracle.slack.outbox`.

Each call goes through ``guarded_transport`` (oracle.baseline.public_links: public
addresses only on every connect, no redirects followed), 5 s to connect and 10 s in all;
the response is read up to 2 KB. Bodies are built at send time from the current rows
(a renamed document is sent with its current title), at most 16 KB, and signed as Standard
Webhooks (:mod:`oracle.webhooks.sign`).

- Any 2xx: ``succeeded``. A timeout, a connection error, 408, 429 and any 5xx: ``retrying``
  after 1, 5 and 30 minutes, then hourly, ±10% jitter; a 429's or 503's ``Retry-After`` is
  honoured up to an hour; given up after 24 hours (``failed``). A 3xx (``redirect``), a
  private address (``not_public``) and any other 4xx: ``failed`` at once. 410 Gone also
  pauses the webhook (``gone``).
- The owners-and-approvers rule's second check (Q2): at send, the event is checked again for
  its subject's current state; one now approvers-only, or whose subject is gone, is
  ``withheld`` (owners see it in the log) and never sent.
- A webhook whose every delivery failed for 72 hours (at least 5) pauses (``failing``), with
  an Inbox row for its creator and every owner.
- Webhooks are sent side by side, each with its own client, at most 20 deliveries each and
  50 per company a tick: one that times out never holds up another.

Delivery is at least once and not ordered; receivers dedupe on ``webhook-id``.
"""

import asyncio
import json
import logging
import random
import ssl
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import ApiToken, User
from oracle.baseline.public_links import LinkError, guarded_transport
from oracle.docs.models import Document
from oracle.export.render import app_url
from oracle.members.names import display_name
from oracle.models import Tenant
from oracle.runs.models import Checkpoint, Run
from oracle.tenancy import tenant_session
from oracle.webhooks import events, fanout, retention, sign
from oracle.webhooks.models import Webhook, WebhookDelivery, WebhookEvent
from oracle.webhooks.schemas import loopback_allowed

log = logging.getLogger(__name__)

TEST_TYPE = "webhook.test"
TEST_MESSAGE = "Test from Product Oracle"
BACKOFF_MINUTES = (1, 5, 30)
HOURLY = 60
JITTER = 0.1
RETRY_AFTER_CAP = timedelta(hours=1)
GIVE_UP_AFTER = timedelta(hours=24)
FAILING_PAUSE_AFTER = timedelta(hours=72)
FAILING_MIN_DELIVERIES = 5
CONNECT_SECONDS = 5.0
TOTAL_SECONDS = 10.0
EXCERPT_BYTES = 2048
MAX_BODY_BYTES = 16 * 1024
BATCH = 50
PER_WEBHOOK = 20
RETRY_STATUSES = frozenset({408, 429})
RETRY_AFTER_STATUSES = frozenset({429, 503})

_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> httpx.AsyncBaseTransport | None:
    """Replace the transport (tests: a fake receiver); returns the previous override."""
    global _transport
    previous, _transport = _transport, transport
    return previous


def call_seconds() -> float:
    """One call's worst case, as the tick budgets it."""
    return TOTAL_SECONDS + 1.0


class WebhooksTick(BaseModel):
    queued: int = 0
    sent: int = 0
    retried: int = 0
    failed: int = 0
    withheld: int = 0
    paused: int = 0
    purged: int = 0


def backoff(attempts: int) -> timedelta:
    """The wait after the ``attempts``-th failure in a row (1, 5, 30 minutes, then hourly),
    ±10% jitter."""
    if 1 <= attempts <= len(BACKOFF_MINUTES):
        minutes = BACKOFF_MINUTES[attempts - 1]
    else:
        minutes = HOURLY
    return timedelta(minutes=minutes) * random.uniform(1 - JITTER, 1 + JITTER)


# --- one call -------------------------------------------------------------------------------


@dataclass
class Answer:
    """What one call got: an HTTP status, or an error code (``timeout``, ``connect``,
    ``not_public``, ``tls``, ``redirect``)."""

    http_status: int | None = None
    error: str | None = None
    excerpt: str | None = None
    duration_ms: int = 0
    retry_after: float | None = None


def _client(url: str) -> httpx.AsyncClient:
    if _transport is not None:
        transport = _transport
    elif loopback_allowed(urlsplit(url).hostname):
        # The Playwright stub receiver (tests only; refused in a real deployment).
        transport = httpx.AsyncHTTPTransport(retries=0)
    else:
        transport = guarded_transport()
    return httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(TOTAL_SECONDS, connect=CONNECT_SECONDS),
        follow_redirects=False,
    )


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(raw) - datetime.now(UTC)).total_seconds()
        except (TypeError, ValueError):
            return None
    return max(1.0, seconds)


def _error_code(exc: BaseException) -> str:
    seen: BaseException | None = exc
    while seen is not None:
        if isinstance(seen, LinkError):
            return "not_public" if seen.code == "blocked_address" else "connect"
        if isinstance(seen, ssl.SSLError):
            return "tls"
        seen = seen.__cause__ or seen.__context__
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    return "connect"


async def post(client: httpx.AsyncClient, url: str, body: bytes, headers: dict) -> Answer:
    """One signed POST, within ``TOTAL_SECONDS``; never raises for the receiver's sake."""
    started = time.monotonic()
    out = Answer()
    try:
        async with asyncio.timeout(TOTAL_SECONDS):
            async with client.stream("POST", url, content=body, headers=headers) as resp:
                got = bytearray()
                async for chunk in resp.aiter_bytes():
                    got += chunk
                    if len(got) >= EXCERPT_BYTES:
                        break
                out.http_status = resp.status_code
                out.excerpt = bytes(got[:EXCERPT_BYTES]).decode("utf-8", "replace")
                if resp.status_code in RETRY_AFTER_STATUSES:
                    out.retry_after = _retry_after(resp)
                if 300 <= resp.status_code < 400:
                    out.error = "redirect"
    except TimeoutError:
        out.error = "timeout"
    except httpx.HTTPError as e:
        out.error = _error_code(e)
    out.duration_ms = int((time.monotonic() - started) * 1000)
    return out


# --- the body -------------------------------------------------------------------------------


async def _actor(db: AsyncSession, actor: str | None) -> dict[str, Any]:
    """A person by display name (never an id or email); Oracle's work; or the system."""
    kind, _, raw = (actor or "system").partition(":")
    if kind == audit.ORACLE:
        return {"kind": "oracle"}
    try:
        who = uuid.UUID(raw)
    except ValueError:
        return {"kind": "system"}
    if kind == "user":
        user = await db.get(User, who)
        if user is not None:
            return {"kind": "person", "name": display_name(user.email, user.name)}
    elif kind == "token":
        token = await db.get(ApiToken, who)
        if token is not None:
            user = await db.get(User, token.user_id) if token.user_id else None
            name = display_name(user.email, user.name) if user is not None else token.name
            return {"kind": "person", "name": name}
    return {"kind": "system"}


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


async def _document(db: AsyncSession, document_id: uuid.UUID | None) -> Document | None:
    """The document, unless it is gone or in Trash (then the delivery is withheld)."""
    if document_id is None:
        return None
    return await db.scalar(
        select(Document)
        .where(Document.id == document_id)
        .execution_options(oracle_all_documents=True)
    )


async def _data(db: AsyncSession, event: WebhookEvent) -> dict[str, Any] | None:
    """The event's ``data`` from the current rows; None when its subject is gone."""
    s = event.subject
    data: dict[str, Any] = {"actor": await _actor(db, s.get("actor"))}
    if event.type.startswith("run."):
        run = await db.scalar(
            select(Run)
            .where(Run.id == _uuid(s.get("run_id")))
            .execution_options(oracle_all_documents=True)
        )
        if run is None:
            return None
        doc = await _document(db, run.document_id)
        data["run"] = {
            "id": run.id,
            "flow": run.flow,
            "status": run.status,
            "title": doc.title if doc is not None else None,
            "url": app_url(f"/runs/{run.id}"),
            "error_kind": s.get("error_kind"),
        }
        if event.type.startswith("run.checkpoint_"):
            cp = await db.get(Checkpoint, _uuid(s.get("checkpoint_id")))
            if cp is None or cp.run_id != run.id:
                return None
            outcome = s.get("outcome")
            data["checkpoint"] = {
                "id": cp.id,
                "kind": cp.kind,
                "approver_role": cp.approver_role,
                "url": app_url(f"/runs/{run.id}#checkpoint-{cp.id}"),
                "outcome": outcome if outcome in ("approved", "changes_requested") else None,
            }
        return data
    doc = await _document(db, _uuid(s.get("document_id")))
    if doc is None:
        return None
    version = s.get("version")
    data["document"] = {
        "id": doc.id,
        "kind": doc.kind,
        "title": doc.title,
        "version": int(version) if version and str(version).isdigit() else None,
        "url": app_url(f"/documents/{doc.slug}"),
        "origin": s.get("origin"),
    }
    if event.type == "approval.version_approved":
        data["approver"] = data["actor"]
    if event.type == "approval.approvals_invalidated":
        data["reason"] = s.get("reason") or "edited"
    return data


async def build_body(
    db: AsyncSession, hook: Webhook, event: WebhookEvent, company: Tenant
) -> dict[str, Any] | None:
    """The JSON body for ``event`` to ``hook`` (its ``api_version``), validated by the
    type's payload model; None when the subject is gone."""
    envelope: dict[str, Any] = {
        "id": event.public_id,
        "type": event.type,
        "api_version": hook.api_version,
        "occurred_at": event.occurred_at,
        "company": {"id": company.id, "name": company.name},
    }
    if event.type == TEST_TYPE:
        envelope["occurred_at"] = event.occurred_at.isoformat()
        envelope["company"] = {"id": str(company.id), "name": company.name}
        return {**envelope, "data": {"message": TEST_MESSAGE}}
    data = await _data(db, event)
    if data is None:
        return None
    model = events.EVENT_TYPES[event.type].payload
    return model.model_validate({**envelope, "data": data}).model_dump(
        mode="json", exclude_none=True
    )


def encode(body: dict[str, Any]) -> bytes:
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()


async def withheld(db: AsyncSession, hook: Webhook, event: WebhookEvent) -> bool:
    """The send-time check (Q2): approvers-only now, and the webhook does not take it."""
    if event.type == TEST_TYPE or hook.include_approvers_content:
        return False
    return event.approvers_only or await events.approvers_only(db, event.type, event.subject)


# --- one delivery ---------------------------------------------------------------------------


@dataclass
class Prepared:
    delivery: WebhookDelivery
    hook: Webhook
    body: bytes
    headers: dict[str, str]


async def prepare(
    db: AsyncSession,
    delivery: WebhookDelivery,
    hook: Webhook,
    event: WebhookEvent,
    company: Tenant,
    now: datetime,
) -> Prepared | None:
    """Ready one delivery to send, or settle it here (withheld, given up, too large):
    None then."""
    if delivery.redelivery_of is None and now - delivery.created_at >= GIVE_UP_AFTER:
        delivery.status, delivery.next_at = "failed", None
        delivery.error = delivery.error or "expired"
        return None
    if await withheld(db, hook, event):
        delivery.status, delivery.next_at, delivery.body = "withheld", None, None
        delivery.last_at = now
        return None
    if delivery.body is None:
        body = await build_body(db, hook, event, company)
        if body is None:
            delivery.status, delivery.next_at, delivery.last_at = "withheld", None, now
            return None
        delivery.body = body
    raw = encode(delivery.body)
    if len(raw) > MAX_BODY_BYTES:
        delivery.status, delivery.next_at, delivery.error = "failed", None, "too_large"
        delivery.last_at = now
        return None
    return Prepared(delivery, hook, raw, sign.headers(hook, event.public_id, raw, now))


def record(delivery: WebhookDelivery, answer: Answer, now: datetime) -> str:
    """The answer onto the delivery; returns its new status."""
    delivery.attempts += 1
    delivery.last_at = now
    delivery.http_status = answer.http_status
    delivery.duration_ms = answer.duration_ms
    delivery.error = answer.error
    delivery.response_excerpt = answer.excerpt
    code = answer.http_status
    if answer.error is None and code is not None and 200 <= code < 300:
        delivery.status, delivery.next_at = "succeeded", None
        return delivery.status
    retry = answer.error in ("timeout", "connect", "tls") or (
        answer.error is None and code is not None and (code in RETRY_STATUSES or code >= 500)
    )
    expired = delivery.redelivery_of is None and now - delivery.created_at >= GIVE_UP_AFTER
    if not retry or expired or delivery.redelivery_of is not None:
        delivery.status, delivery.next_at = "failed", None
        return delivery.status
    if answer.retry_after is not None:
        wait = min(timedelta(seconds=answer.retry_after), RETRY_AFTER_CAP)
    else:
        wait = backoff(delivery.attempts)
    delivery.status, delivery.next_at = "retrying", now + wait
    return delivery.status


async def _pause(db: AsyncSession, hook: Webhook, reason: str, note: dict) -> None:
    hook.status, hook.paused_reason = "paused", reason
    await audit.record(
        db, None, "webhook.pause", "webhook", hook.id, {"name": hook.name, "reason": reason, **note}
    )


async def failing_since(db: AsyncSession, hook_id: uuid.UUID) -> tuple[datetime | None, int]:
    """Since when every delivery of the webhook failed (its first unsuccessful delivery
    after its last success), and how many there were; ``(None, 0)`` when not failing."""
    last_ok = await db.scalar(
        select(func.max(WebhookDelivery.last_at)).where(
            WebhookDelivery.webhook_id == hook_id, WebhookDelivery.status == "succeeded"
        )
    )
    stmt = select(func.min(WebhookDelivery.created_at), func.count(WebhookDelivery.id)).where(
        WebhookDelivery.webhook_id == hook_id,
        WebhookDelivery.status.in_(("failed", "retrying")),
        WebhookDelivery.attempts > 0,
    )
    if last_ok is not None:
        stmt = stmt.where(WebhookDelivery.created_at > last_ok)
    since, count = (await db.execute(stmt)).one()
    return since, int(count or 0)


async def after_answer(
    db: AsyncSession, hook: Webhook, delivery: WebhookDelivery, now: datetime
) -> bool:
    """410 and failing pauses; True when the webhook was paused here."""
    if hook.status != "active":
        return False
    if delivery.http_status == 410:
        await _pause(db, hook, "gone", {"http_status": 410})
        return True
    if delivery.status == "succeeded":
        return False
    since, count = await failing_since(db, hook.id)
    if since is None or count < FAILING_MIN_DELIVERIES or now - since < FAILING_PAUSE_AFTER:
        return False
    await _pause(db, hook, "failing", {"deliveries": count})
    from oracle.webhooks import service

    owners = await db.scalars(
        select(User.id).where(User.role == "owner", User.disabled_at.is_(None))
    )
    await service._notify(
        db,
        None,
        [hook.created_by, *owners],
        "webhook_paused",
        f"Webhook {hook.name} paused: failing for 3 days",
        hook,
    )
    return True


async def send_now(
    db: AsyncSession, delivery: WebhookDelivery, now: datetime | None = None
) -> WebhookDelivery:
    """Send one delivery at once, within the same 10 s cap (Send test event, Redeliver);
    the caller commits."""
    now = now or datetime.now(UTC)
    hook = await db.get(Webhook, delivery.webhook_id)
    event = await db.get(WebhookEvent, delivery.event_id)
    company = await db.get(Tenant, hook.tenant_id)
    ready = await prepare(db, delivery, hook, event, company, now)
    if ready is not None:
        async with _client(hook.url) as http:
            answer = await post(http, hook.url, ready.body, ready.headers)
        record(delivery, answer, now)
        await after_answer(db, hook, delivery, now)
    await db.flush()
    return delivery


# --- the tick -------------------------------------------------------------------------------


async def _send_hook(
    url: str, items: list[Prepared], deadline: float | None
) -> list[tuple[Prepared, Answer]]:
    """One webhook's deliveries in order, with its own client; it stops at its first
    timeout or connection failure (the rest wait), or when no call fits in the budget."""
    out: list[tuple[Prepared, Answer]] = []
    async with _client(url) as http:
        for item in items:
            if deadline is not None and deadline - time.monotonic() < call_seconds():
                break
            answer = await post(http, url, item.body, item.headers)
            out.append((item, answer))
            if answer.error in ("timeout", "connect", "tls", "not_public"):
                break
    return out


async def deliver(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    budget_seconds: float | None = None,
    out: WebhooksTick | None = None,
) -> WebhooksTick:
    """The due deliveries of the company's active webhooks, oldest first."""
    out = out or WebhooksTick()
    now = now or datetime.now(UTC)
    deadline = None if budget_seconds is None else time.monotonic() + budget_seconds
    rank = (
        func.row_number()
        .over(
            partition_by=WebhookDelivery.webhook_id,
            order_by=(WebhookDelivery.next_at, WebhookEvent.occurred_at, WebhookDelivery.id),
        )
        .label("n")
    )
    # Due together, in the order the events happened (best effort: delivery is not ordered).
    ranked = (
        select(WebhookDelivery.id, WebhookEvent.occurred_at, rank)
        .join(Webhook, Webhook.id == WebhookDelivery.webhook_id)
        .join(WebhookEvent, WebhookEvent.id == WebhookDelivery.event_id)
        .where(
            Webhook.status == "active",
            WebhookDelivery.status.in_(("pending", "retrying")),
            WebhookDelivery.next_at <= now,
        )
        .subquery()
    )
    due = list(
        await db.scalars(
            select(WebhookDelivery)
            .join(ranked, ranked.c.id == WebhookDelivery.id)
            .where(ranked.c.n <= PER_WEBHOOK)
            .order_by(WebhookDelivery.next_at, ranked.c.occurred_at, WebhookDelivery.id)
            .limit(BATCH)
            .with_for_update(of=WebhookDelivery, skip_locked=True)
        )
    )
    if not due:
        return out
    hooks = {
        h.id: h
        for h in await db.scalars(
            select(Webhook).where(Webhook.id.in_({d.webhook_id for d in due}))
        )
    }
    evts = {
        e.id: e
        for e in await db.scalars(
            select(WebhookEvent).where(WebhookEvent.id.in_({d.event_id for d in due}))
        )
    }
    company = await db.get(Tenant, next(iter(hooks.values())).tenant_id)
    by_hook: dict[uuid.UUID, list[Prepared]] = {}
    for d in due:
        ready = await prepare(db, d, hooks[d.webhook_id], evts[d.event_id], company, now)
        if ready is None:
            out.withheld += d.status == "withheld"
            out.failed += d.status == "failed"
        else:
            by_hook.setdefault(d.webhook_id, []).append(ready)
    await db.flush()
    results = await asyncio.gather(
        *(_send_hook(hooks[hid].url, items, deadline) for hid, items in by_hook.items())
    )
    for answered in results:
        for item, answer in answered:
            status = record(item.delivery, answer, now)
            out.sent += status == "succeeded"
            out.retried += status == "retrying"
            out.failed += status == "failed"
        if answered:
            await db.flush()
            last = answered[-1][0]
            out.paused += await after_answer(db, last.hook, last.delivery, now)
    await db.flush()
    return out


async def tick(
    tenant_id: uuid.UUID, *, budget_seconds: float | None = None, now: datetime | None = None
) -> WebhooksTick:
    """The tick's webhook work for one company: fan out the new events, deliver what is
    due, and once a day delete what is past the retention (Q6: 30 days)."""
    out = WebhooksTick()
    async with tenant_session(tenant_id) as db:
        out.purged = await retention.purge_due(db, tenant_id, now=now)
        out.queued = await fanout.fan_out(db, now or datetime.now(UTC))
        await db.commit()
        await deliver(db, now=now, budget_seconds=budget_seconds, out=out)
        await db.commit()
    return out
