"""Runs queued built-in jobs: from ``oracle tick`` and the local background worker.

One job at a time per document: a job is claimed under the document's row lock, and
only when no other job of that document is running. Claiming commits (``running``,
``attempts + 1``) before the model call, so a long call holds no lock.

Outcomes:
- the answer is written with the call's account, tokens and cost: ``succeeded``;
- a transient failure (Claude unreachable or out of quota on every account it tried,
  or an answer that is not the JSON asked for) goes back to ``queued`` once, then
  ``failed``;
- no Claude account can take the call: ``failed`` at once, with the pool's reason and
  next reset (``error_reason``, ``next_reset_at``); a person retries after fixing it;
- a job cancelled while its call ran keeps ``cancelled``; its answer is dropped.

A job left ``running`` past ``stale_after_seconds`` (the worker stopped mid-call) is
reclaimed the same way as a transient failure.

A caller with a time limit (the run ticker) passes ``budget_seconds``: no job is
claimed unless a whole model call (``ORACLE_LLM_TIMEOUT_SECONDS``) still fits, and the
job's calls get that deadline (``gateway.complete``), so no account swap or further call
starts that could not finish inside it. A job cut by that time limit -- out of time at
the gateway (``LlmOutOfTime``) or cancelled (``CancelledError``) -- leaves no claim to go
stale:
- before any model call started, it goes back to ``queued`` with its attempt given back
  and nothing recorded as spent (``deferred``);
- once one had, the cut is a transient failure that counts the attempt (``queued`` once
  more, then ``failed``), recording what is known (the account, and any call that
  finished), so a job whose calls keep overrunning cannot run forever.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import lru_cache
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.models import Document
from oracle.jobs import kinds, prompting
from oracle.jobs.models import LlmJob
from oracle.jobs.schemas import LlmJobsTick
from oracle.llm import gateway
from oracle.llm.transports import (
    LlmAuthError,
    LlmOutOfTime,
    LlmUnavailable,
    NoClaudeAccount,
    get_llm_settings,
)
from oracle.tenancy import tenant_session, unscoped_session

log = logging.getLogger(__name__)

#: A job runs at most this many times on transient failures (the first try + one retry).
MAX_ATTEMPTS = 2
#: Beyond the model call, what a job may take (claiming it, reading its inputs, writing
#: its outcome) when deciding whether it fits in a budget.
JOB_OVERHEAD_SECONDS = 5.0
#: The error of a job cut off while a model call ran.
CUT_OFF = "The model call was cut off by the caller's time limit"


class JobWorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ORACLE_LLM_JOBS_", env_file=".env", extra="ignore"
    )

    # The local background worker's interval; 0 turns it off (oracle tick still runs jobs).
    worker_seconds: float = 5.0
    # Jobs one tick (or one worker round) runs per company at most.
    max_per_tick: int = 10
    stale_after_seconds: float = 1800.0


@lru_cache
def get_worker_settings() -> JobWorkerSettings:
    return JobWorkerSettings()


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class Outcome:
    status: str  # succeeded | failed | retried | cancelled | deferred (put back unspent)
    error: str | None = None


@dataclass
class _Call:
    """The accounting of the job's model call(s)."""

    prompt: str | None = None
    account_label: str | None = None
    via: str | None = None
    model: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cost: Decimal | None = None
    calls: int = 0
    # Calls started (each on account_label / via), finished or not.
    started: int = 0
    swaps: list[tuple[str, str]] = field(default_factory=list)

    def call_started(self, account_label: str | None, via: str) -> None:
        self.started += 1
        self.account_label = account_label
        self.via = via


def _tokens(usage: dict[str, Any]) -> tuple[int, int]:
    def num(key: str) -> int:
        value = usage.get(key)
        return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0

    inp = num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens")
    return inp, num("output_tokens")


def _cost(usage: dict[str, Any]) -> Decimal | None:
    for key in ("total_cost_usd", "cost_usd"):
        value = usage.get(key)
        if isinstance(value, int | float) and not isinstance(value, bool):
            return Decimal(str(round(float(value), 4)))
    return None


async def reclaim_stale(s: AsyncSession) -> int:
    cutoff = _now() - timedelta(seconds=get_worker_settings().stale_after_seconds)
    stale = list(
        await s.scalars(
            select(LlmJob)
            .where(LlmJob.status == "running", LlmJob.started_at < cutoff)
            .with_for_update(skip_locked=True)
        )
    )
    for job in stale:
        message = "The worker stopped while the job ran"
        if job.attempts < MAX_ATTEMPTS:
            job.status, job.error = "queued", f"{message}; retrying"
        else:
            job.status, job.error, job.finished_at = "failed", message, _now()
    await s.commit()
    return len(stale)


