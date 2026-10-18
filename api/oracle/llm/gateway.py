"""Oracle's built-in model calls (review comments, reporting, refinement), on the pool.

    text = (await gateway.complete(session, system, messages, max_tokens, job="reporting")).text

Which credential pays: an account from the company's Claude account pool
(``oracle.claude_accounts``), chosen by headroom; when the pool has no account at all,
the fallback credential (a setup-token or an API key) set on Settings > Claude accounts;
otherwise :class:`NoClaudeAccount` with the pool's reason. A pool account's access
token runs through Claude Code headless with ``CLAUDE_CODE_OAUTH_TOKEN`` set for that
call only.

Each call is one turn, so its end is the turn boundary at which SwarmCloud's runner
swaps (``runners/cliagent.py``): before the call, a hold marked ``drain`` moves; a call
the account refused for quota (a rejected ``rate_limit_event``) moves the hold to
another account (``exhausted``) and runs again there; a credential that will not read
moves it too (``unusable``). Every reading the stream carried is merged into the
account. The hold is released when the call ends, however it ends.

Agent workflows do not run here: they run in SwarmCloud on SwarmCloud's accounts.
"""

import uuid
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
from oracle.llm.transports import (
    ClaudeCodeTransport,
    LlmAuthError,
    LlmRateLimited,
    LlmRequest,
    MessagesApiTransport,
    NoClaudeAccount,
    Transport,
    TransportResult,
    get_llm_settings,
)
from oracle.tenancy import current_tenant

#: The built-in jobs that run on the pool; recorded as the hold's task.
JOBS = ("review_comments", "reporting", "refinement")

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


async def complete(
    session: AsyncSession,
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    *,
    job: str,
    model: str | None = None,
    transports: Transports | None = None,
) -> Completion:
    """Run one built-in model call for the session's company."""
    if job not in JOBS:
        raise ValueError(f"unknown built-in job {job!r}; known: {', '.join(JOBS)}")
    tenant_id = current_tenant(session)
    request = LlmRequest(
        system=system,
        messages=messages,
        max_tokens=max_tokens,
        model=model or get_llm_settings().model,
    )
    ts = transports or get_transports()
    attempt_id = uuid.uuid4().hex

    got = await pool.assign(tenant_id, job=job, attempt_id=attempt_id)
    if isinstance(got, pool.NoAccount):
        if not got.is_pool_absent:
            raise NoClaudeAccount(
                f"No Claude account can take this call: {got.message()}",
                got.reason.value,
                got.next_reset_at.isoformat() if got.next_reset_at else None,
            )
        spare = await fallback.load(session)
        if spare is None:
            raise NoClaudeAccount(NO_ACCOUNT_MESSAGE, got.reason.value)
        result = await ts.for_kind(spare.kind).complete(spare.token, request)
        return Completion(
            text=result.text,
            model=result.model,
            stop_reason=result.stop_reason,
            usage=result.usage,
            account_id=None,
            account_label=None,
            via="fallback_api_key" if spare.kind == "api_key" else "fallback_plan",
        )

    assignment: pool.Assignment = got
    swaps: list[tuple[str, str]] = []
    unusable = ""
    try:
        for attempt in range(MAX_ATTEMPTS):
            # The turn boundary: a hold marked to move (the account is draining) moves
            # before the call starts on it.
            if await pool.must_move(tenant_id, assignment) == SWAP_DRAIN:
                assignment = await _swap(tenant_id, assignment, SWAP_DRAIN, swaps)
            try:
                token = await pool.access_token(tenant_id, assignment)
            except Exception:
                # If no account can take it, the hold is released as unusable.
                unusable = "the credential could not be read"
                assignment = await _swap(tenant_id, assignment, SWAP_UNUSABLE, swaps)
                unusable = ""
                continue
            try:
                result: TransportResult = await ts.plan.complete(token, request)
            except LlmRateLimited as e:
                await _record(tenant_id, assignment.account_id, e.readings)
                if attempt == MAX_ATTEMPTS - 1:
                    raise
                assignment = await _swap(tenant_id, assignment, SWAP_EXHAUSTED, swaps)
                continue
            except LlmAuthError:
                # The access token was refused: the sweep refreshes it; this call moves.
                if attempt == MAX_ATTEMPTS - 1:
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
            f"No other Claude account can take this call ({reason}): {moved.message()}",
            moved.reason.value,
            moved.next_reset_at.isoformat() if moved.next_reset_at else None,
        )
    swaps.append((current.account_id, reason))
    return moved
