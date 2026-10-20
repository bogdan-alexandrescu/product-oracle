"""The pool's sweep: reclaim abandoned holds, refresh every credential, read usage.

Ported from SwarmCloud's ``/v1/quota/sweep`` (``quota_broker/main.py``:
``_prune_all_holds``, ``_sweep_account_pool``, ``_record_refreshes``, ``_poll_block``,
``_credential_phase``) and ``quota_broker/sweeplease.py``. Cloud Scheduler is replaced
by the run ticker, ``oracle tick`` (``POST /v1/internal/tick``) and a background task in
the API process (``ORACLE_CLAUDE_SWEEP_SECONDS``, every five minutes by default; not
started while the run ticker is configured). Each sweeps a company only when its last
sweep completed more than ``ORACLE_CLAUDE_SWEEP_SECONDS`` ago (``sweep_if_due``), and no
sweep -- from those, the owner's "sweep now" or any number of processes -- starts
within ``MIN_SWEEP_INTERVAL`` (five minutes) of the last one's completion: that is
checked again under the lease, in the transaction that takes it (``acquire_lease``), so
two callers that both read a company as due sweep it once. The usage endpoint allows
about five calls per five minutes per account.

The hold backstop runs outside the lease (it is idempotent). The credential phase --
every exchange and every usage poll -- runs under the company's sweep lease, renewed
before each step (``LeaseFence``), so two sweeps never present the same refresh token
at once. It FAILS CLOSED: no lease, no exchange. The lease also records when the sweep
last completed and how, which the accounts screen shows, and until when a 429 from the
usage endpoint asked to wait (``usage_retry_at``): no usage poll starts before that.

Before an account is marked REAUTH_REQUIRED the exchange is CONFIRMED with a second
attempt against the credential as it stands now: a false mark costs a person a sign-in
they did not need, which is worth one extra call.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from oracle.claude_accounts import store, usage
from oracle.claude_accounts.accounts import WindowReading, due_for_refresh
from oracle.claude_accounts.credentials import (
    DEFAULT_HELD_REFRESH_MARGIN,
    CredentialRefresher,
    RefreshOutcome,
)
from oracle.claude_accounts.models import ClaudeAccountHold, ClaudeAccountSignin, ClaudeSweepLease
from oracle.claude_accounts.oauth import PENDING_TTL, HttpTokenEndpoint, TokenEndpoint
from oracle.tenancy import tenant_session, unscoped_session

log = logging.getLogger(__name__)

#: How long a lease lives without a renewal: it only has to outlive one step (the
#: token endpoint's 30s timeout plus a database write), and bounds a dead holder.
LEASE_TTL = timedelta(seconds=120)

SWEEP_OK = "ok"
SWEEP_ERROR = "error"

#: No sweep of a company starts within this of its last one's completion, from any entry
#: point, whatever ORACLE_CLAUDE_SWEEP_SECONDS (0 only turns the background sweep off):
#: Anthropic's usage endpoint allows about 5 calls per 5 minutes per account.
MIN_SWEEP_INTERVAL = timedelta(seconds=300)

#: A 429's retry-after is kept for at most this long (a bogus header stops no poll for days).
MAX_USAGE_RETRY_AFTER = timedelta(hours=1)

#: Refresh outcomes that mean only a person can fix the credential.
CREDENTIAL_NEEDS_A_HUMAN = ("reauth_required", "unreadable")
#: Outcomes that wrote at least one credential column.
_WROTE_A_VERSION = ("refreshed", "published", "published_unverified")


class PoolSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORACLE_CLAUDE_", env_file=".env", extra="ignore")

    # How often a company is swept (never more often than MIN_SWEEP_INTERVAL), and how
    # often the background task looks; 0 turns that task off (ticks still sweep).
    sweep_seconds: int = 300
    # Usage polls per sweep (the endpoint allows ~5 per 5 minutes, shared).
    max_polls_per_sweep: int = usage.DEFAULT_MAX_POLLS_PER_SWEEP
    held_refresh_margin_seconds: int = int(DEFAULT_HELD_REFRESH_MARGIN.total_seconds())


@lru_cache
def get_pool_settings() -> PoolSettings:
    return PoolSettings()


# --- injectable network edges (tests replace them) ----------------------------------

_endpoint: TokenEndpoint | None = None
_fetch: usage.Fetch | None = None


def get_token_endpoint() -> TokenEndpoint:
    return _endpoint or HttpTokenEndpoint()


def set_token_endpoint(endpoint: TokenEndpoint | None) -> TokenEndpoint | None:
    global _endpoint
    previous, _endpoint = _endpoint, endpoint
    return previous


def get_usage_fetch() -> usage.Fetch:
    return _fetch or usage.fetch


def set_usage_fetch(fetch: usage.Fetch | None) -> usage.Fetch | None:
    global _fetch
    previous, _fetch = _fetch, fetch
    return previous


def refresher_for(tenant_id: uuid.UUID) -> CredentialRefresher:
    margin = timedelta(seconds=get_pool_settings().held_refresh_margin_seconds)
    return CredentialRefresher(
        store.DbSecretStore(tenant_id), get_token_endpoint(), held_margin=margin
    )


# --- the lease ------------------------------------------------------------------------


@dataclass(frozen=True)
class LeaseState:
    acquired: bool
    holder: str | None
    expires_at: datetime | None
    generation: int | None
    # Not taken because the last sweep completed within the floor (``acquire_lease``).
    not_due: bool = False
    last_completed_at: datetime | None = None


def new_holder() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:12]}"


async def _lease_row(session: Any, tenant_id: uuid.UUID) -> ClaudeSweepLease:
    await session.execute(
        insert(ClaudeSweepLease)
        .values(id=uuid.uuid4(), tenant_id=tenant_id, released=True, generation=0)
        .on_conflict_do_nothing(index_elements=["tenant_id"])
    )
    return await session.scalar(select(ClaudeSweepLease).with_for_update())


async def acquire_lease(
    tenant_id: uuid.UUID,
    holder: str,
    now: datetime,
    *,
    due_after: timedelta = MIN_SWEEP_INTERVAL,
) -> LeaseState:
    """Take the lease if nobody holds it, it was released, or its deadline passed, and
    the last sweep completed more than ``due_after`` (at least ``MIN_SWEEP_INTERVAL``)
    before ``now``. Both are read under the row lock, so of two callers that each found
    the company due, the second sees the first's completion and does not sweep."""
    floor = max(due_after, MIN_SWEEP_INTERVAL)
    async with tenant_session(tenant_id) as s:
        row = await _lease_row(s, tenant_id)
        expires = row.expires_at
        if row.holder and not row.released and expires is not None and expires > now:
            await s.commit()
            return LeaseState(False, row.holder, expires, row.generation)
        last = row.last_completed_at
        if last is not None and now - last <= floor:
            await s.commit()
            return LeaseState(
                False, row.holder, expires, row.generation, not_due=True, last_completed_at=last
            )
        row.holder = holder
        row.released = False
        row.expires_at = now + LEASE_TTL
        row.generation = (row.generation or 0) + 1
        await s.commit()
        return LeaseState(True, holder, row.expires_at, row.generation)


