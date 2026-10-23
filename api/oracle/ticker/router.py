"""The run ticker: ``POST /internal/scheduler/tick``, called by Cloud Scheduler every minute.

SwarmCloud never calls Oracle back, so runs only advance when something ticks
(decision W3). One tick does, for every company in its own tenant session, what
``POST /v1/internal/tick`` does for one (the same body, ``oracle.ticker.body``): advance
its runs, sweep its Claude account pool, run its queued built-in model jobs and, last,
make the calls a member's disable or a run's cancel still owes (follow-ups). One
company's failure stops none of the others, and the answer carries counts only (no ids,
no error text).

The account sweep runs only when the company's last one completed more than
``ORACLE_CLAUDE_SWEEP_SECONDS`` ago, and never within five minutes of it, even with that
setting lower or 0, whoever else swept (``claude_sweep.MIN_SWEEP_INTERVAL``, checked again
as the sweep lease is taken): Anthropic's usage endpoint allows about five calls per five
minutes per account, which a sweep every minute would spend. While this ticker is
configured the API starts no background sweep of its own (``oracle.main``).

Auth is a Google ID token from ORACLE_TICKER_SERVICE_ACCOUNT for ORACLE_TICKER_AUDIENCE
(``oracle.ticker.idtoken``), nothing else; with either setting empty the endpoint is a
404. Outside /v1 and out of the OpenAPI document, so it is no MCP tool.

Ticks never overlap: a Postgres advisory lock is held for the whole tick, and a tick
that finds it taken answers ``{"skipped": "running"}``. The lock is session-level, so the
database connection must be a session-mode one (not a transaction-mode pooler).

First every company's runs and sweep, in a random order, none started after
``BUDGET_SECONDS``; then the built-in jobs of the companies ticked, one job per company
in turn, so a company's backlog neither delays another's runs nor takes all the job
time (none with ``ORACLE_LLM_JOBS_MAX_PER_TICK=0``). A job is claimed only when a whole
model call still fits before ``HARD_LIMIT_SECONDS``, where the whole tick is cut off, and
its calls are given that deadline: no account swap or further call starts that could not
finish before it. A job cut off anyway is put back with its attempt refunded if no model
call had started, and otherwise counts the attempt (``oracle.jobs.worker``).
"""

import asyncio
import logging
import random
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select, text

from oracle.auth.jwks import KeysUnavailable
from oracle.claude_accounts import sweep as claude_sweep
from oracle.config import get_settings
from oracle.connections import service as connections_service
from oracle.db import get_engine
from oracle.discussions import replies as discussion_replies
from oracle.discussions.replies import RepliesTick
from oracle.jobs import worker as llm_jobs
from oracle.launches import service as launches_service
from oracle.models import Tenant
from oracle.reports import alignment as alignment_reports
from oracle.requests import triage as request_triage
from oracle.roadmap import views as track_views
from oracle.strategy import drift as strategy_drift
from oracle.tenancy import tenant_session, unscoped_session
from oracle.ticker import body, idtoken

log = logging.getLogger(__name__)

router = APIRouter(tags=["internal"])

# pg_advisory_lock key of the run ticker ("oracletk" as a big-endian int64).
ADVISORY_LOCK_KEY = int.from_bytes(b"oracletk", "big")
# No company is started after this many seconds (the next minute's tick goes on).
BUDGET_SECONDS = 45.0
# The whole tick is cancelled after this (below Cloud Run's 300 s request timeout).
HARD_LIMIT_SECONDS = 240.0


class _Runs(BaseModel):
    checked: int = 0
    segments_finished: int = 0
    advanced: int = 0
    paused: int = 0
    errors: int = 0


class _ClaudeAccounts(BaseModel):
    reclaimed: int = 0
    examined: int = 0
    refreshed: int = 0
    reauth_required: int = 0
    polled: int = 0
    # Companies whose sweep lease another sweep held.
    lease_skipped: int = 0
    # Companies not swept: their last sweep completed within the sweep interval
    # (ORACLE_CLAUDE_SWEEP_SECONDS, at least 300 s).
    not_due: int = 0
    errors: int = 0


class _LlmJobs(BaseModel):
    ran: int = 0
    succeeded: int = 0
    failed: int = 0
    retried: int = 0


class _Companies(BaseModel):
    ticked: int = 0
    # Ticked, but at least one kind of work raised.
    failed: int = 0
    # Not started: the budget was spent (or the tick was cut off) first.
    deferred: int = 0