async def claim_next(tenant_id: uuid.UUID) -> uuid.UUID | None:
    """Mark the oldest runnable queued job ``running`` and return its id."""
    async with tenant_session(tenant_id) as s:
        await reclaim_stale(s)
        candidates = (
            await s.execute(
                select(LlmJob.id, LlmJob.document_id)
                .where(LlmJob.status == "queued")
                .order_by(LlmJob.created_at, LlmJob.id)
                .limit(50)
            )
        ).all()
        busy: set[uuid.UUID] = set()
        for job_id, document_id in candidates:
            if document_id in busy:
                continue
            # The document's row lock serialises claims of its jobs across workers.
            locked = await s.scalar(
                select(Document.id)
                .where(Document.id == document_id)
                .with_for_update(skip_locked=True)
            )
            if locked is None:
                busy.add(document_id)
                await s.rollback()
                continue
            running = await s.scalar(
                select(
                    exists().where(LlmJob.document_id == document_id, LlmJob.status == "running")
                )
            )
            job = None
            if not running:
                job = await s.scalar(
                    select(LlmJob)
                    .where(LlmJob.id == job_id, LlmJob.status == "queued")
                    .with_for_update(skip_locked=True)
                )
            if job is None:
                busy.add(document_id)
                await s.rollback()
                continue
            job.status = "running"
            job.started_at = _now()
            job.finished_at = None
            job.attempts += 1
            try:
                await s.commit()
            except asyncio.CancelledError:
                await _shielded_release(tenant_id, job_id)
                raise
            return job.id
    return None


async def release_claim(tenant_id: uuid.UUID, job_id: uuid.UUID) -> bool:
    """Put a claimed job whose run was cancelled back to ``queued``, as if never claimed.

    Its attempt is given back and nothing is recorded as spent; a job that already
    reached an outcome (or was cancelled by a person) is left as it is.
    """
    async with tenant_session(tenant_id) as s:
        job = await s.scalar(
            select(LlmJob).where(LlmJob.id == job_id, LlmJob.status == "running").with_for_update()
        )
        if job is None:
            await s.rollback()
            return False
        job.status = "queued"
        job.attempts = max(0, job.attempts - 1)
        await s.commit()
        return True


async def record_cut(tenant_id: uuid.UUID, job_id: uuid.UUID, call: _Call) -> None:
    """A claimed job cut off after a model call started: a transient failure, counted."""
    async with tenant_session(tenant_id) as s:
        await _finish(s, job_id, call, "transient", CUT_OFF)


async def _shielded(work: Any, job_id: uuid.UUID) -> None:
    # Shielded: the work finishes even if the caller is cancelled again meanwhile.
    try:
        await asyncio.shield(asyncio.ensure_future(work))
    except Exception:
        log.exception("could not record that built-in job %s was cancelled", job_id)


async def _shielded_release(tenant_id: uuid.UUID, job_id: uuid.UUID) -> None:
    await _shielded(release_claim(tenant_id, job_id), job_id)


def _call_deadline(deadline: float | None) -> float | None:
    # Half the overhead is kept for after the call (writing the outcome).
    return None if deadline is None else deadline - JOB_OVERHEAD_SECONDS / 2


async def run_job(
    tenant_id: uuid.UUID,
    job_id: uuid.UUID,
    transports: gateway.Transports | None = None,
    *,
    deadline: float | None = None,
) -> Outcome:
    """Run one claimed (``running``) job to its outcome.

    With ``deadline`` (``time.monotonic()``), its calls start only while a whole one fits.
    Cancelled, it is put back (no call had started) or the cut counted as an attempt.
    """
    call = _Call()
    try:
        return await _run_job(tenant_id, job_id, call, transports, _call_deadline(deadline))
    except asyncio.CancelledError:
        if call.started:
            await _shielded(record_cut(tenant_id, job_id, call), job_id)
        else:
            await _shielded_release(tenant_id, job_id)
        raise


