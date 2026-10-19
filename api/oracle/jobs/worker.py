"""Runs queued built-in jobs: from ``oracle tick`` and the local background worker.

One job at a time per document (or per product intake, for intake jobs): a job is
claimed under the document's (intake's) row lock, and only when no other job of it is
running. Claiming commits (``running``,
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
"""

import asyncio
import logging
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
from oracle.llm.transports import LlmAuthError, LlmUnavailable, NoClaudeAccount
from oracle.tenancy import tenant_session, unscoped_session
from oracle.v2.models import ProductIntake

log = logging.getLogger(__name__)

#: A job runs at most this many times on transient failures (the first try + one retry).
MAX_ATTEMPTS = 2


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
    status: str  # succeeded | failed | retried | cancelled
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
    swaps: list[tuple[str, str]] = field(default_factory=list)


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
                select(LlmJob.id, LlmJob.document_id, LlmJob.intake_id)
                .where(LlmJob.status == "queued")
                .order_by(LlmJob.created_at, LlmJob.id)
                .limit(50)
            )
        ).all()
        busy: set[uuid.UUID] = set()
        for job_id, document_id, intake_id in candidates:
            # A document's jobs run one at a time; so do an intake's (it has no document).
            owner, model, column = (
                (document_id, Document, LlmJob.document_id)
                if document_id is not None
                else (intake_id, ProductIntake, LlmJob.intake_id)
            )
            if owner in busy:
                continue
            # The owner's row lock serialises claims of its jobs across workers.
            locked = await s.scalar(
                select(model.id).where(model.id == owner).with_for_update(skip_locked=True)
            )
            if locked is None:
                busy.add(owner)
                await s.rollback()
                continue
            running = await s.scalar(
                select(exists().where(column == owner, LlmJob.status == "running"))
            )
            job = None
            if not running:
                job = await s.scalar(
                    select(LlmJob)
                    .where(LlmJob.id == job_id, LlmJob.status == "queued")
                    .with_for_update(skip_locked=True)
                )
            if job is None:
                busy.add(owner)
                await s.rollback()
                continue
            job.status = "running"
            job.started_at = _now()
            job.finished_at = None
            job.attempts += 1
            await s.commit()
            return job.id
    return None


async def run_job(
    tenant_id: uuid.UUID, job_id: uuid.UUID, transports: gateway.Transports | None = None
) -> Outcome:
    """Run one claimed (``running``) job to its outcome."""
    async with tenant_session(tenant_id) as s:
        job = await s.get(LlmJob, job_id)
        if job is None or job.status != "running":
            return Outcome("cancelled")
        call = _Call()

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
    if call.calls:
        job.account_label = call.account_label
        job.via = call.via
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


async def run_pending(
    tenant_id: uuid.UUID,
    *,
    limit: int | None = None,
    transports: gateway.Transports | None = None,
) -> LlmJobsTick:
    """Run queued jobs of one company until none is runnable or ``limit`` ran."""
    limit = limit if limit is not None else get_worker_settings().max_per_tick
    out = LlmJobsTick(ran=0, succeeded=0, failed=0, retried=0, errors=[])
    while out.ran < limit:
        job_id = await claim_next(tenant_id)
        if job_id is None:
            break
        outcome = await run_job(tenant_id, job_id, transports)
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
