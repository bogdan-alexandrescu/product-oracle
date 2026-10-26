"""Oracle's read of an intake (INT2): a SwarmCloud ``intake_analysis`` run, with the
built-in pool job as its fallback and its rollback.

Owner answers (docs/product-oracle-v2/specs/owner-answers.md, INT2):

- Q1: the run reads exactly the job's payload (:func:`oracle.intake.job.payload`) through
  one run-bound route, ``GET /v1/intakes/{id}/analysis-input``, answered only to the token
  of that intake's own run (:func:`analysis_input`).
- Q2: a read starts on create and on repin when the intake's ``ai_extraction`` is on and
  the company switch ``intake_ai_read`` is on (the default); the author may also start one
  (Analyse with Oracle, ``POST /v1/intakes/{id}/ai-read``). One read at a time: a newer
  one ends the one before (the newest snapshot wins).
- Q3 (changed): when the SwarmCloud read cannot start, fails, or returns nothing usable,
  Oracle queues the built-in ``intake_analysis`` job for that intake, and the intake says
  which path produced its read (``path``, and ``fallback`` with why).
  ``ORACLE_INTAKE_READ_RUNTIME=job`` queues the job directly (the rollback).
- Q4: analyst at quick depth, $1.50 a read.

What either path writes is the author's private findings (S6): the run acts as the
author, who alone sees the read's state (:func:`state_out`; others get null).

State lives on ``intake.analysis["extraction"]``: ``read`` (the current read: path,
run_id or job_id, state, started_at, finished_at, added, dropped_refs, sources, error,
fallback, note), ``last`` (the last read's result) and ``failures`` (failed reads in a row;
two or more put one row in the author's Inbox until a read succeeds or the intake closes).
"""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Integer, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, safe_yaml
from oracle.auth.deps import Principal
from oracle.config import get_settings
from oracle.intake import job as intake_job
from oracle.jobs.models import LlmJob
from oracle.runs import extensions
from oracle.runs.flows import INTAKE_ANALYSIS_FILE
from oracle.runs.models import Run, RunSegment
from oracle.tenancy import current_tenant, tenant_session
from oracle.v2.models import ProductIntake

log = logging.getLogger(__name__)

FLOW = "intake_analysis"
SETTING = "intake_ai_read"
INTAKE_KNOB = "read_intake_id"
SNAPSHOT_KNOB = "intake_snapshot_id"
# Stored states: the live ones are read from the run or the job (:func:`state_out`).
LIVE = ("queued", "running")
FINAL_STATES = ("done", "failed", "replaced", "skipped")
INBOX_AFTER = 2
PENDING_PER_TICK = 20
SYNC_PER_TICK = 50
FALLBACKS = {
    "agent_unavailable": "Oracle couldn't start its read on the agent service, so Oracle's "
    "built-in model read it instead.",
    "agent_failed": "Oracle's read on the agent service failed, so Oracle's built-in model "
    "read it instead.",
    "invalid_output": "Oracle's read on the agent service returned nothing usable, so "
    "Oracle's built-in model read it instead.",
}
JOB_FAILED = "Oracle's read failed. The rules read stands."


class ReadError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _now() -> datetime:
    return datetime.now(UTC)


def _extraction(intake: ProductIntake) -> dict[str, Any]:
    return dict((intake.analysis or {}).get("extraction") or {})


def current(intake: ProductIntake) -> dict[str, Any] | None:
    read = _extraction(intake).get("read")
    return dict(read) if isinstance(read, dict) else None


def _store(intake: ProductIntake, **changes: Any) -> None:
    """Replace keys of ``analysis.extraction`` (a new dict, so the JSONB change is seen)."""
    analysis = dict(intake.analysis or {})
    analysis["extraction"] = {**_extraction(intake), **changes}
    intake.analysis = analysis


def _closed(intake: ProductIntake) -> bool:
    return intake.status in intake_job.CLOSED_INTAKE


async def company_on(db: AsyncSession) -> bool:
    from oracle.tenant_settings_api import get_setting

    return bool(await get_setting(db, SETTING))


