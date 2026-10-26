"""Oracle's built-in model calls (review comments, reporting, refinement), on the pool.

    text = (await gateway.complete(session, system, messages, max_tokens, job="reporting")).text

Which credential pays: an account from the company's Claude account pool
(``oracle.claude_accounts``), chosen by headroom; when the pool has no account at all or
every account is spent, the fallback credential (a setup-token or an API key) set on
Settings > Claude accounts (``fallback.covers``); otherwise :class:`NoClaudeAccount`
with the pool's reason. A pool account's access
token runs through Claude Code headless with ``CLAUDE_CODE_OAUTH_TOKEN`` set for that
call only.

Each call is one turn, so its end is the turn boundary at which SwarmCloud's runner
swaps (``runners/cliagent.py``): before the call, a hold marked ``drain`` moves; a call
the account refused for quota (a rejected ``rate_limit_event``) moves the hold to
another account (``exhausted``) and runs again there; a credential that will not read
moves it too (``unusable``). Every reading the stream carried is merged into the
account. The hold is released when the call ends, however it ends (a cancelled call's
Claude Code process is gone first, ``transports``), and a call cancelled while its
account was being assigned gives back the hold that assignment took.

A caller with a time limit (the run ticker) passes ``deadline`` (``time.monotonic()``):
no account swap or call starts unless a whole call (``ORACLE_LLM_TIMEOUT_SECONDS``) still
fits before it; :class:`LlmOutOfTime`, a transient failure, instead. ``on_call`` is told
the account (label, via) each time a call starts, so a caller cut off mid-call knows one
had.

Agent workflows do not run here: they run in SwarmCloud on SwarmCloud's accounts.
"""

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.claude_accounts import fallback, pool, store
from oracle.claude_accounts.accounts import (
    SWAP_DRAIN,
    SWAP_EXHAUSTED,
    SWAP_UNUSABLE,
    WindowReading,
)
from oracle.company_time import company_time_zone
from oracle.llm.transports import (
    ClaudeCodeTransport,
    LlmAuthError,
    LlmOutOfTime,
    LlmRateLimited,
    LlmRequest,
    MessagesApiTransport,
    NoClaudeAccount,
    OnText,
    Transport,
    TransportResult,
    get_llm_settings,
)
from oracle.tenancy import current_tenant, tenant_session

log = logging.getLogger(__name__)

#: The built-in jobs that run on the pool; recorded as the hold's task.
JOBS = (
    "review_comments",
    "reporting",
    "refinement",
    "quality_review",
    "refinement_batch",
    "intake_analysis",
    "decision_options",
    # C7: Enhance on a requirement at the feature-set review.
    "scope_enhance",
    # H10: the why-not replies a person waits for after Disqualify.
    "why_not_reply",
    # O5: a roadmap's public item texts, drafted for a person to approve.
    "public_text",
    # C9: Oracle reads a person's reason for a move or pin against the evidence.
    "override_reason_check",
    # C3 Interviews: a customer interview's guide and snapshot (queued) and its turns
    # (inline, in the customer's request).
    "interview_guide",
    "interview_turn",
    "interview_snapshot",
    # G2 Live replies: what a person waits for in a discussion.
    "discussion_reply",
    # G3: a discussion's summary draft for the people and agents who did not read it.
    "discussion_summary",
)

#: Accounts one call may try before giving up (the first plus two swaps).
MAX_ATTEMPTS = 3

NO_ACCOUNT_MESSAGE = (
    "No Claude account: an owner adds one on Settings > Claude accounts (or sets a "
    "fallback setup-token or API key there)"
)


@dataclass
class Transports:
    plan: Transport = field(default_factory=ClaudeCodeTransport)
    api_key: Transport = field(default_factory=MessagesApiTransport)

    def for_kind(self, kind: str) -> Transport:
        return self.api_key if kind == "api_key" else self.plan


_transports: Transports | None = None


def get_transports() -> Transports:
    global _transports
    if _transports is None:
        _transports = Transports()
    return _transports


def set_transports(transports: Transports | None) -> Transports | None:
    """Replace the transports (tests); returns the previous ones."""
    global _transports
    previous, _transports = _transports, transports
    return previous


@dataclass(frozen=True)
class Completion:
    text: str
    model: str
    stop_reason: str | None
    usage: dict[str, Any]
    # The pool account that ran it, or None when the fallback credential did.
    account_id: str | None
    account_label: str | None
    via: Literal["account", "fallback_plan", "fallback_api_key"]
    # Accounts the call moved off, and why, in order.
    swaps: list[tuple[str, str]] = field(default_factory=list)