async def renew_lease(tenant_id: uuid.UUID, holder: str, now: datetime) -> bool:
    async with tenant_session(tenant_id) as s:
        row = await _lease_row(s, tenant_id)
        if row.holder != holder or row.released:
            await s.commit()
            return False
        row.expires_at = now + LEASE_TTL
        await s.commit()
        return True


async def release_lease(tenant_id: uuid.UUID, holder: str, outcome: str, now: datetime) -> bool:
    """Give it back if still ours, recording the sweep's completion."""
    async with tenant_session(tenant_id) as s:
        row = await _lease_row(s, tenant_id)
        if row.holder != holder:
            await s.commit()
            return False
        row.released = True
        row.last_completed_at = now
        row.last_outcome = outcome
        await s.commit()
        return True


async def liveness(session: Any) -> dict[str, Any]:
    """When the sweep last completed and how; both null when it never has."""
    try:
        row = await session.scalar(select(ClaudeSweepLease))
    except Exception:
        return {"last_completed_at": None, "last_outcome": None, "readable": False}
    return {
        "last_completed_at": row.last_completed_at if row else None,
        "last_outcome": row.last_outcome if row else None,
        "readable": True,
    }


async def is_due(tenant_id: uuid.UUID, interval: timedelta, now: datetime) -> bool:
    """Whether the company's sweep last completed more than ``interval`` ago (or never)."""
    async with tenant_session(tenant_id) as s:
        last = await s.scalar(select(ClaudeSweepLease.last_completed_at))
    return last is None or now - last > interval