def _snapshot(intake: ProductIntake) -> str | None:
    ids = intake.source_snapshot_ids or []
    return str(ids[-1]) if ids else None


# --- starting ----------------------------------------------------------------------------


async def start_read(
    db: AsyncSession, principal: Principal | None, intake: ProductIntake, *, on_demand=False
) -> dict[str, Any] | None:
    """Start Oracle's read of ``intake`` (create, repin, or the author's Analyse with
    Oracle when ``on_demand``), ending the one before. None when no read starts: the
    intake is closed, its ``ai_extraction`` is off (automatic reads only) or the company
    switch is off. May commit (a run's start does)."""
    if _closed(intake):
        return None
    if not on_demand and not _extraction(intake).get("ai"):
        return None
    if not await company_on(db):
        return None
    await end_active(db, intake)
    sources = await _sources(db, intake)
    if get_settings().intake_read_runtime == "job":
        return await _queue_job(db, principal, intake, sources, fallback=None)
    # What came before (the new intake, the ended read) is kept whatever the run does: a
    # run that cannot even be created rolls back only itself.
    await db.commit()
    try:
        run_id = await _start_run(db, intake)
    except Exception as exc:  # noqa: BLE001 - any refusal falls back to the job (Q3)
        log.warning("intake %s: the SwarmCloud read could not start: %s", intake.id, exc)
        await db.rollback()
        await db.refresh(intake)
        return await _queue_job(db, principal, intake, sources, fallback="agent_unavailable")
    await db.refresh(intake)
    read = {
        "path": "swarmcloud",
        "run_id": str(run_id),
        "job_id": None,
        "state": "running",
        "started_at": _now().isoformat(),
        "sources": sources,
        "snapshot_id": _snapshot(intake),
        "fallback": None,
    }
    _store(intake, read=read)
    await db.flush()
    return read


async def _sources(db: AsyncSession, intake: ProductIntake) -> int:
    _body, known, _chosen = await intake_job.payload(db, intake)
    return len(known)


async def _start_run(db: AsyncSession, intake: ProductIntake) -> uuid.UUID:
    """An intake_analysis run created as the author (its token acts for them), at the
    flow's quick depth, estimated and started (commits; the caller submits it, or the
    next tick does)."""
    from oracle.runs import service as runs_service
    from oracle.runs.schemas import KnobsIn, RunCreate

    if intake.author_id is None:
        raise ReadError(409, "The intake has no author to read as")
    body = RunCreate(flow=FLOW, knobs=KnobsIn(depth="quick"))  # type: ignore[arg-type]
    run_id = await runs_service.create_run(
        db,
        audit.ORACLE,
        body,
        entry_knobs={INTAKE_KNOB: str(intake.id), SNAPSHOT_KNOB: _snapshot(intake)},
        commit=False,
        created_by=intake.author_id,
    )
    await audit.record(db, audit.ORACLE, "intake.read_started", "intake", intake.id,
                       {"run_id": str(run_id)})  # fmt: skip
    await db.commit()
    await runs_service.estimate(db, audit.ORACLE, run_id)
    await runs_service.start(db, audit.ORACLE, run_id)
    return run_id


async def _queue_job(
    db: AsyncSession,
    principal: Principal | None,
    intake: ProductIntake,
    sources: int,
    *,
    fallback: str | None,
) -> dict[str, Any]:
    from oracle.intake import service

    job = await service.queue_extraction(db, principal, intake)
    read = {
        "path": "job",
        "run_id": (current(intake) or {}).get("run_id") if fallback else None,
        "job_id": str(job.id),
        "state": "queued",
        "started_at": _now().isoformat(),
        "sources": sources,
        "snapshot_id": _snapshot(intake),
        "fallback": {"code": fallback, "message": FALLBACKS[fallback]} if fallback else None,
    }
    _store(intake, read=read)
    await db.flush()
    return read