class TickerOut(BaseModel):
    companies: _Companies = Field(default_factory=_Companies)
    runs: _Runs = Field(default_factory=_Runs)
    claude_accounts: _ClaudeAccounts = Field(default_factory=_ClaudeAccounts)
    llm_jobs: _LlmJobs = Field(default_factory=_LlmJobs)
    # G2: Oracle's replies nobody streamed, completed here; leases that ran out.
    discussion_replies: RepliesTick = Field(default_factory=RepliesTick)
    # Calls a member's disable or a run's cancel still owed (a provider revoke, a runtime
    # cancel), made.
    member_follow_ups: int = 0
    timed_out: bool = False


_REFUSED = HTTPException(
    status.HTTP_401_UNAUTHORIZED, "Not authenticated", headers={"WWW-Authenticate": "Bearer"}
)


async def _authenticate(request: Request) -> None:
    """Pass a valid ticker ID token; 404 when off, 401 for anything else, 503 without certs."""
    settings = get_settings()
    audience, account = settings.ticker_audience, settings.ticker_service_account
    if not audience.strip() or not account.strip():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise _REFUSED
    try:
        await idtoken.verify_id_token(token.strip(), audience=audience.strip(), email=account)
    except idtoken.InvalidIdToken as e:
        log.debug("run ticker refused a token: %s", e)
        raise _REFUSED from None
    except KeysUnavailable:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Cannot verify the token right now"
        ) from None


class _Failures:
    """Companies with at least one kind of work that raised, each counted once."""

    def __init__(self, out: TickerOut) -> None:
        self.out = out
        self.seen: set[uuid.UUID] = set()

    def add(self, tenant_id: uuid.UUID) -> None:
        if tenant_id not in self.seen:
            self.seen.add(tenant_id)
            self.out.companies.failed += 1


def _count_sweep(result: dict[str, Any] | None, out: TickerOut) -> None:
    acc = out.claude_accounts
    swept = claude_sweep.summarise_sweep(result)
    acc.not_due += swept.lease == "not_due"
    acc.reclaimed += swept.reclaimed
    acc.examined += swept.examined
    acc.refreshed += swept.refreshed
    acc.reauth_required += len(swept.reauth_required)
    acc.polled += swept.polled
    acc.lease_skipped += swept.lease == "skipped"
    acc.errors += len(swept.errors)


async def _tick_company(tenant_id: uuid.UUID, out: TickerOut, failures: _Failures) -> None:
    """One company's runs and account sweep (``oracle.ticker.body``), its product
    tracks' monitoring, then its weekly alignment report (oracle.reports), its launches'
    Ready detection and its daily request triage, each on its own."""
    async with tenant_session(tenant_id) as db:
        company = await body.tick_company(db, tenant_id)
    if company.runs is not None:
        runs = company.runs
        out.runs.checked += runs.runs_checked
        out.runs.segments_finished += runs.segments_finished
        out.runs.advanced += runs.runs_advanced
        out.runs.paused += runs.runs_paused
        out.runs.errors += len(runs.errors)
    if company.swept:
        _count_sweep(company.sweep, out)
    if company.errors:
        failures.add(tenant_id)
    try:
        # Product tracks (CR-11): an hourly deterministic check, no model call.
        failed: list[uuid.UUID] = []
        async with tenant_session(tenant_id) as db:
            await track_views.monitor_due(db, failed=failed)
            await db.commit()
        if failed:
            failures.add(tenant_id)
    except Exception:
        log.exception("run ticker: track monitoring failed for company %s", tenant_id)
        failures.add(tenant_id)
    try:
        # F6: the weekly alignment report once its moment has passed, and the Slack posts
        # that are due; deterministic, no model call.
        async with tenant_session(tenant_id) as db:
            await alignment_reports.due(db)
            await db.commit()
    except Exception:
        log.exception("run ticker: the alignment report failed for company %s", tenant_id)
        failures.add(tenant_id)
    try:
        # Strategy drift (H4): a daily deterministic check, no model call.
        async with tenant_session(tenant_id) as db:
            if await strategy_drift.check_due(db):
                await db.commit()
    except Exception:
        log.exception("run ticker: strategy drift check failed for company %s", tenant_id)
        failures.add(tenant_id)
    try:
        # Launches (H6): a planned launch whose items all shipped becomes Ready, and its
        # launch kit run starts (deterministic; the run itself is SwarmCloud's).
        async with tenant_session(tenant_id) as db:
            await launches_service.detect_ready(db, tenant_id)
    except Exception:
        log.exception("run ticker: launch Ready detection failed for company %s", tenant_id)
        failures.add(tenant_id)
    try:
        # Requests (C1 "Triage runs"): once a day at 07:00 Pacific, a quick classify-only
        # triage run while a New request has no suggestion (the run itself is SwarmCloud's).
        async with tenant_session(tenant_id) as db:
            await request_triage.daily(db)
    except Exception:
        log.exception("run ticker: the daily request triage failed for company %s", tenant_id)
        failures.add(tenant_id)


# Follow-ups start only with at least this much of the tick's hard limit left.
SETTLE_MIN_SECONDS = 1.0