def tick_sweep_interval() -> timedelta:
    """How long after a company's last sweep it is swept again: at least 5 minutes."""
    configured = timedelta(seconds=max(0, get_pool_settings().sweep_seconds))
    return max(configured, MIN_SWEEP_INTERVAL)


async def sweep_if_due(tenant_id: uuid.UUID) -> dict[str, Any] | None:
    """The company's sweep if due (``tick_sweep_interval``), else None.

    Every scheduled entry point goes through here: the ticks and the background task.
    This first read only spares a company that is not due its hold pruning; the sweep
    checks again under the lease, where it counts."""
    interval = tick_sweep_interval()
    if not await is_due(tenant_id, interval, datetime.now(UTC)):
        return None
    return await sweep(tenant_id, due_after=interval)


async def usage_retry_at(tenant_id: uuid.UUID) -> datetime | None:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(ClaudeSweepLease.usage_retry_at))


async def set_usage_retry_at(tenant_id: uuid.UUID, at: datetime) -> None:
    async with tenant_session(tenant_id) as s:
        row = await _lease_row(s, tenant_id)
        row.usage_retry_at = at
        await s.commit()


class LeaseFence:
    """Asked before every exchange: renews the lease, False once it is someone else's."""

    def __init__(self, tenant_id: uuid.UUID, holder: str) -> None:
        self.tenant_id = tenant_id
        self.holder = holder
        self.lost = False

    async def __call__(self) -> bool:
        if self.lost:
            return False
        try:
            ok = await renew_lease(self.tenant_id, self.holder, datetime.now(UTC))
        except Exception:
            ok = False
        if not ok:
            self.lost = True
        return ok


# --- the phases ----------------------------------------------------------------------


async def prune_all_holds(tenant_id: uuid.UUID, now: datetime) -> dict[str, Any]:
    """Expire abandoned holds across the pool, one transaction per account."""
    async with tenant_session(tenant_id) as s:
        listing = await store.list_reporting(s)
        # Hold records past their retention, as Firestore's TTL policy deletes them, and
        # sign-ins nobody finished within their 15 minutes.
        await s.execute(delete(ClaudeAccountHold).where(ClaudeAccountHold.expires_at < now))
        await s.execute(
            delete(ClaudeAccountSignin).where(ClaudeAccountSignin.created_at < now - PENDING_TTL)
        )
        await s.commit()
    reclaimed = touched = 0
    for account_id in [a.account_id for a in listing.accounts] + listing.unreadable:
        try:
            dropped = await store.prune_holds(tenant_id, account_id, now=now)
        except store.MALFORMED_ERRORS:
            continue
        if dropped:
            reclaimed += dropped
            touched += 1
            log.warning(
                "reclaimed holds whose job never released them",
                extra={"account_id": account_id, "reclaimed": dropped},
            )
    never_used = [a for a in listing.accounts if a.last_assigned_at is None]
    return {
        "pruned": touched,
        "reclaimed": reclaimed,
        "registered": len(listing.accounts),
        "never_assigned": len(never_used),
    }


async def _record_refreshes(
    tenant_id: uuid.UUID, outcomes: list[RefreshOutcome], now: datetime
) -> int:
    written = 0
    for outcome in outcomes:
        try:
            if await store.record_refresh(
                tenant_id,
                outcome.account_id,
                at=now,
                reason=outcome.reason,
                expires_at=outcome.expires_at,
            ):
                written += 1
        except Exception as exc:
            log.error(
                "could not record an account's refresh outcome",
                extra={"account_id": outcome.account_id, "error": type(exc).__name__},
            )
    return written


