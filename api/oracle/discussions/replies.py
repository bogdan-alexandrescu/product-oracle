"""Oracle's live replies in a discussion (G2).

When Oracle replies (owner, "Oracle reply", 2026-10-21): to every message while only one
person is in the discussion; once a second person has written or been added, only when it
is addressed (``@Oracle`` in the message, or the composer's "Ask Oracle":
``mention_oracle``).

A reply is a ``discussion_messages`` row (``author_kind`` ``oracle``) that goes
``pending`` -> ``streaming`` -> ``complete`` | ``failed`` | ``cancelled``:

- the first reader of its stream claims it (an atomic update from ``pending``, with a
  150 s lease) and runs the model call on Oracle's own Claude accounts
  (``gateway.stream``) in a task of its own, so a reader that goes away does not stop it;
  the partial body is saved at least every second or 400 characters and the lease is
  extended meanwhile;
- every other reader tails it: live from that task when it runs in this process, else
  from the row every 500 ms;
- the minute tick completes a reply nobody streamed 10 s after it was asked, and fails a
  reply whose lease ran out (``interrupted``), keeping its partial text;
- Stop sets ``cancel_requested_at``; the running call checks it every 500 ms, is cancelled
  (Claude Code's process group is killed first) and the reply ends ``cancelled`` with its
  partial text. Retry puts a failed or cancelled reply back to ``pending``.
"""

import asyncio
import contextlib
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from oracle import audit
from oracle.authz import has_role
from oracle.discussions import context
from oracle.discussions.models import Discussion, DiscussionMessage, DiscussionParticipant
from oracle.jobs import prompting
from oracle.jobs.worker import _cost, _tokens
from oracle.llm import gateway
from oracle.llm.transports import (
    LlmRateLimited,
    NoClaudeAccount,
    get_llm_settings,
)
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

log = logging.getLogger(__name__)

JOB = "discussion_reply"
MAX_TOKENS = 1500
LEASE = timedelta(seconds=150)
PENDING_GRACE = timedelta(seconds=10)
CHECK_SECONDS = 0.5
SAVE_SECONDS = 1.0
SAVE_CHARS = 400
PING_SECONDS = 15.0
WAIT_SECONDS = 120.0

CANT_REPLY = "Oracle can't reply right now."
TOO_LONG = "Oracle took too long to answer."
CUT_OFF = "Oracle's reply was cut off."
RETRIED = "discussion.reply_retry"
LIMITED = "Oracle has answered a lot here in a short time. Try again in {n} minutes."
FINAL = ("complete", "failed", "cancelled")

_ORACLE = re.compile(r"(?<![\w@])@oracle\b", re.I)
_MARKER = re.compile(r"\[c:(\d{1,4})\]")


class ReplyLimits(BaseModel):
    # Replies one person asked for within ``person_minutes``.
    person: int = 20
    person_minutes: int = 10
    # Replies in one discussion within a day.
    discussion: int = 200


class ReplySettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ORACLE_DISCUSSION_REPLY_", env_file=".env", extra="ignore"
    )

    # ``ORACLE_DISCUSSION_REPLY_LIMITS``: engineering defaults, as JSON.
    limits: ReplyLimits = ReplyLimits()


@lru_cache
def get_reply_settings() -> ReplySettings:
    return ReplySettings()


class ReplyLimited(Exception):
    def __init__(self, minutes: int):
        super().__init__(LIMITED.format(n=minutes))
        self.minutes = minutes


# --- when Oracle replies --------------------------------------------------------------


def addressed(body: str, mention_oracle: bool) -> bool:
    return mention_oracle or _ORACLE.search(body) is not None


async def people_in(db: AsyncSession, d: Discussion) -> set[uuid.UUID]:
    """Everyone who has written in it or is in it now."""
    writers = await db.scalars(
        select(DiscussionMessage.author_id).where(
            DiscussionMessage.discussion_id == d.id,
            DiscussionMessage.author_kind == "person",
            DiscussionMessage.author_id.is_not(None),
        )
    )
    members = await db.scalars(
        select(DiscussionParticipant.user_id).where(
            DiscussionParticipant.discussion_id == d.id, DiscussionParticipant.left_at.is_(None)
        )
    )
    return {u for u in writers if u} | set(members)