async def end_active(db: AsyncSession, intake: ProductIntake) -> None:
    """End the intake's read under way (a run, or a queued job): a newer one replaces it."""
    from oracle.runs import service as runs_service

    read = current(intake)
    if read is None or read.get("state") in FINAL_STATES:
        return
    if read.get("run_id") and read.get("path") == "swarmcloud":
        await runs_service.end_as_oracle(
            db, uuid.UUID(read["run_id"]), "Replaced by a newer read of the intake"
        )
    if read.get("job_id"):
        job = await db.get(LlmJob, uuid.UUID(read["job_id"]))
        if job is not None and job.status == "queued":
            job.status = "cancelled"
            job.error_reason = "replaced"
            job.finished_at = _now()
    read["state"] = "replaced"
    read["finished_at"] = _now().isoformat()
    _store(intake, read=read)
    await db.flush()


async def submit(db: AsyncSession, read: dict[str, Any] | None) -> None:
    """Submit a read's run now (outside the review gate), rather than on the next tick;
    a refusal is the tick's to find (:func:`sync`)."""
    from oracle.runs import service as runs_service

    if not read or read.get("path") != "swarmcloud" or not read.get("run_id"):
        return
    try:
        await runs_service.submit_queued(db, uuid.UUID(read["run_id"]))
    except Exception:  # noqa: BLE001 - the tick submits it again
        log.exception("intake read %s: the submission failed", read.get("run_id"))
        await db.rollback()


async def on_demand(db: AsyncSession, principal: Principal, intake: ProductIntake):
    """Analyse with Oracle: the author only (403), 409 while a read is under way, on a
    closed intake, or with the company switch off."""
    if principal.is_run or principal.user_id is None or intake.author_id != principal.user_id:
        raise ReadError(403, "Only the intake's author can ask Oracle to read it")
    if _closed(intake):
        raise ReadError(409, f"The intake is {intake.status}")
    if not await company_on(db):
        raise ReadError(409, "Oracle's read is off for this company")
    await sync(db, intake)
    read = current(intake)
    if read is not None and read.get("state") in LIVE:
        raise ReadError(409, "Oracle is already reading this intake")
    out = await start_read(db, principal, intake, on_demand=True)
    await db.commit()
    return out


# --- following a read ----------------------------------------------------------------------


async def _fallback(db: AsyncSession, intake: ProductIntake, code: str, error: str) -> None:
    read = current(intake) or {}
    log.info("intake %s: falling back to the built-in job (%s): %s", intake.id, code, error)
    await audit.record(db, audit.ORACLE, "intake.read_fallback", "intake", intake.id,
                       {"run_id": read.get("run_id"), "code": code})  # fmt: skip
    await _queue_job(db, None, intake, int(read.get("sources") or 0), fallback=code)


def _failed(intake: ProductIntake, read: dict[str, Any], code: str, message: str) -> None:
    read.update(state="failed", finished_at=_now().isoformat(),
                error={"code": code, "message": message})  # fmt: skip
    _store(intake, read=read, failures=int(_extraction(intake).get("failures") or 0) + 1)


def _done(intake: ProductIntake, read: dict[str, Any], out: dict[str, Any], **last) -> None:
    read.update(
        state="skipped" if out.get("skipped") else "done",
        finished_at=_now().isoformat(),
        added={"items": int(out.get("items_added") or 0), "gaps": int(out.get("gaps_added") or 0)},
        dropped_refs=int(out.get("dropped_refs") or 0),
        error=None,
    )
    if out.get("skipped"):
        read["note"] = f"Skipped: {out['skipped']}"
    changes: dict[str, Any] = {"read": read}
    if not out.get("skipped"):
        changes["failures"] = 0
        changes["last"] = {**out, **last, "path": read.get("path"),
                           "finished_at": read["finished_at"]}  # fmt: skip
    _store(intake, **changes)


def job_finished(intake: ProductIntake, job: LlmJob, out: dict[str, Any]) -> None:
    """The built-in job stored its answer (oracle.intake.job.run): the read it is ends."""
    read = current(intake)
    if read is None or read.get("job_id") != str(job.id):
        return
    _done(intake, read, out, llm_job_id=str(job.id), cost_usd=None)