async def sweep_account_pool(
    tenant_id: uuid.UUID,
    refresher: CredentialRefresher,
    now: datetime,
    *,
    keep_going: Any = None,
) -> dict[str, Any]:
    """Refresh every account, RECORD what came back, and mark the dead ones."""
    try:
        async with tenant_session(tenant_id) as s:
            due = due_for_refresh(await store.list_accounts(s), now)
        # A LIVE hold only: an expired one is a job that died; nothing runs on it.
        held = {a.account_id for a in due if a.live_holds(now)}
        outcomes = await refresher.sweep_accounts(
            [store.secret_for(a) for a in due], keep_going=keep_going, held=held
        )
    except Exception as exc:
        log.error("account pool sweep failed", extra={"error": type(exc).__name__})
        return {"error": type(exc).__name__}

    recorded = await _record_refreshes(tenant_id, outcomes, now)
    needs_human = [
        (o.account_id, o.reason) for o in outcomes if o.reason in CREDENTIAL_NEEDS_A_HUMAN
    ]
    marked: list[str] = []
    for account_id, reason in needs_human:
        if keep_going is not None and not await keep_going():
            break
        try:
            async with tenant_session(tenant_id) as s:
                account = await store.get(s, account_id)
            if account is None:
                continue  # removed mid-sweep
            second = await refresher.refresh_secret(store.secret_for(account))
            if second.reason != reason:
                recorded += await _record_refreshes(
                    tenant_id, [replace(second, account_id=account_id)], now
                )
            if second.reason not in CREDENTIAL_NEEDS_A_HUMAN:
                log.info(
                    "an account's refresh failed and then worked on a second attempt",
                    extra={"account_id": account_id, "first": reason, "second": second.reason},
                )
                continue
            done = await store.mark_reauth_required(
                tenant_id, account_id, f"refresh failed: {second.reason}"
            )
        except Exception as exc:
            log.error(
                "could not record that an account's credential is dead",
                extra={"account_id": account_id, "error": type(exc).__name__},
            )
            continue
        if done is not None:
            marked.append(account_id)
    return {
        "examined": len(outcomes),
        "refreshed": sum(1 for o in outcomes if o.refreshed),
        "recorded": recorded,
        "reauth_required": [account_id for account_id, _ in needs_human],
        "marked_reauth_required": marked,
        "wrote": sum(1 for o in outcomes if o.reason in _WROTE_A_VERSION),
        "held_deferred": [o.account_id for o in outcomes if o.reason == "held_deferred"],
    }


async def poll_usage(
    tenant_id: uuid.UUID, *, keep_going: Any = None, max_polls: int | None = None
) -> dict[str, Any]:
    """One usage round, unless a 429's retry-after has not passed; a new 429's is kept."""
    try:
        retry_at = await usage_retry_at(tenant_id)
    except Exception as exc:
        log.error("account usage poll failed", extra={"error": type(exc).__name__})
        return {"error": type(exc).__name__}
    if retry_at is not None and retry_at > datetime.now(UTC):
        return {"examined": 0, "polled": 0, "skipped": [], "backoff_until": retry_at.isoformat()}
    secrets = store.DbSecretStore(tenant_id)
    fetch = get_usage_fetch()

    async def read_token(account: Any) -> str:
        return await secrets.access(store.secret_for(account))

    async def record(account: Any, windows: dict[str, WindowReading]) -> None:
        await store.record_reading(tenant_id, account.account_id, windows, datetime.now(UTC))

    try:
        async with tenant_session(tenant_id) as s:
            accounts = await store.list_accounts(s)
        outcomes = await usage.poll_round(
            accounts,
            read_token=read_token,
            record=record,
            fetch_windows=fetch,
            max_polls=get_pool_settings().max_polls_per_sweep if max_polls is None else max_polls,
            keep_going=keep_going,
        )
        limited = [o for o in outcomes if o.reason == "rate_limited"]
        if limited:
            # Clamped before the timedelta: a bogus huge header would overflow it.
            longest = MAX_USAGE_RETRY_AFTER.total_seconds()
            wait = min(max(0, limited[0].retry_after_seconds or 0), longest)
            await set_usage_retry_at(tenant_id, datetime.now(UTC) + timedelta(seconds=wait))
    except Exception as exc:
        log.error("account usage poll failed", extra={"error": type(exc).__name__})
        return {"error": type(exc).__name__}
    return {
        "examined": len(outcomes),
        "polled": sum(1 for o in outcomes if o.polled),
        "skipped": [
            {"account_id": o.account_id, "reason": o.reason} for o in outcomes if not o.polled
        ],
    }


