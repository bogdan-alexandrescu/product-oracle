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

Live reads (#710): in a private chat that only its asker is in, an asker with a live
connection (v1: Fireflies) gets a run that may read it: an ``olt_`` token for this reply
(oracle.live.tokens), Oracle's ``/mcp`` as the run's one MCP server (Claude Code only),
and a "Live sources" block in the prompt; ``[l:n]`` markers cite the reads
(``live_reads``). The token is revoked when the reply ends. With others in it the
prompt says live reads are off; an asker with no live connection gets one line (C6), on
Claude Code only. The token is minted only when the gateway runs the reply on Claude Code
(never for the Messages API).
"""

import asyncio
import contextlib
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from functools import lru_cache, partial
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from oracle import audit, autonomy
from oracle.authz import has_role
from oracle.claude_accounts.pool import readable_refusal
from oracle.company_time import DEFAULT_ZONE
from oracle.config import get_settings
from oracle.connections import service as connections
from oracle.discussions import changes, context
from oracle.discussions import plan as plan_ctx
from oracle.discussions.models import Discussion, DiscussionMessage, DiscussionParticipant
from oracle.docs import visibility
from oracle.jobs import prompting
from oracle.jobs.worker import _cost, _tokens
from oracle.live import tokens
from oracle.live.models import LiveRead
from oracle.llm import gateway
from oracle.llm.transports import (
    LlmRateLimited,
    McpServer,
    NoClaudeAccount,
    get_llm_settings,
)
from oracle.models import AuditEvent
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import tenant_session

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

log = logging.getLogger(__name__)

JOB = "discussion_reply"
GOAL_JOB = "discussion_reply_goal"
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
_LIVE_MARKER = re.compile(r"\[l:(\d{1,4})\]")

# #710: the providers with live tools, and their names.
LIVE_PROVIDERS = {"fireflies": "Fireflies"}
# Not live because others can read the discussion (section 2.4; the panel says the same).
OFF_HERE = (
    "Live reads are off: others can read this discussion. If a question needs a live read "
    "of the asker's sources, say so."
)
# C6: the one line for an asker with no live connection.
NO_LIVE_CONNECTION = (
    'If you are asked about a source such as Fireflies meetings, say: "You have no '
    'Fireflies connection. Connect one in Settings > Connections."'
)


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


async def opening(
    db: AsyncSession, d: Discussion, person: uuid.UUID, via: str = "web"
) -> DiscussionMessage:
    """Oracle's ``pending`` first turn in a discussion a person started for it to open
    (B6's goals interview): there is no message to answer yet."""
    await check_limits(db, d, person)
    reply = DiscussionMessage(
        created_at=datetime.now(UTC), discussion_id=d.id, author_kind="oracle", via=via,
        body="", status="pending",
    )  # fmt: skip
    db.add(reply)
    await db.flush()
    return reply


# --- live reads (#710) -------------------------------------------------------------------


@dataclass
class LivePlan:
    """What a reply gets of its asker's live sources."""

    # Live on Claude Code: only the asker in the private chat, a live connection, the
    # switch on (section 2.1; the transport is the gateway's to know).
    live: bool = False
    # The reply's live token, when minted: the run may read live (Claude Code only).
    token: str | None = None
    # The prompt's "Live sources" block, when live.
    block: str = ""
    # A prompt line for any transport: live reads are off because others read it (2.4).
    line: str = ""
    # A prompt line for Claude Code only: the asker has no live connection (C6).
    mcp_line: str = ""


async def asker_of(db: AsyncSession, d: Discussion, reply: DiscussionMessage) -> uuid.UUID | None:
    asked = await db.get(DiscussionMessage, reply.reply_to) if reply.reply_to else None
    # An opening turn (B6) answers nobody: it is its starter's.
    return asked.author_id if asked is not None else d.started_by


def live_block(sources: list[Any]) -> str:
    lines = [
        "Live sources: you can read the asker's own connected sources at this moment with "
        f"the live_* tools, at most {tokens.MAX_READS} calls in this answer. The asker's "
        "connections:",
        *(
            f"- {s.account_label or LIVE_PROVIDERS[s.provider]} "
            f"({LIVE_PROVIDERS[s.provider]}, connection_id {s.id})"
            for s in sources
        ),
        "Every tool result carries cite.ref (l:1, l:2, ...). Cite every fact you take from "
        "a tool result with its ref as [l:n], for example [l:1]. Never state a count, a "
        "meeting or any detail of one that did not come from a tool result in this answer; "
        f'when a tool answers with an error, say only "{plan_ctx.SOURCE_DOWN}", never its '
        "code or the source's name.",
    ]
    return "\n".join(lines)


async def live_plan(
    db: AsyncSession, d: Discussion, reply: DiscussionMessage, *, mint: bool = True
) -> LivePlan:
    """Section 2.1: live when only the asker is in the (private) discussion, the asker has
    an active live connection and ``ORACLE_LIVE_READS`` is not off (and the transport is
    Claude Code: the caller asks with ``mint`` only for a run on it). Minting, the token
    is made with the discussion row ``FOR SHARE`` (C3), so a join either came first (and
    is seen here) or comes after the token (and is refused). C6's line goes only where a
    live read could happen but for the connection. The caller commits."""
    if get_settings().live_reads == "off":
        return LivePlan()
    asker = await asker_of(db, d, reply)
    if asker is None:
        return LivePlan()
    sources = [
        c
        for c in await connections.list_for_user(db, asker)
        if c.provider in LIVE_PROVIDERS and c.status == "active"
    ]
    visibility_now = select(Discussion.visibility).where(Discussion.id == d.id)
    if mint:
        visibility_now = visibility_now.with_for_update(read=True)
    if await db.scalar(visibility_now) != "private" or await people_in(db, d) != {asker}:
        return LivePlan(line=OFF_HERE if sources else "")
    if not sources:
        return LivePlan(mcp_line=NO_LIVE_CONNECTION)
    block = live_block(sources)
    if not mint:
        return LivePlan(live=True, block=block)
    raw = await tokens.mint(db, asker, reply.id)
    return LivePlan(live=True, token=raw, block=block)


async def _for_claude_code(
    tenant_id: uuid.UUID, reply_id: uuid.UUID, system: str
) -> tuple[str, McpServer | None]:
    """A Claude Code run's system prompt and MCP server: the live decision taken again,
    minting the token, when the gateway is about to run the reply on Claude Code (2.1)."""
    async with tenant_session(tenant_id) as db:
        reply = await db.get(DiscussionMessage, reply_id)
        d = await db.get(Discussion, reply.discussion_id) if reply is not None else None
        plan = await live_plan(db, d, reply) if d is not None else LivePlan()
        await db.commit()
    extra = "\n\n".join(x for x in (plan.line, plan.mcp_line, plan.block) if x)
    system = f"{system.rstrip()}\n\n{extra}" if extra else system
    if plan.token is None:
        return system, None
    url = get_runtime_settings().public_url.rstrip("/") + "/mcp"
    return system, McpServer(url=url, token=plan.token)


async def live_citations(tenant_id: uuid.UUID, reply_id: uuid.UUID) -> dict[int, dict[str, Any]]:
    """The reply's successful live reads by ref number, as citations (section 4)."""
    async with tenant_session(tenant_id) as db:
        rows = await db.scalars(
            # A call in flight holds its ref with status 'error' until it settles (C1).
            select(LiveRead).where(
                LiveRead.message_id == reply_id,
                LiveRead.ref_n.is_not(None),
                LiveRead.status != "error",
            )
        )
        return {
            r.ref_n: {
                "kind": "live",
                "ref": f"l:{r.ref_n}",
                "source": r.source_label,
                "call": r.tool,
                "read_at": r.read_at.isoformat(),
                "item_id": r.item_id,
            }
            for r in rows
            if r.ref_n is not None
        }


async def _revoke(tenant_id: uuid.UUID, reply_ids: list[uuid.UUID]) -> None:
    try:
        async with tenant_session(tenant_id) as db:
            for reply_id in reply_ids:
                await tokens.revoke(db, reply_id)
            await db.commit()
    except Exception:
        # It expires in 10 minutes anyway, and every call re-checks the reply.
        log.exception("could not revoke the live tokens of replies %s", reply_ids)


# --- in-process listeners ---------------------------------------------------------------


@dataclass
class _Live:
    """A reply running in this process: its text so far, the citations its complete markers
    point at (sent as they appear, #406), and who listens."""

    text: str = ""
    citations: list[dict[str, Any]] = field(default_factory=list)
    queues: list[asyncio.Queue] = field(default_factory=list)
    # What readers see of the text (a goal reply's change block is not shown, B6).
    visible: Callable[[str], str] = field(default=lambda text: text)

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
    return q, live.visible(live.text)


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


def citations_of(
    body: str, ctx: context.Context, live: dict[int, dict[str, Any]] | None = None
) -> tuple[str, list[dict[str, Any]]]:
    """The body without markers that point at nothing, and each used marker's citation:
    ``[c:n]`` from the context, then ``[l:n]`` from the reply's live reads (``live``)."""
    used: dict[int, dict[str, Any]] = {}
    read: dict[int, dict[str, Any]] = {}

    def keep(m: re.Match) -> str:
        n = int(m.group(1))
        if n not in ctx.entries:
            return ""
        used.setdefault(n, ctx.entries[n])
        return m.group(0)

    def keep_live(m: re.Match) -> str:
        n = int(m.group(1))
        if not live or n not in live:
            return ""
        read.setdefault(n, live[n])
        return m.group(0)

    cleaned = _LIVE_MARKER.sub(keep_live, _MARKER.sub(keep, body))
    return cleaned, [used[n] for n in sorted(used)] + [read[n] for n in sorted(read)]


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
        # Complete, failed or cancelled: the reply's live token reads no more (#710).
        await _revoke(tenant_id, [reply_id])
        live.publish(("end", ""))
        _live.pop(reply_id, None)


async def _produce(
    tenant_id: uuid.UUID,
    reply_id: uuid.UUID,
    live: _Live,
    transports: gateway.Transports | None,
    timeout: float | None,
) -> str:
    from oracle.baseline import goal_interview

    settings = get_llm_settings()
    async with tenant_session(tenant_id) as db:
        reply = await db.get(DiscussionMessage, reply_id)
        assert reply is not None
        d = await db.get(Discussion, reply.discussion_id)
        assert d is not None
        # Every member in the discussion reads the reply: its context is what a commenter
        # may see, not Oracle's full view (#584 review), unless only approvers can be in it.
        if await context.member_view(db, d):
            visibility.bind(db, visibility.MEMBER)
        ctx = await context.build(db, d, reply.id)
        name, system = prompting.current(JOB)
        # B6: on a goal, the goals interview's instructions follow the house rules.
        goal = await goal_interview.goal_of(db, d)
        offer = ""
        if goal is not None:
            extra, more = prompting.current(GOAL_JOB)
            name, system = f"{name}+{extra}", f"{system}\n\n{more}"
            live.visible = goal_interview.visible
            # H11 Shape goals: ask for as many versions as the level keeps (#586 review).
            offer = goal_interview.offer_line(await autonomy.level(db, "goals"))
        reply.prompt = name
        plan = await live_plan(db, d, reply, mint=False)
        await db.commit()
        notes = await changes.prompt_notes(db, d)
    if ctx.plan:  # Simple's Ask: the plan first, the sources only after (and plainly)
        system = f"{system.rstrip()}\n\n{plan_ctx.PLAN_FIRST}"
    mcp = None
    if plan.live or plan.mcp_line:
        # Only a run on Claude Code asks: its token is minted then (2.1).
        mcp = partial(_for_claude_code, tenant_id, reply_id, system)
    if plan.line:
        system = f"{system.rstrip()}\n\n{plan.line}"
    asked = "Open the interview." if ctx.opening else "Reply to the last person's message."
    asked = f"{offer} {asked}" if offer else asked
    user = (
        f"{ctx.text()}\n\n{notes}\n\nThe pushback threshold is {ctx.pushback:.2f}; the "
        f"low-confidence threshold is {ctx.low:.2f}. {asked}"
    )
    shown = live.visible
    saved = 0
    last_save = time.monotonic()
    # G3: the delimiter and the changes after it never reach the chat.
    held = changes.HoldBack()

    async def save_partial() -> None:
        nonlocal saved, last_save
        saved, last_save = len(live.text), time.monotonic()
        await _save(
            tenant_id, reply_id, body=shown(live.text), stream_lease_until=func.now() + LEASE
        )

    async def on_text(text: str) -> None:
        await show(held.feed(text))

    async def show(text: str) -> None:
        if not text:
            return
        before = shown(live.text)
        live.text += text
        delta = shown(live.text)[len(before) :]
        if delta:
            live.publish(("delta", delta))
        if "]" in text:
            reads = await live_citations(tenant_id, reply_id) if "[l:" in live.text else None
            cites = citations_of(live.text, ctx, reads)[1]
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
                transports=transports, mcp=mcp,
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
    # A stopped or failed reply keeps its text so far, the held-back end included.
    await show(held.flush())
    if cancelled:
        await _save(tenant_id, reply_id, body=shown(live.text), status="cancelled", **end)
        return "cancelled"
    try:
        done = call.result()
    except Exception as e:
        reason = _reason(e)
        log.info("discussion reply %s failed: %s", reply_id, reason)
        await _save(
            tenant_id, reply_id, body=shown(live.text), status="failed", error=str(e)[:1000],
            error_reason=reason, **end,
        )  # fmt: skip
        return "failed"
    if not held.seen and done.text:
        await on_text(done.text)
    await show(held.flush())
    # B6 and G3 share the delimiter: on a goal, the versions block (a JSON array) stays for
    # goal_interview and G3's changes (a JSON object) are taken out.
    text, tail = live.text, held.tail
    if goal is not None and tail is not None:
        text, tail = changes.split_goal_reply(f"{text}{changes.DELIMITER}{tail}")
    text, versions = goal_interview.take_changes(text) if goal is not None else (text, [])
    reads = await live_citations(tenant_id, reply_id) if "[l:" in text else None
    body, cites = citations_of(text, ctx, reads)
    # A source that failed is never shown raw: at most one plain line.
    plain = plan_ctx.plain_failures(body) if ctx.plan or plan.live else body
    if plain != body:
        log.info("discussion reply %s: a source's failure shown plainly", reply_id)
        body = plain
    inp, out = _tokens(done.usage)
    await _save(
        tenant_id, reply_id, body=body[:8000], status="complete", citations=cites,
        pushback=pushback_of(body), model=done.model, input_tokens=inp, output_tokens=out,
        cost_usd=_cost(done.usage), account_label=done.account_label, llm_via=done.via,
        error=None, error_reason=None, **end,
    )  # fmt: skip
    if versions:
        await goal_interview.keep_versions(tenant_id, reply_id, versions, ctx.entries)
    if tail is not None:
        await _extract(tenant_id, reply_id, tail, ctx)
    return "complete"


async def _extract(tenant_id: uuid.UUID, reply_id: uuid.UUID, tail: str, ctx: Any) -> None:
    """G3: the reply's changes, written before its stream sends ``done``."""
    async with tenant_session(tenant_id) as db:
        reply = await db.get(DiscussionMessage, reply_id)
        d = await db.get(Discussion, reply.discussion_id) if reply else None
        if reply is None or d is None:
            return
        await changes.extract(db, d, reply, tail, ctx)
        await db.commit()


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


@dataclass
class _Guard:
    """What one reader is sent of an Oracle message as it streams (#606 re-review): as the
    message list shows it (``research.for_reader``). For a reader to whom something is
    hidden (``hidden``), the text that names it is never sent (the rest of the message is
    withheld, and ``done`` says so), its tail is held back until no hidden name can still
    be in the making, and a citation naming it is dropped. Owners and approvers
    (``hidden`` None) get every delta as it comes."""

    hidden: visibility.Hidden | None
    text: str = ""
    sent: int = 0
    withheld: bool = False
    hold: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        if self.hidden is not None:
            # The longest hidden name, and a ``D-<n>`` with its digits.
            names = (*self.hidden.words, *self.hidden.ids)
            self.hold = max((len(n) for n in names), default=0) + 8

    def take(self, more: str, final: bool = False) -> str:
        """``more`` text of the message; what may be sent of it now."""
        self.text += more
        if self.withheld:
            return ""
        if self.hidden is not None and self.hidden.names(self.text):
            self.withheld = True
            return ""
        upto = len(self.text) if final else max(self.sent, len(self.text) - self.hold)
        out, self.sent = self.text[self.sent : upto], upto
        return out

    def citations(self, cites: list[dict[str, Any]]) -> list[dict[str, Any]]:
        from oracle.discussions import research

        if self.hidden is None:
            return cites
        if self.withheld:
            return []
        return [c for c in cites if not research._hides(self.hidden, c)]


def error_copy(row: DiscussionMessage, role: str | None, zone: str = DEFAULT_ZONE) -> str | None:
    """What a failed reply says to this reader (3.7): the gateway's refusal as it was then,
    in ``zone`` (the company's), not now (#644 re-review)."""
    if row.status != "failed":
        return None
    if row.error_reason == "timeout":
        return TOO_LONG
    if row.error_reason == "interrupted":
        return CUT_OFF
    if row.error_reason in ("no_account", "rate_limited") and role and has_role(role, "approver"):
        return readable_refusal(row.error, zone, past=True) or CANT_REPLY
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

    # The reader's view, as the message list reads it (#606 re-review: the stream withheld
    # nothing, and its sessions were Oracle's own, which sees everything).
    async with tenant_session(tenant_id) as db:
        visibility.bind(db, principal)
        guard = _Guard(await visibility.hidden_for_reader(db))
    if await claim(tenant_id, reply_id):
        listening = _listen(reply_id)
        start(tenant_id, reply_id, transports)
    else:
        listening = _listen(reply_id)
    sent = 0
    last_ping = last_check = time.monotonic()
    if listening is not None:
        q, so_far = listening
        if text := guard.take(so_far):
            yield sse("delta", {"text": text})
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
                if text := guard.take(data):
                    yield sse("delta", {"text": text})
            if kind == "citations" and (cites := guard.citations(data)):
                yield sse("citations", cites)
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
            if text := guard.take(row.body[sent:]):
                yield sse("delta", {"text": text})
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
        visibility.bind(db, principal)
        row = await db.get(DiscussionMessage, reply_id)
        assert row is not None
        rest = row.body[sent:] if row.status != "complete" else ""
        # What was held back, once the whole text is checked.
        if text := guard.take(rest, final=True):
            yield sse("delta", {"text": text})
        # ``done`` and the citations as the list shows them (research.for_reader).
        [out] = await service.messages_out(db, [row], principal)
        if cites := guard.citations(out.citations):
            yield sse("citations", cites)
        if row.status == "complete":
            made = await _changes_of(db, principal, row)
            if made:
                yield sse("changes", [c.model_dump(mode="json") for c in made])
        if row.status == "failed":
            yield sse(
                "error",
                {"reason": row.error_reason or "failed", "message": out.error, "retry": True},
            )
        else:
            yield sse("done", out.model_dump(mode="json"))


async def _changes_of(db: AsyncSession, principal: "Principal", reply: DiscussionMessage) -> list:
    from oracle.discussions import service
    from oracle.discussions.models import DiscussionChange

    ids = list(
        await db.scalars(
            select(DiscussionChange.id).where(DiscussionChange.from_message_id == reply.id)
        )
    )
    if not ids:
        return []
    d, _parts, seat = await service.readable(db, principal, reply.discussion_id)
    return await changes.list_changes(db, principal, d, seat, ids=ids)


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
    # An opening turn (B6) answers nobody: it is its starter's.
    asker = asked.author_id if asked is not None else d.started_by
    mine = principal.user_id is not None and asker == principal.user_id
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
        gone = list(gone)
        out.interrupted = len(gone)
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
    if gone:
        await _revoke(tenant_id, gone)
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