async def _unstarted(db: AsyncSession, run: Run) -> str | None:
    """Why a running read's run never reached SwarmCloud: its segment is back in the queue
    with the refusal, no workflow, and no submission that may have landed."""
    segments = list(await db.scalars(select(RunSegment).where(RunSegment.run_id == run.id)))
    for s in segments:
        if s.status == "pending" and s.error and not s.swarm_workflow_id:
            if (s.artifacts or {}).get("lost"):
                return None
            return s.error
    return None


async def sync(db: AsyncSession, intake: ProductIntake) -> bool:
    """Bring the intake's read up to date with its run or job: a run that could not start
    or failed falls back to the job (Q3); a job that failed ends the read failed. True
    when something changed (the caller commits)."""
    from oracle.runs import service as runs_service

    read = current(intake)
    if read is None or read.get("state") not in LIVE:
        return False
    if read.get("path") == "swarmcloud":
        run = await db.get(Run, uuid.UUID(read["run_id"])) if read.get("run_id") else None
        if run is None:
            await _fallback(db, intake, "agent_unavailable", "the run is gone")
            return True
        if run.status in ("failed", "cancelled"):
            await _fallback(db, intake, "agent_failed", run.error or run.status)
            return True
        if run.status == "succeeded":
            # The importer ends the read; a run that ended with none imported failed.
            await _fallback(db, intake, "invalid_output", "nothing was imported")
            return True
        refusal = await _unstarted(db, run) if run.status == "running" else None
        if refusal is not None:
            await runs_service.end_as_oracle(db, run.id, f"Could not start: {refusal}")
            await _fallback(db, intake, "agent_unavailable", refusal)
            return True
        return False
    job = await db.get(LlmJob, uuid.UUID(read["job_id"])) if read.get("job_id") else None
    if job is None or job.status in ("failed", "cancelled"):
        code = (job.error_reason if job is not None else None) or "job_failed"
        _failed(intake, read, code, JOB_FAILED)
        return True
    if job.status == "succeeded":
        # Skipped by the job itself (a closed intake), or stored before INT2's marker.
        _done(intake, read, job.output or {}, llm_job_id=str(job.id))
        return True
    return False


async def tick(db: AsyncSession) -> int:
    """The tick: follow every read under way (fallbacks, failures), then start the reads
    of intakes whose queued job migration 0055 moved. Returns the reads started."""
    state = ProductIntake.analysis["extraction"]["read"]["state"].astext
    query = select(ProductIntake.id).where(state.in_(LIVE)).limit(SYNC_PER_TICK)
    for intake_id in list(await db.scalars(query)):
        # Read afresh: a commit or rollback before may have expired it.
        intake = await db.get(ProductIntake, intake_id, populate_existing=True)
        if intake is None:
            continue
        try:
            if await sync(db, intake):
                await db.commit()
        except Exception:
            log.exception("intake read %s could not be followed", intake_id)
            await db.rollback()
    return await start_pending_reads(db)


async def start_pending_reads(db: AsyncSession, limit: int = PENDING_PER_TICK) -> int:
    """Open intakes with ``ai_extraction`` on whose queued job the migration cancelled
    (``moved_to_swarmcloud``) and that have no read yet: a read each, at most ``limit``."""
    if not await company_on(db):
        return 0
    extraction = ProductIntake.analysis["extraction"]
    moved = select(LlmJob.intake_id).where(
        LlmJob.kind == FLOW, LlmJob.error_reason == "moved_to_swarmcloud"
    )
    ids = list(
        await db.scalars(
            select(ProductIntake.id)
            .where(
                ProductIntake.id.in_(moved),
                ProductIntake.status.not_in(intake_job.CLOSED_INTAKE),
                extraction["ai"].astext == "true",
                ~extraction.has_key("read"),
            )
            .order_by(ProductIntake.created_at)
            .limit(limit)
        )
    )
    started = 0
    for intake_id in ids:
        # Read afresh: the submission before may have rolled the session back.
        intake = await db.get(ProductIntake, intake_id, populate_existing=True)
        if intake is None:
            continue
        read = await start_read(db, None, intake)
        await db.commit()
        await submit(db, read)
        started += 1
    return started