async def wants_reply(db: AsyncSession, d: Discussion, message: DiscussionMessage) -> bool:
    """Always while it is just one person; else only when Oracle is addressed."""
    if addressed(message.body, message.mentions_oracle):
        return True
    return len(await people_in(db, d)) <= 1


async def check_limits(db: AsyncSession, d: Discussion, person: uuid.UUID) -> None:
    """Each reply counts once, and each Retry once more (its earlier attempt ran too)."""
    limits = get_reply_settings().limits

    async def _retries(since: datetime, *where: Any) -> int:
        return (
            await db.scalar(
                select(func.count())
                .select_from(AuditEvent)
                .where(AuditEvent.action == RETRIED, AuditEvent.created_at > since, *where)
            )
            or 0
        )

    now = datetime.now(UTC)
    asked = aliased(DiscussionMessage)
    since = now - timedelta(minutes=limits.person_minutes)
    mine = await db.scalar(
        select(func.count())
        .select_from(DiscussionMessage)
        .join(asked, asked.id == DiscussionMessage.reply_to)
        .where(
            DiscussionMessage.author_kind == "oracle",
            asked.author_id == person,
            DiscussionMessage.created_at > since,
        )
    )
    if (mine or 0) + await _retries(since, AuditEvent.data["asked_by"].astext == str(person)) >= (
        limits.person
    ):
        raise ReplyLimited(limits.person_minutes)
    day_ago = now - timedelta(days=1)
    day = await db.scalar(
        select(func.count()).where(
            DiscussionMessage.discussion_id == d.id,
            DiscussionMessage.author_kind == "oracle",
            DiscussionMessage.created_at > day_ago,
        )
    )
    if (day or 0) + await _retries(day_ago, AuditEvent.entity_id == d.id) >= limits.discussion:
        raise ReplyLimited(24 * 60)


async def ask(db: AsyncSession, d: Discussion, message: DiscussionMessage) -> DiscussionMessage:
    """Oracle's ``pending`` reply to a person's message (the limits checked first)."""
    assert message.author_id is not None
    await check_limits(db, d, message.author_id)
    reply = DiscussionMessage(
        created_at=datetime.now(UTC),
        discussion_id=d.id,
        author_kind="oracle",
        via=message.via,
        body="",
        reply_to=message.id,
        status="pending",
    )
    db.add(reply)
    await db.flush()
    return reply


# --- in-process listeners ---------------------------------------------------------------


@dataclass
class _Live:
    """A reply running in this process: its text so far, the citations its complete markers
    point at (sent as they appear, #406), and who listens."""

    text: str = ""
    citations: list[dict[str, Any]] = field(default_factory=list)
    queues: list[asyncio.Queue] = field(default_factory=list)

    def publish(self, item: tuple[str, Any]) -> None:
        for q in self.queues:
            q.put_nowait(item)


_live: dict[uuid.UUID, _Live] = {}
_tasks: set[asyncio.Task] = set()


def _listen(reply_id: uuid.UUID) -> tuple[asyncio.Queue, str] | None:
    """A queue of what comes next and the text so far, when it runs here."""
    live = _live.get(reply_id)
    if live is None:
        return None
    q: asyncio.Queue = asyncio.Queue()
    if live.citations:
        q.put_nowait(("citations", live.citations))
    live.queues.append(q)
    return q, live.text


# --- running a reply --------------------------------------------------------------------


async def claim(tenant_id: uuid.UUID, reply_id: uuid.UUID) -> bool:
    """Take a ``pending`` reply to run it; False when someone else has."""
    async with tenant_session(tenant_id) as db:
        got = await db.scalar(
            update(DiscussionMessage)
            .where(DiscussionMessage.id == reply_id, DiscussionMessage.status == "pending")
            .values(
                status="streaming",
                stream_lease_until=func.now() + LEASE,
                attempts=DiscussionMessage.attempts + 1,
                cancel_requested_at=None,
            )
            .returning(DiscussionMessage.id)
            .execution_options(synchronize_session=False)
        )
        await db.commit()
    if got is not None:
        _live[reply_id] = _Live()
    return got is not None


def citations_of(body: str, ctx: context.Context) -> tuple[str, list[dict[str, Any]]]:
    """The body without markers that point at nothing, and each used marker's citation."""
    used: dict[int, dict[str, Any]] = {}

    def keep(m: re.Match) -> str:
        n = int(m.group(1))
        if n not in ctx.entries:
            return ""
        used.setdefault(n, ctx.entries[n])
        return m.group(0)

    cleaned = _MARKER.sub(keep, body)
    return cleaned, [used[n] for n in sorted(used)]