def _windows(readings: dict[str, dict[str, Any]]) -> dict[str, WindowReading]:
    out: dict[str, WindowReading] = {}
    now = datetime.now(UTC)
    for name, r in readings.items():
        try:
            resets = datetime.fromisoformat(str(r["resets_at"]))
            utilization = float(r["utilization"])
        except (KeyError, TypeError, ValueError):
            continue
        # A window whose reset has passed says nothing about the account any more.
        if resets > now and 0.0 <= utilization <= 1.0:
            out[name] = WindowReading(utilization=utilization, resets_at=resets)
    return out


async def _record(tenant_id: uuid.UUID, account_id: str, readings: dict[str, Any]) -> None:
    windows = _windows(readings)
    if windows:
        await store.record_reading(tenant_id, account_id, windows, datetime.now(UTC))


def _time_for_a_call(deadline: float | None) -> None:
    """Raise :class:`LlmOutOfTime` unless a whole call still fits before ``deadline``."""
    if deadline is None:
        return
    if deadline - time.monotonic() < get_llm_settings().timeout_seconds:
        raise LlmOutOfTime("No time left for a whole model call before the deadline")


#: One call on one transport with one token.
Call = Callable[[Transport, str], Awaitable[TransportResult]]


async def complete(
    session: AsyncSession,
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    *,
    job: str,
    model: str | None = None,
    transports: Transports | None = None,
    deadline: float | None = None,
    on_call: Callable[[str | None, str], None] | None = None,
) -> Completion:
    """Run one built-in model call for the session's company."""
    request = _request(system, messages, max_tokens, job, model)

    async def call(transport: Transport, token: str) -> TransportResult:
        return await transport.complete(token, request)

    return await _run(session, job, call, transports, deadline, on_call, lambda: False)


async def stream(
    session: AsyncSession,
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    *,
    job: str,
    on_text: OnText,
    model: str | None = None,
    transports: Transports | None = None,
    deadline: float | None = None,
    on_call: Callable[[str | None, str], None] | None = None,
) -> Completion:
    """As :func:`complete`, telling ``on_text`` each piece of the answer as it arrives.

    The same assignment, hold, swap and release. A swap happens only before the first
    piece of text: once text was sent, a rate limit or a refused credential ends the
    call (:class:`LlmRateLimited`, :class:`LlmAuthError`), so no answer repeats text."""
    request = _request(system, messages, max_tokens, job, model)
    sent = False

    async def told(text: str) -> None:
        nonlocal sent
        sent = True
        await on_text(text)

    async def call(transport: Transport, token: str) -> TransportResult:
        return await transport.stream(token, request, told)

    return await _run(session, job, call, transports, deadline, on_call, lambda: sent)


def _request(
    system: str, messages: list[dict[str, Any]], max_tokens: int, job: str, model: str | None
) -> LlmRequest:
    if job not in JOBS:
        raise ValueError(f"unknown built-in job {job!r}; known: {', '.join(JOBS)}")
    return LlmRequest(
        system=system,
        messages=messages,
        max_tokens=max_tokens,
        model=model or get_llm_settings().model,
    )