# --- importing ------------------------------------------------------------------------------


def _parse(text: str) -> dict[str, Any]:
    data = safe_yaml.load(text, limit=64_000)
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError(f"{INTAKE_ANALYSIS_FILE} is not version 1")
    for key in ("items", "gaps"):
        if not isinstance(data.get(key) or [], list):
            raise ValueError(f"{key} is not a list")
    return data


def run_intake_id(run: Any) -> uuid.UUID | None:
    raw = (run.knobs or {}).get(INTAKE_KNOB)
    try:
        return uuid.UUID(str(raw)) if raw else None
    except ValueError:
        return None


async def import_analysis(
    db: AsyncSession, run: Any, files: dict[str, str], principal: Principal
) -> dict[str, Any]:
    """The ``intake_analysis`` importer: analysis.yaml through :func:`intake_job.apply_answer`
    (the job's caps, dedupe and S6 restriction), for the read the intake is still waiting
    on. A closed intake imports nothing; an unreadable file imports nothing and falls back
    to the job (Q3)."""
    intake_id = run_intake_id(run)
    if intake_id is None:
        return {"error": "the run names no intake"}
    text = files.get(INTAKE_ANALYSIS_FILE)
    answer: dict[str, Any] | None = None
    error = None
    if text is None:
        error = f"the run left no {INTAKE_ANALYSIS_FILE}"
    else:
        try:
            answer = await safe_yaml.run_parse_within(_parse, text, name=INTAKE_ANALYSIS_FILE)
        except (ValueError, safe_yaml.SafeYamlError, safe_yaml.ParseTimeout) as exc:
            error = f"{INTAKE_ANALYSIS_FILE} could not be read ({exc})"[:300]
    async with tenant_session(current_tenant(db)) as s:
        intake = await s.get(ProductIntake, intake_id)
        read = current(intake) if intake is not None else None
        if intake is None or read is None or read.get("run_id") != str(run.id):
            return {"notes": ["Skipped: a newer read replaced this one"]}
        if read.get("state") not in LIVE:
            return {"notes": [f"Skipped: the read is {read.get('state')}"]}
        if _closed(intake):
            _done(intake, read, {"skipped": f"the intake is {intake.status}"})
            await s.commit()
            return {"notes": [f"Skipped: the intake is {intake.status}"]}
        if error is not None or answer is None:
            await _fallback(s, intake, "invalid_output", error or "empty")
            await s.commit()
            return {"error": error}
        _body, known, chosen = await intake_job.payload(s, intake)
        marker = {"run_id": str(run.id), "llm_job_id": None}
        out = await intake_job.apply_answer(s, intake, answer, known, chosen, marker)
        cost = float(run.spent_usd) if run.spent_usd is not None else None
        _done(intake, read, out, run_id=str(run.id), cost_usd=cost)
        await s.commit()
    notes = []
    if out.get("dropped_refs"):
        notes.append(f"{out['dropped_refs']} evidence refs outside the input dropped")
    return {"imported": out, "notes": notes}


async def prompt_lines(db: AsyncSession, run: Any) -> list[str]:
    intake_id = run_intake_id(run)
    return [f"Intake id: {intake_id}"] if intake_id else []


extensions.register_importer(FLOW, import_analysis)
extensions.register_prompt_lines(FLOW, prompt_lines)


# --- the run-bound input ------------------------------------------------------------------

REFUSED = "This is for Oracle's read of an intake"


