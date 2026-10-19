"""The run ticker: ``POST /internal/scheduler/tick``, called by Cloud Scheduler every minute.

SwarmCloud never calls Oracle back, so runs only advance when something ticks
(decision W3). One tick does, for every company in its own tenant session, what
``POST /v1/internal/tick`` does for one: advance its runs, sweep its Claude account
pool and run its queued built-in model jobs. One company's failure stops none of the
others, and the answer carries counts only (no ids, no error text).

Auth is a Google ID token from ORACLE_TICKER_SERVICE_ACCOUNT for ORACLE_TICKER_AUDIENCE
(``oracle.ticker.idtoken``), nothing else; with either setting empty the endpoint is a
404. Outside /v1 and out of the OpenAPI document, so it is no MCP tool.

Ticks never overlap: a Postgres advisory lock is held for the whole tick, and a tick
that finds it taken answers ``{"skipped": "running"}``. No company is started after
``BUDGET_SECONDS``, and the whole tick is cut off at ``HARD_LIMIT_SECONDS``. Companies
go in a random order, so a slow one cannot starve those after it.
"""

import asyncio
import logging
import random
import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select, text

from oracle.auth.jwks import KeysUnavailable
from oracle.claude_accounts import sweep as claude_sweep
from oracle.config import get_settings
from oracle.db import get_engine
from oracle.jobs import worker as llm_jobs
from oracle.models import Tenant
from oracle.runs import service as runs_service
from oracle.tenancy import tenant_session, unscoped_session
from oracle.ticker import idtoken

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
        log.info("run ticker refused a token: %s", e)
        raise _REFUSED from None
    except KeysUnavailable:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Cannot verify the token right now"
        ) from None


async def _tick_company(tenant_id: uuid.UUID, out: TickerOut) -> None:
    """One company's runs, account sweep and built-in jobs, each kind on its own."""
    failed = False
    try:
        async with tenant_session(tenant_id) as db:
            runs = await runs_service.tick(db)
        out.runs.checked += runs.runs_checked
        out.runs.segments_finished += runs.segments_finished
        out.runs.advanced += runs.runs_advanced
        out.runs.paused += runs.runs_paused
        out.runs.errors += len(runs.errors)
    except Exception:
        log.exception("run ticker: runs failed for company %s", tenant_id)
        failed = True
    try:
        swept = claude_sweep.summarise_sweep(await claude_sweep.sweep(tenant_id))
        acc = out.claude_accounts
        acc.reclaimed += swept.reclaimed
        acc.examined += swept.examined
        acc.refreshed += swept.refreshed
        acc.reauth_required += len(swept.reauth_required)
        acc.polled += swept.polled
        acc.lease_skipped += swept.lease == "skipped"
        acc.errors += len(swept.errors)
    except Exception:
        log.exception("run ticker: the Claude account sweep failed for company %s", tenant_id)
        failed = True
    try:
        jobs = await llm_jobs.run_pending(tenant_id)
        out.llm_jobs.ran += jobs.ran
        out.llm_jobs.succeeded += jobs.succeeded
        out.llm_jobs.failed += jobs.failed
        out.llm_jobs.retried += jobs.retried
    except Exception:
        log.exception("run ticker: built-in jobs failed for company %s", tenant_id)
        failed = True
    out.companies.failed += failed


async def _tick_every_company(out: TickerOut, started: float) -> None:
    async with unscoped_session() as s:
        tenant_ids = list(await s.scalars(select(Tenant.id)))
    random.shuffle(tenant_ids)
    out.companies.deferred = len(tenant_ids)
    for tenant_id in tenant_ids:
        if time.monotonic() - started >= BUDGET_SECONDS:
            break
        out.companies.deferred -= 1
        out.companies.ticked += 1
        await _tick_company(tenant_id, out)


@router.post("/internal/scheduler/tick", include_in_schema=False)
async def scheduler_tick(request: Request) -> dict[str, Any]:
    await _authenticate(request)
    started = time.monotonic()
    async with get_engine().connect() as conn:
        lock = text("SELECT pg_try_advisory_lock(:k)")
        if not await conn.scalar(lock, {"k": ADVISORY_LOCK_KEY}):
            await conn.rollback()
            return {"skipped": "running"}
        # A session-level lock: it outlives this transaction, so none stays open.
        await conn.commit()
        try:
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