async def _settle_company(
    tenant_id: uuid.UUID,
    http: httpx.AsyncClient,
    out: TickerOut,
    failures: _Failures,
    started: float,
) -> None:
    """Last, as ``POST /v1/internal/tick`` does: the calls a member's disable or a run's
    cancel still owes (``oracle.ticker.body.settle_company``), in the time the tick has
    left; what does not fit waits for the next tick."""
    budget = HARD_LIMIT_SECONDS - SETTLE_MIN_SECONDS - (time.monotonic() - started)
    if budget <= 0:
        return
    async with tenant_session(tenant_id) as db:
        company = await body.settle_company(
            db, tenant_id, http, body.CompanyTick(), budget_seconds=budget
        )
    out.member_follow_ups += company.follow_ups
    if company.errors:
        failures.add(tenant_id)


async def _run_jobs(
    tenant_ids: list[uuid.UUID], out: TickerOut, failures: _Failures, started: float
) -> None:
    """The companies' queued built-in jobs, one per company in turn, inside the tick.

    A company leaves the turn when it has nothing runnable, has run its
    ``max_per_tick`` or failed; the turn ends once no job fits in the time left.
    """
    for tenant_id in tenant_ids:
        # G2: replies nobody streams, next to the built-in jobs and inside the same budget.
        budget = HARD_LIMIT_SECONDS - (time.monotonic() - started)
        try:
            got = await discussion_replies.run_pending(tenant_id, budget_seconds=budget)
        except Exception:
            log.exception("run ticker: discussion replies failed for company %s", tenant_id)
            failures.add(tenant_id)
            continue
        for name in ("ran", "completed", "failed", "interrupted"):
            setattr(
                out.discussion_replies,
                name,
                getattr(out.discussion_replies, name) + getattr(got, name),
            )
    limit = llm_jobs.get_worker_settings().max_per_tick
    if limit <= 0:
        return
    ran = dict.fromkeys(tenant_ids, 0)
    waiting = list(tenant_ids)
    while waiting:
        for tenant_id in list(waiting):
            budget = HARD_LIMIT_SECONDS - (time.monotonic() - started)
            if budget < llm_jobs.job_seconds():
                return
            try:
                jobs = await llm_jobs.run_pending(tenant_id, limit=1, budget_seconds=budget)
            except Exception:
                log.exception("run ticker: built-in jobs failed for company %s", tenant_id)
                failures.add(tenant_id)
                waiting.remove(tenant_id)
                continue
            out.llm_jobs.ran += jobs.ran
            out.llm_jobs.succeeded += jobs.succeeded
            out.llm_jobs.failed += jobs.failed
            out.llm_jobs.retried += jobs.retried
            ran[tenant_id] += jobs.ran
            if jobs.ran == 0 or ran[tenant_id] >= limit:
                waiting.remove(tenant_id)


async def _tick_every_company(out: TickerOut, started: float) -> None:
    async with unscoped_session() as s:
        tenant_ids = list(await s.scalars(select(Tenant.id)))
    random.shuffle(tenant_ids)
    failures = _Failures(out)
    out.companies.deferred = len(tenant_ids)
    ticked: list[uuid.UUID] = []
    for tenant_id in tenant_ids:
        if time.monotonic() - started >= BUDGET_SECONDS:
            break
        out.companies.deferred -= 1
        out.companies.ticked += 1
        ticked.append(tenant_id)
        await _tick_company(tenant_id, out, failures)
    await _run_jobs(ticked, out, failures, started)
    # Last, inside the tick's hard limit, each within its own budget.
    async with connections_service.http_client() as http:
        for tenant_id in ticked:
            await _settle_company(tenant_id, http, out, failures, started)


@router.post("/internal/scheduler/tick", include_in_schema=False)
async def scheduler_tick(request: Request) -> dict[str, Any]:
    await _authenticate(request)
    started = time.monotonic()
    async with get_engine().connect() as conn:
        lock = text("SELECT pg_try_advisory_lock(:k)")
        if not await conn.scalar(lock, {"k": ADVISORY_LOCK_KEY}):
            await conn.rollback()
            return {"skipped": "running"}
        try:
            # A session-level lock: it outlives this transaction, so none stays open.
            await conn.commit()
            out = TickerOut()
            try:
                async with asyncio.timeout(HARD_LIMIT_SECONDS):
                    await _tick_every_company(out, started)
            except TimeoutError:
                log.warning("run ticker: cut off after %ss", HARD_LIMIT_SECONDS)
                out.timed_out = True
        finally:
            try:
                await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": ADVISORY_LOCK_KEY})
                await conn.commit()
            except BaseException:
                # Never return a connection that may still hold the lock to the pool.
                await conn.invalidate()
                raise
    return out.model_dump()