async def _run(
    session: AsyncSession,
    job: str,
    call: Call,
    transports: Transports | None,
    deadline: float | None,
    on_call: Callable[[str | None, str], None] | None,
    sent: Callable[[], bool],
) -> Completion:
    """The account loop ``complete`` and ``stream`` share. ``sent``: whether text has
    reached the caller already, after which nothing moves to another account."""
    tenant_id = current_tenant(session)
    ts = transports or get_transports()
    attempt_id = uuid.uuid4().hex

    got = await _assign(tenant_id, job=job, attempt_id=attempt_id)
    if isinstance(got, pool.NoAccount):
        spare = None
        if fallback.covers(got.reason):
            # Its own short session: the caller's connection is not held across the call.
            async with tenant_session(tenant_id) as read:
                spare = await fallback.load(read)
        if spare is None and got.is_pool_absent:
            raise NoClaudeAccount(NO_ACCOUNT_MESSAGE, got.reason.value)
        if spare is None:
            raise NoClaudeAccount(
                f"No Claude account can take this call: {got.message(await _zone(tenant_id))}",
                got.reason.value,
                got.next_reset_at.isoformat() if got.next_reset_at else None,
            )
        via = "fallback_api_key" if spare.kind == "api_key" else "fallback_plan"
        _time_for_a_call(deadline)
        if on_call is not None:
            on_call(None, via)
        result = await call(ts.for_kind(spare.kind), spare.token)
        return Completion(
            text=result.text,
            model=result.model,
            stop_reason=result.stop_reason,
            usage=result.usage,
            account_id=None,
            account_label=None,
            via=via,
        )

    assignment: pool.Assignment = got
    swaps: list[tuple[str, str]] = []
    unusable = ""
    try:
        for attempt in range(MAX_ATTEMPTS):
            # The turn boundary: a hold marked to move (the account is draining) moves
            # before the call starts on it.
            if await pool.must_move(tenant_id, assignment) == SWAP_DRAIN:
                _time_for_a_call(deadline)
                assignment = await _swap(tenant_id, assignment, SWAP_DRAIN, swaps)
            try:
                token = await pool.access_token(tenant_id, assignment)
            except Exception:
                # If no account can take it, the hold is released as unusable.
                unusable = "the credential could not be read"
                _time_for_a_call(deadline)
                assignment = await _swap(tenant_id, assignment, SWAP_UNUSABLE, swaps)
                unusable = ""
                continue
            _time_for_a_call(deadline)
            if on_call is not None:
                on_call(assignment.account.label, "account")
            try:
                result: TransportResult = await call(ts.plan, token)
            except LlmRateLimited as e:
                await _record(tenant_id, assignment.account_id, e.readings)
                if attempt == MAX_ATTEMPTS - 1 or sent():
                    raise
                _time_for_a_call(deadline)
                assignment = await _swap(tenant_id, assignment, SWAP_EXHAUSTED, swaps)
                continue
            except LlmAuthError:
                # The access token was refused: the sweep refreshes it; this call moves.
                if attempt == MAX_ATTEMPTS - 1 or sent():
                    unusable = "the access token was refused"
                    raise
                try:
                    _time_for_a_call(deadline)
                except LlmOutOfTime:
                    # As on the last attempt: no other account will try it.
                    unusable = "the access token was refused"
                    raise
                assignment = await _swap(tenant_id, assignment, SWAP_UNUSABLE, swaps)
                continue
            await _record(tenant_id, assignment.account_id, result.readings)
            return Completion(
                text=result.text,
                model=result.model,
                stop_reason=result.stop_reason,
                usage=result.usage,
                account_id=assignment.account_id,
                account_label=assignment.account.label,
                via="account",
                swaps=swaps,
            )
        unusable = "no account's credential could be read"
        raise NoClaudeAccount("No Claude account's credential could be read", "unusable")
    finally:
        await pool.release(tenant_id, assignment, unusable=unusable)


async def _assign(
    tenant_id: uuid.UUID, *, job: str, attempt_id: str
) -> pool.Assignment | pool.NoAccount:
    """``pool.assign``, shielded: cancelled meanwhile, the hold it took is given back
    before the cancel goes on (the release in ``complete`` has no assignment yet)."""
    assigning = asyncio.ensure_future(pool.assign(tenant_id, job=job, attempt_id=attempt_id))
    try:
        return await asyncio.shield(assigning)
    except asyncio.CancelledError:
        giving_back = asyncio.ensure_future(_give_back(tenant_id, assigning))
        while not giving_back.done():
            try:
                await asyncio.shield(giving_back)
            except asyncio.CancelledError:
                pass  # cancelled again: the hold still goes back first
        raise


async def _give_back(
    tenant_id: uuid.UUID, assigning: "asyncio.Future[pool.Assignment | pool.NoAccount]"
) -> None:
    try:
        got = await assigning
    except Exception:
        return  # nothing was assigned
    if isinstance(got, pool.Assignment):
        try:
            await pool.release(tenant_id, got)
        except Exception:
            log.exception("could not give back the hold of a call cancelled while assigned")


async def _zone(tenant_id: uuid.UUID) -> str:
    """The company's time zone, which a refusal words its clearing time in."""
    async with tenant_session(tenant_id) as s:
        return await company_time_zone(s)


class _NoSwap(NoClaudeAccount):
    pass


async def _swap(
    tenant_id: uuid.UUID, current: pool.Assignment, reason: str, swaps: list[tuple[str, str]]
) -> pool.Assignment:
    moved = await pool.swap(tenant_id, current, reason=reason)
    if isinstance(moved, pool.NoAccount):
        if moved.next_reset_at is None:
            whole = await pool.why_none(tenant_id)
            if whole.next_reset_at is not None:
                moved = whole
        raise _NoSwap(
            f"No other Claude account can take this call ({reason}): "
            f"{moved.message(await _zone(tenant_id))}",
            moved.reason.value,
            moved.next_reset_at.isoformat() if moved.next_reset_at else None,
        )
    swaps.append((current.account_id, reason))
    return moved
