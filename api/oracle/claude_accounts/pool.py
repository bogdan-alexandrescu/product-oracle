"""Leasing an account for one built-in model call, moving it, and giving it back.

Ported from SwarmCloud's assign, release and swap routes (``quota_broker/main.py``)
and the worker's half of them (``agent_worker/accountlease.py``). In Oracle the pool and
its caller share a process, so these are function calls rather than HTTP:

    assign()   choose + acquire_hold, or a NoAccount with the reason and reset instant
    swap()     move the hold to another account in one transaction (exhausted / drain /
               unusable), or a NoAccount with the current hold untouched
    release()  give the named hold back; ``unusable`` when the credential would not read

"No account" is an answer, not an error: ``no_accounts_registered`` means the pool is
not how this company runs (use the fallback credential); every other reason is a wait.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime

from oracle.claude_accounts import store
from oracle.claude_accounts.accounts import (
    SWAP_REASONS,
    Account,
    Unavailable,
    choose,
    eligibility,
)
from oracle.company_time import DEFAULT_ZONE, in_words
from oracle.tenancy import tenant_session


@dataclass(frozen=True)
class Assignment:
    account: Account
    assignment_id: str

    @property
    def account_id(self) -> str:
        return self.account.account_id


@dataclass(frozen=True)
class NoAccount:
    reason: Unavailable
    next_reset_at: datetime | None = None

    @property
    def is_pool_absent(self) -> bool:
        return self.reason is Unavailable.NO_ACCOUNTS_REGISTERED

    def message(self, zone: str = DEFAULT_ZONE) -> str:
        """In words, the clearing time in ``zone`` (the company's), never ISO."""
        when = (
            f"; the earliest window clears {in_words(self.next_reset_at, zone)}"
            if (self.next_reset_at)
            else ""
        )
        return {
            Unavailable.NO_ACCOUNTS_REGISTERED: "no Claude account is registered",
            Unavailable.NO_ACCOUNT_AVAILABLE: "every Claude account is spent",
            Unavailable.POOL_PAUSED: (
                "every Claude account is paused, draining or needs a sign-in"
            ),
            Unavailable.NO_RECENT_READING: (
                "no Claude account has a recent usage reading; the next sweep reads them"
            ),
        }[self.reason] + when


async def _candidates(tenant_id: uuid.UUID) -> list[Account]:
    async with tenant_session(tenant_id) as s:
        return [a for a in await store.list_accounts(s) if a.provider == "anthropic"]


async def assign(
    tenant_id: uuid.UUID,
    *,
    job: str,
    attempt_id: str,
    exclude: tuple[str, ...] = (),
    now: datetime | None = None,
) -> Assignment | NoAccount:
    """Lease the best account, or say why there is none and when that changes."""
    now = now or datetime.now(UTC)
    candidates = await _candidates(tenant_id)
    skip = set(exclude)
    # Twice at most: an account chosen from the listing may stop being assignable
    # before the transaction reads it.
    for _ in range(2):
        chosen = choose(candidates, now, exclude=skip)
        if chosen is None:
            break
        held = await store.acquire_hold(
            tenant_id, chosen.account_id, now=now, task_id=job, attempt_id=attempt_id
        )
        if held is None:
            skip.add(chosen.account_id)
            continue
        assignment_id, assigned = held
        return Assignment(replace(chosen, assigned=assigned, last_assigned_at=now), assignment_id)
    reason, next_reset = eligibility(candidates, now, exclude=skip)
    return NoAccount(reason, next_reset)


async def swap(
    tenant_id: uuid.UUID,
    current: Assignment,
    *,
    reason: str,
    exclude: tuple[str, ...] = (),
    now: datetime | None = None,
) -> Assignment | NoAccount:
    """Move the job to another account; never the one it is leaving."""
    if reason not in SWAP_REASONS:
        raise ValueError(f"unknown swap reason {reason!r}; known: {', '.join(SWAP_REASONS)}")
    now = now or datetime.now(UTC)
    candidates = await _candidates(tenant_id)
    skip = {current.account_id, *exclude}
    for _ in range(2):
        chosen = choose(candidates, now, exclude=skip)
        if chosen is None:
            break
        moved = await store.swap_hold(
            tenant_id,
            current.account_id,
            chosen.account_id,
            assignment_id=current.assignment_id,
            reason=reason,
            now=now,
        )
        if moved is None:
            skip.add(chosen.account_id)
            continue
        assignment_id, assigned = moved
        return Assignment(replace(chosen, assigned=assigned, last_assigned_at=now), assignment_id)
    why, next_reset = eligibility(candidates, now, exclude=skip)
    return NoAccount(why, next_reset)


async def why_none(tenant_id: uuid.UUID, now: datetime | None = None) -> NoAccount:
    """The pool's own answer, nothing excluded: when the call gives up, this says when
    the pool clears (the account just left included, with the reading it was refused on)."""
    now = now or datetime.now(UTC)
    reason, next_reset = eligibility(await _candidates(tenant_id), now)
    return NoAccount(reason, next_reset)


async def release(tenant_id: uuid.UUID, assignment: Assignment, *, unusable: str = "") -> None:
    await store.release_hold(
        tenant_id,
        assignment.account_id,
        assignment_id=assignment.assignment_id,
        now=datetime.now(UTC),
        unusable=unusable,
    )


async def access_token(tenant_id: uuid.UUID, assignment: Assignment) -> str:
    """The account's access token, read for this call only. Raises when unreadable."""
    token = await store.DbSecretStore(tenant_id).access(store.secret_for(assignment.account))
    if not token.strip():
        raise KeyError(assignment.account_id)
    return token.strip()


async def must_move(tenant_id: uuid.UUID, assignment: Assignment) -> str | None:
    return await store.hold_move(tenant_id, assignment.account_id, assignment.assignment_id)