async def analysis_input(
    db: AsyncSession, principal: Principal, intake: ProductIntake
) -> dict[str, Any]:
    """The job's exact payload for the token of this intake's own read (Q1): 403 for
    people, API tokens and MCP clients; 404 for any other run token (another intake's run,
    another flow, no read:intake-input, a stale snapshot, or a run its author did not
    create). Each read is audited as ``intake.evidence_query`` (spec-INT2)."""
    from oracle.runtokens import RunToken

    if principal.run_id is None or principal.run_token_id is None:
        raise ReadError(403, REFUSED)
    token = await db.get(RunToken, principal.run_token_id)
    run = await db.get(Run, principal.run_id)
    if (
        token is None
        or token.run_id != principal.run_id
        or "read:intake-input" not in (token.scopes or [])
        or run is None
        or run.flow != FLOW
        or run_intake_id(run) != intake.id
        or run.created_by is None
        or run.created_by != intake.author_id
        or (run.knobs or {}).get(SNAPSHOT_KNOB) != _snapshot(intake)
    ):
        raise ReadError(404, "Intake not found")
    body, known, chosen = await intake_job.payload(db, intake)
    await audit.record(
        db, principal, "intake.evidence_query", "intake", intake.id,
        {"route": "get_intake_analysis_input", "run_id": str(run.id),
         "item_ids": [str(i.id) for i in chosen]},
    )  # fmt: skip
    await db.commit()
    return {**body, "untrusted": True}


# --- what the author sees -------------------------------------------------------------------


async def state_out(db: AsyncSession, intake: ProductIntake, principal: Principal):
    """``IntakeSummary.ai_read``: the author's only (others get None: the read is private).
    A read under way is followed first (:func:`sync`)."""
    from oracle.intake.schemas import AiReadOut

    if principal.is_run or principal.user_id is None or intake.author_id != principal.user_id:
        return None
    if await sync(db, intake):
        await db.commit()
    read = current(intake)
    failures = int(_extraction(intake).get("failures") or 0)
    if read is None or read.get("state") == "replaced":
        reason = "company" if not await company_on(db) else "intake"
        return AiReadOut(state="off", off_reason=reason, failures=failures)
    state = read.get("state")
    if state in LIVE:
        state = await _live_state(db, read)
    elif state == "skipped":
        state = "done"
    return AiReadOut(
        state=state,
        path=read.get("path"),
        run_id=read.get("run_id"),
        job_id=read.get("job_id"),
        started_at=read.get("started_at"),
        finished_at=read.get("finished_at"),
        sources=int(read.get("sources") or 0),
        added=read.get("added"),
        dropped_refs=int(read.get("dropped_refs") or 0),
        error=read.get("error"),
        fallback=read.get("fallback"),
        note=read.get("note"),
        failures=failures,
    )


async def _live_state(db: AsyncSession, read: dict[str, Any]) -> str:
    if read.get("path") == "job":
        status = await db.scalar(select(LlmJob.status).where(LlmJob.id == read["job_id"]))
        return "running" if status == "running" else "queued"
    submitted = await db.scalar(
        select(RunSegment.id).where(
            RunSegment.run_id == read["run_id"], RunSegment.swarm_workflow_id.is_not(None)
        )
    )
    return "running" if submitted else "queued"


async def inbox_rows(db: AsyncSession, principal: Principal):
    """One row per open intake of mine whose last reads failed twice or more in a row."""
    from oracle.runs.schemas import InboxIntakeRead

    if principal.is_run or principal.user_id is None:
        return []
    failures = ProductIntake.analysis["extraction"]["failures"].astext.cast(Integer)
    rows = await db.scalars(
        select(ProductIntake)
        .where(
            ProductIntake.author_id == principal.user_id,
            ProductIntake.status.not_in(intake_job.CLOSED_INTAKE),
            ProductIntake.analysis["extraction"].has_key("failures"),
            failures >= INBOX_AFTER,
        )
        .order_by(ProductIntake.updated_at.desc())
    )
    out = []
    for intake in rows:
        read = current(intake) or {}
        out.append(
            InboxIntakeRead(
                intake_id=intake.id,
                title=intake.title,
                failures=int(_extraction(intake).get("failures") or 0),
                at=read.get("finished_at"),
            )
        )
    return out