async def sweep(
    tenant_id: uuid.UUID,
    *,
    now: datetime | None = None,
    due_after: timedelta = MIN_SWEEP_INTERVAL,
) -> dict[str, Any]:
    """One company's whole sweep. Never raises: ``oracle tick`` advances runs too.

    The hold backstop always runs; the credential phase only when the last sweep
    completed more than ``due_after`` ago (never under ``MIN_SWEEP_INTERVAL``), checked
    as the lease is taken: otherwise ``sweep_lease`` says ``not_due``."""
    now = now or datetime.now(UTC)
    result: dict[str, Any] = {}
    try:
        result["holds"] = await prune_all_holds(tenant_id, now)
    except Exception as exc:
        log.error("account hold sweep failed", extra={"error": type(exc).__name__})
        result["holds"] = {"error": type(exc).__name__}

    holder = new_holder()
    try:
        taken = await acquire_lease(tenant_id, holder, now, due_after=due_after)
    except Exception as exc:
        result["sweep_lease"] = {"acquired": False, "error": type(exc).__name__}
        return result
    if taken.not_due:
        last = taken.last_completed_at
        result["sweep_lease"] = {
            "acquired": False,
            "not_due": True,
            "last_completed_at": last.isoformat() if last else None,
        }
        return result
    if not taken.acquired:
        result["sweep_lease"] = {
            "acquired": False,
            "held_by": taken.holder,
            "expires_at": taken.expires_at.isoformat() if taken.expires_at else None,
        }
        return result

    fence = LeaseFence(tenant_id, holder)
    outcome = SWEEP_ERROR
    try:
        result["accounts"] = await sweep_account_pool(
            tenant_id, refresher_for(tenant_id), now, keep_going=fence
        )
        result["usage"] = await poll_usage(tenant_id, keep_going=fence)
        failed = any(
            isinstance(result.get(b), dict) and "error" in result[b] for b in ("accounts", "usage")
        )
        outcome = SWEEP_ERROR if failed else SWEEP_OK
    finally:
        released = await release_lease(tenant_id, holder, outcome, datetime.now(UTC))
    result["sweep_lease"] = {
        "acquired": True,
        "generation": taken.generation,
        "lost": fence.lost,
        "released": released,
    }
    return result


async def sweep_every_company() -> None:
    """Every company's sweep, where due (``sweep_if_due``)."""
    from oracle.models import Tenant

    async with unscoped_session() as s:
        tenant_ids = list((await s.scalars(select(Tenant.id))).all())
    for tenant_id in tenant_ids:
        try:
            await sweep_if_due(tenant_id)
        except Exception:
            log.exception("the Claude account sweep failed for a company")


async def run_scheduler(interval: float, *, sleep: Any = asyncio.sleep) -> None:
    """The local background scheduler: every ``interval``, sweep the companies due."""
    while True:
        await sleep(interval)
        try:
            await sweep_every_company()
        except Exception:
            log.exception("the Claude account sweep failed")


def summarise_sweep(result: dict[str, Any] | None) -> Any:
    """The sweep's result as ``oracle.runs.schemas.ClaudeSweepSummary`` for ``oracle tick``.

    None (``sweep_if_due``: not due) is lease ``not_due``, as is a sweep that found the
    last one too recent under the lease.
    """
    from oracle.runs.schemas import ClaudeSweepSummary

    if result is None:
        return ClaudeSweepSummary(lease="not_due")
    errors = [
        f"{block}: {result[block]['error']}"
        for block in ("holds", "accounts", "usage")
        if isinstance(result.get(block), dict) and "error" in result[block]
    ]
    lease = result.get("sweep_lease") or {}
    if lease.get("acquired"):
        state = "ran"
    elif lease.get("not_due"):
        state = "not_due"
    else:
        state = "error" if "error" in lease else "skipped"
    accounts = result.get("accounts") or {}
    return ClaudeSweepSummary(
        reclaimed=int((result.get("holds") or {}).get("reclaimed") or 0),
        examined=int(accounts.get("examined") or 0),
        refreshed=int(accounts.get("refreshed") or 0),
        reauth_required=list(accounts.get("marked_reauth_required") or []),
        polled=int((result.get("usage") or {}).get("polled") or 0),
        lease=state,
        errors=errors,
    )