def pushback_of(body: str) -> dict[str, Any] | None:
    """A reply that starts "Pushback:": its reason and the sources it cites."""
    text = body.lstrip()
    if not text.lower().startswith("pushback:"):
        return None
    sentence = re.split(r"(?<=[.!?])\s", text[len("pushback:") :].strip(), maxsplit=1)[0]
    sources = sorted({int(n) for n in _MARKER.findall(sentence)})
    return {"reason": _MARKER.sub("", sentence).strip(), "sources": sources}


def _reason(e: BaseException) -> str:
    if isinstance(e, TimeoutError):
        return "timeout"
    if isinstance(e, NoClaudeAccount):
        return "no_account"
    if isinstance(e, LlmRateLimited):
        return "rate_limited"
    return "failed"


async def _save(tenant_id: uuid.UUID, reply_id: uuid.UUID, **values: Any) -> None:
    async with tenant_session(tenant_id) as db:
        await db.execute(
            update(DiscussionMessage)
            .where(DiscussionMessage.id == reply_id)
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        await db.commit()


async def produce(
    tenant_id: uuid.UUID,
    reply_id: uuid.UUID,
    *,
    transports: gateway.Transports | None = None,
    timeout: float | None = None,
) -> str:
    """Run a claimed reply to its end; its final status."""
    live = _live.setdefault(reply_id, _Live())
    try:
        return await _produce(tenant_id, reply_id, live, transports, timeout)
    finally:
        live.publish(("end", ""))
        _live.pop(reply_id, None)


async def _produce(
    tenant_id: uuid.UUID,
    reply_id: uuid.UUID,
    live: _Live,
    transports: gateway.Transports | None,
    timeout: float | None,
) -> str:
    settings = get_llm_settings()
    async with tenant_session(tenant_id) as db:
        reply = await db.get(DiscussionMessage, reply_id)
        assert reply is not None
        d = await db.get(Discussion, reply.discussion_id)
        assert d is not None
        ctx = await context.build(db, d, reply.id)
        name, system = prompting.current(JOB)
        reply.prompt = name
        await db.commit()
    user = (
        f"{ctx.text()}\n\nThe pushback threshold is {ctx.pushback:.2f}; the low-confidence "
        f"threshold is {ctx.low:.2f}. Reply to the last person's message."
    )
    saved = 0
    last_save = time.monotonic()

    async def save_partial() -> None:
        nonlocal saved, last_save
        saved, last_save = len(live.text), time.monotonic()
        await _save(tenant_id, reply_id, body=live.text, stream_lease_until=func.now() + LEASE)

    async def on_text(text: str) -> None:
        live.text += text
        live.publish(("delta", text))
        if "]" in text:
            cites = citations_of(live.text, ctx)[1]
            if len(cites) > len(live.citations):
                live.citations = cites
                live.publish(("citations", cites))
        if len(live.text) - saved >= SAVE_CHARS:
            await save_partial()

    async def run() -> gateway.Completion:
        async with tenant_session(tenant_id) as s:
            return await gateway.stream(
                s, system, [{"role": "user", "content": user}], MAX_TOKENS,
                job=JOB, on_text=on_text, model=settings.chat_model or None,
                transports=transports,
            )  # fmt: skip

    call = asyncio.ensure_future(asyncio.wait_for(run(), timeout or settings.chat_timeout_seconds))
    cancelled = False
    while not call.done():
        await asyncio.wait({call}, timeout=CHECK_SECONDS)
        if call.done():
            break
        async with tenant_session(tenant_id) as db:
            asked_to_stop = await db.scalar(
                select(DiscussionMessage.cancel_requested_at).where(
                    DiscussionMessage.id == reply_id
                )
            )
        if asked_to_stop is not None:
            cancelled = True
            call.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await call
            break
        if time.monotonic() - last_save >= SAVE_SECONDS:
            await save_partial()
    end: dict[str, Any] = {"stream_lease_until": None}
    if cancelled:
        await _save(tenant_id, reply_id, body=live.text, status="cancelled", **end)
        return "cancelled"
    try:
        done = call.result()
    except Exception as e:
        reason = _reason(e)
        log.info("discussion reply %s failed: %s", reply_id, reason)
        await _save(
            tenant_id, reply_id, body=live.text, status="failed", error=str(e)[:1000],
            error_reason=reason, **end,
        )  # fmt: skip
        return "failed"
    if not live.text and done.text:
        await on_text(done.text)
    body, cites = citations_of(live.text, ctx)
    inp, out = _tokens(done.usage)
    await _save(
        tenant_id, reply_id, body=body[:8000], status="complete", citations=cites,
        pushback=pushback_of(body), model=done.model, input_tokens=inp, output_tokens=out,
        cost_usd=_cost(done.usage), account_label=done.account_label, llm_via=done.via,
        error=None, error_reason=None, **end,
    )  # fmt: skip
    return "complete"


def start(
    tenant_id: uuid.UUID, reply_id: uuid.UUID, transports: gateway.Transports | None = None
) -> asyncio.Task:
    """Run a claimed reply in a task of its own: a reader leaving does not stop it."""
    task = asyncio.ensure_future(produce(tenant_id, reply_id, transports=transports))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task


async def wait(tenant_id: uuid.UUID, reply_id: uuid.UUID) -> None:
    """``?wait=true``: run the reply inline, for at most 120 s."""
    if await claim(tenant_id, reply_id):
        await produce(tenant_id, reply_id, timeout=WAIT_SECONDS)


# --- the stream ---------------------------------------------------------------------------


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def error_copy(row: DiscussionMessage, role: str | None) -> str | None:
    """What a failed reply says to this reader (3.7)."""
    if row.status != "failed":
        return None
    if row.error_reason == "timeout":
        return TOO_LONG
    if row.error_reason == "interrupted":
        return CUT_OFF
    if row.error_reason in ("no_account", "rate_limited") and role and has_role(role, "approver"):
        return row.error or CANT_REPLY
    return CANT_REPLY


async def stream(
    tenant_id: uuid.UUID,
    principal: "Principal",
    discussion_id: uuid.UUID,
    reply_id: uuid.UUID,
    transports: gateway.Transports | None = None,
) -> AsyncIterator[str]:
    """The reply's events: claim it and run it, or tail it; then its end."""
    from oracle.discussions import service

    if await claim(tenant_id, reply_id):
        listening = _listen(reply_id)
        start(tenant_id, reply_id, transports)
    else:
        listening = _listen(reply_id)
    sent = 0
    last_ping = last_check = time.monotonic()
    if listening is not None:
        q, so_far = listening
        if so_far:
            yield sse("delta", {"text": so_far})
        sent = len(so_far)
    while True:
        if time.monotonic() - last_ping >= PING_SECONDS:
            last_ping = time.monotonic()
            yield ": ping\n\n"
        if listening is not None:
            try:
                kind, data = await asyncio.wait_for(q.get(), CHECK_SECONDS)
            except TimeoutError:
                kind, data = "", ""
            if kind == "end":
                break
            if kind == "delta":
                sent += len(data)
                yield sse("delta", {"text": data})
            if kind == "citations":
                yield sse("citations", data)
            if time.monotonic() - last_check < CHECK_SECONDS:
                continue
        last_check = time.monotonic()
        async with tenant_session(tenant_id) as db:
            try:
                await service.readable(db, principal, discussion_id)
            except service.DiscussionError:
                yield sse("error", {"reason": "forbidden", "message": "", "retry": False})
                return
            row = await db.get(DiscussionMessage, reply_id)
        if row is None:
            return
        if listening is not None:
            continue
        if len(row.body) > sent:
            yield sse("delta", {"text": row.body[sent:]})
            sent = len(row.body)
        if row.status in FINAL:
            break
        if row.status == "pending" and await claim(tenant_id, reply_id):
            # Retried after this reader opened it: this reader runs it now.
            listening = _listen(reply_id)
            assert listening is not None
            q = listening[0]
            start(tenant_id, reply_id, transports)
            continue
        await asyncio.sleep(CHECK_SECONDS)
    async with tenant_session(tenant_id) as db:
        row = await db.get(DiscussionMessage, reply_id)
        assert row is not None
        if len(row.body) > sent and row.status != "complete":
            yield sse("delta", {"text": row.body[sent:]})
        if row.citations:
            yield sse("citations", row.citations)
        [out] = await service.messages_out(db, [row], principal)
        if row.status == "failed":
            yield sse(
                "error",
                {"reason": row.error_reason or "failed", "message": out.error, "retry": True},
            )
        else:
            yield sse("done", out.model_dump(mode="json"))


# --- Stop and Retry ---------------------------------------------------------------------


async def _reply_for(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, reply_id: uuid.UUID
) -> DiscussionMessage:
    from oracle.discussions import service

    d, _parts, seat = await service.readable(db, principal, discussion_id)
    reply = await db.get(DiscussionMessage, reply_id, with_for_update=True)
    if reply is None or reply.discussion_id != d.id or reply.author_kind != "oracle":
        raise service.DiscussionError(404, "Reply not found")
    asked = await db.get(DiscussionMessage, reply.reply_to) if reply.reply_to else None
    mine = asked is not None and asked.author_id == principal.user_id
    if not (mine or has_role(seat.role, "approver")):
        raise service.DiscussionError(403, "Only the person who asked, or an approver, can")
    return reply


async def cancel(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, reply_id: uuid.UUID
) -> DiscussionMessage:
    reply = await _reply_for(db, principal, discussion_id, reply_id)
    if reply.status == "pending":
        reply.status = "cancelled"
    elif reply.status == "streaming":
        reply.cancel_requested_at = datetime.now(UTC)
    await db.flush()
    return reply


async def retry(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, reply_id: uuid.UUID
) -> DiscussionMessage:
    from oracle.discussions import service

    reply = await _reply_for(db, principal, discussion_id, reply_id)
    if reply.status not in ("failed", "cancelled"):
        raise service.DiscussionError(409, "Only a failed or stopped reply can be retried")
    d = await db.get(Discussion, reply.discussion_id)
    asked = await db.get(DiscussionMessage, reply.reply_to) if reply.reply_to else None
    person = asked.author_id if asked and asked.author_id else principal.user_id
    assert d is not None and person is not None
    await check_limits(db, d, person)
    await audit.record(
        db, principal, RETRIED, service.ENTITY, d.id,
        {"reply_id": str(reply.id), "asked_by": str(person)},
    )  # fmt: skip
    reply.body, reply.status, reply.citations, reply.pushback = "", "pending", [], None
    reply.error = reply.error_reason = None
    reply.cancel_requested_at = reply.stream_lease_until = None
    reply.created_at = datetime.now(UTC)
    await db.flush()
    return reply


# --- the minute tick ----------------------------------------------------------------------


class RepliesTick(BaseModel):
    ran: int = 0
    completed: int = 0
    failed: int = 0
    interrupted: int = 0


def reply_seconds() -> float:
    return get_llm_settings().chat_timeout_seconds + 5.0


async def run_pending(
    tenant_id: uuid.UUID,
    *,
    budget_seconds: float | None = None,
    transports: gateway.Transports | None = None,
    limit: int = 20,
) -> RepliesTick:
    """Fail the replies whose lease ran out, then complete the ones nobody streamed
    10 s after they were asked, while one more still fits in the budget."""
    deadline = None if budget_seconds is None else time.monotonic() + budget_seconds
    out = RepliesTick()
    async with tenant_session(tenant_id) as db:
        gone = await db.scalars(
            update(DiscussionMessage)
            .where(
                DiscussionMessage.status == "streaming",
                DiscussionMessage.stream_lease_until < func.now(),
            )
            .values(status="failed", error_reason="interrupted", stream_lease_until=None)
            .returning(DiscussionMessage.id)
            .execution_options(synchronize_session=False)
        )
        out.interrupted = len(list(gone))
        due = list(
            await db.scalars(
                select(DiscussionMessage.id)
                .where(
                    DiscussionMessage.status == "pending",
                    DiscussionMessage.author_kind == "oracle",
                    DiscussionMessage.created_at < func.now() - PENDING_GRACE,
                )
                .order_by(DiscussionMessage.created_at)
                .limit(limit)
            )
        )
        await db.commit()
    for reply_id in due:
        if deadline is not None and deadline - time.monotonic() < reply_seconds():
            break
        if not await claim(tenant_id, reply_id):
            continue
        status = await produce(tenant_id, reply_id, transports=transports)
        out.ran += 1
        if status == "complete":
            out.completed += 1
        else:
            out.failed += 1
    return out