async def _run_job(
    tenant_id: uuid.UUID,
    job_id: uuid.UUID,
    call: _Call,
    transports: gateway.Transports | None,
    deadline: float | None,
) -> Outcome:
    async with tenant_session(tenant_id) as s:
        job = await s.get(LlmJob, job_id)
        if job is None or job.status != "running":
            return Outcome("cancelled")

        async def ask(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
            name, system = prompting.current(kind)
            call.prompt = name
            completion = await gateway.complete(
                s,
                system,
                [{"role": "user", "content": kinds.payload_text(payload)}],
                kinds.MAX_TOKENS[kind],
                job=kind,
                transports=transports,
                deadline=deadline,
                on_call=call.call_started,
            )
            call.calls += 1
            call.account_label = completion.account_label
            call.via = completion.via
            call.model = completion.model
            i, o = _tokens(completion.usage)
            call.input_tokens += i
            call.output_tokens += o
            cost = _cost(completion.usage)
            if cost is not None:
                call.cost = (call.cost or Decimal(0)) + cost
            call.swaps += completion.swaps
            return prompting.parse_answer(completion.text)

        try:
            output = await kinds.RUNNERS[job.kind](s, job, ask)
        except LlmOutOfTime as e:
            await s.rollback()
            if not call.started:
                # Out of time before any model call: as if never claimed.
                released = await release_claim(tenant_id, job_id)
                return Outcome("deferred" if released else "cancelled")
            return await _finish(s, job_id, call, "transient", str(e))
        except NoClaudeAccount as e:
            await s.rollback()
            return await _finish(
                s, job_id, call, "failed", str(e), reason=e.reason, next_reset=e.next_reset_at
            )
        except (LlmUnavailable, prompting.AnswerError) as e:
            await s.rollback()
            return await _finish(s, job_id, call, "transient", str(e))
        except LlmAuthError as e:
            await s.rollback()
            return await _finish(s, job_id, call, "failed", f"Claude rejected the credential: {e}")
        except kinds.JobInputError as e:
            await s.rollback()
            return await _finish(s, job_id, call, "failed", str(e))
        except Exception as e:  # one broken job must not stop the queue
            log.exception("built-in job %s failed", job_id)
            await s.rollback()
            return await _finish(s, job_id, call, "failed", f"Internal error ({type(e).__name__})")
        return await _finish(s, job_id, call, "succeeded", None, output=output)


async def _finish(
    s: AsyncSession,
    job_id: uuid.UUID,
    call: _Call,
    outcome: str,
    error: str | None,
    *,
    output: dict[str, Any] | None = None,
    reason: str | None = None,
    next_reset: str | None = None,
) -> Outcome:
    # Re-read under the row lock: a cancel that landed during the call wins.
    job = await s.scalar(
        select(LlmJob)
        .where(LlmJob.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if job is None or job.status != "running":
        await s.rollback()
        return Outcome("cancelled")
    if call.prompt:
        job.input = {**job.input, "prompt": call.prompt}
    if call.started or call.calls:
        job.account_label = call.account_label
        job.via = call.via
    if call.calls:
        job.model = call.model
        job.input_tokens = call.input_tokens
        job.output_tokens = call.output_tokens
        job.cost_usd = call.cost
    job.error_reason = reason
    job.next_reset_at = datetime.fromisoformat(next_reset) if next_reset else None
    if outcome == "transient" and job.attempts < MAX_ATTEMPTS:
        job.status = "queued"
        job.error = f"{error} (retrying once)"
        result = Outcome("retried", error)
    elif outcome == "succeeded":
        job.status = "succeeded"
        job.output = {**(output or {}), **({"swaps": call.swaps} if call.swaps else {})}
        job.error = None
        job.finished_at = _now()
        result = Outcome("succeeded")
    else:
        job.status = "failed"
        job.error = error
        job.finished_at = _now()
        result = Outcome("failed", error)
    await s.commit()
    return result


def job_seconds() -> float:
    """What a job needs to be claimed: one model call's timeout and the rest.

    Its calls never start a second one past the deadline (``gateway.complete``)."""
    return get_llm_settings().timeout_seconds + JOB_OVERHEAD_SECONDS


async def run_pending(
    tenant_id: uuid.UUID,
    *,
    limit: int | None = None,
    transports: gateway.Transports | None = None,
    budget_seconds: float | None = None,
) -> LlmJobsTick:
    """Run queued jobs of one company until none is runnable or ``limit`` ran.

    With ``budget_seconds``, no job is claimed once one could not finish inside it, and
    a job's calls are given the deadline.
    """
    limit = limit if limit is not None else get_worker_settings().max_per_tick
    deadline = None if budget_seconds is None else time.monotonic() + budget_seconds
    out = LlmJobsTick(ran=0, succeeded=0, failed=0, retried=0, errors=[])
    while out.ran < limit:
        if deadline is not None and deadline - time.monotonic() < job_seconds():
            break
        job_id = await claim_next(tenant_id)
        if job_id is None:
            break
        # Cancelled, run_job itself puts the job back or counts the cut.
        outcome = await run_job(tenant_id, job_id, transports, deadline=deadline)
        if outcome.status == "deferred":
            break  # put back unspent: no call fits in the time left
        out.ran += 1
        if outcome.status == "succeeded":
            out.succeeded += 1
        elif outcome.status == "retried":
            out.retried += 1
        elif outcome.status == "failed":
            out.failed += 1
            out.errors.append(f"job {job_id}: {outcome.error}")
    return out


async def run_every_company() -> None:
    from oracle.models import Tenant

    async with unscoped_session() as s:
        tenant_ids = list((await s.scalars(select(Tenant.id))).all())
    for tenant_id in tenant_ids:
        try:
            await run_pending(tenant_id)
        except Exception:
            log.exception("built-in jobs failed for a company")


async def run_worker(interval: float) -> None:
    """The local background worker: run queued jobs of every company each interval."""
    while True:
        await asyncio.sleep(interval)
        try:
            await run_every_company()
        except Exception:
            log.exception("the built-in job worker failed")
