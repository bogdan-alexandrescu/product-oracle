"""Runs: the tick, which advances every run: costs, overruns, segments ended, searches."""

import asyncio
import uuid
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, safe_yaml, webhooks
from oracle.auth.deps import Principal
from oracle.errors import exception_text
from oracle.roadmap import doc_dates
from oracle.runs import service
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.schemas import TickOut, TickUnchecked
from oracle.runs.service import (
    DECIDED,
    FINAL,
    Unavailable,
    _art,
    _attempts_cost,
    _ceiling,
    _flow,
    _known_sum,
    _refs,
    _segments,
    _set_art,
    _set_knob,
    _spent,
    _TickStats,
    log,
)
from oracle.runtokens import revoke_run_tokens
from oracle.swarm import RuntimeUnavailable, WorkflowStatus


def _dates_pending(exc: BaseException) -> bool:
    """A roadmap's dates still being found, or its company's date jobs busy
    (oracle.roadmap.doc_dates: 503, try again): a tick retries, never a failed try or run.
    Dates given up on (422) are a failure like any other."""
    return isinstance(exc, doc_dates.DatesUnavailable) and exc.pending


def _resetter(stats: _TickStats) -> Callable[[], None]:
    """``reset`` for one :func:`_replay`: puts ``stats`` back as they are now, before it."""
    saved = replace(stats, errors=list(stats.errors), active=set(stats.active))

    def reset() -> None:
        for f in ("checked", "finished", "advanced", "paused"):
            setattr(stats, f, getattr(saved, f))
        stats.errors[:] = saved.errors
        stats.active.clear()
        stats.active.update(saved.active)

    return reset


async def _tick_run(db: AsyncSession, run: Run, stats: _TickStats, deadline: float) -> None:
    """One run's tick pass (the run locked by the caller, inside :func:`_replay`: in a
    live workflow's pass the runtime calls (status, artifacts, a wait's record, the
    cancels) are made outside the lock and the pass runs again with their results, on the
    run as it is by then). In segment mode the run's row lock is not held across the
    status and artifact reads either: the transaction ends, the runtime is called (within
    :data:`TICK_RUN_SECONDS`, ``deadline`` in loop time), then the run is locked and read
    again and the outcome written only if it still applies (the run still active, the
    segment still running the same workflow). So a cancel, or a disable of the run's
    creator (which holds the review gate while it waits on the run's row), never waits on
    those reads. What a pass queued is submitted by the caller (:func:`submit_queued`)."""
    run_id = run.id
    runtime = service.get_runtime()
    segments = await _segments(db, run.id)
    wf = service._live(run)
    if wf is not None and (wf.get("cancel_pending") or run.status in FINAL):
        if not await _retry_pending_cancel(db, run, wf, segments, stats) or run.status != "running":
            return
        wf = None  # confirmed: what was held back (a new workflow) goes on below
        # Its last cost may have crossed the ceiling: nothing is submitted over it.
        if (ceiling := _overrun(run)) is not None:
            await _pause_overrun(db, run, ceiling, stats)
            return
    # The workflow's status is read before anything that commits (a resumed advance): a pass
    # run again after a runtime call (:func:`_replay`) must not redo what it committed.
    status: WorkflowStatus | None = None
    if wf is not None and not wf.get("cancel_pending") and run.status not in FINAL:
        try:
            status = await service._rt().status(wf["id"])
        except RuntimeUnavailable:
            status = None  # read again where it is needed, and failing there as before
    resuming = service._resuming(run, segments)
    if resuming is not None:
        failed = service._current_attempt(_art(resuming), resuming).get("resume_failures") or {}
        if failed.get("pass") == stats.pass_id:
            # Tried and counted by this tick's pass already, which runs again after a
            # runtime call: not tried again; its error, which ``reset`` dropped, reported.
            stats.errors.append(service._resume_error(run.id, resuming, failed))
        else:
            try:
                await service._resume_advance(db, run, resuming, segments, stats)
                return
            except safe_yaml.ParseBusy:
                # No free worker: not a failed try (RESUME_TRIES). The tick rolls back,
                # records parse_busy and the next tick resumes the advance again.
                raise
            except Exception as exc:  # counted; the workflow is still read below
                if _dates_pending(exc):
                    # Not a failed try (RESUME_TRIES): the tick gives up on this run and
                    # the next tick resumes the advance again.
                    raise
                run, segments = await service._resume_failed(db, run.id, resuming.seq, exc, stats)
        wf = service._live(run)
        if wf is not None and not wf.get("cancel_pending") and run.status not in FINAL:
            # Its status, cost and the ceiling, a wait's expiry and the workflow's end:
            # read whatever the resume did.
            await service._tick_workflow(db, run, wf, segments, stats, status)
        return
    if wf is not None:
        await service._tick_workflow(db, run, wf, segments, stats, status)
        return
    if run.status in FINAL:
        return
    running = next((s for s in segments if s.status == "running"), None)
    if running is None:
        if run.status != "running":
            return
        # A submission the runtime refused earlier, or one a request queued: the caller
        # submits it (what this pass wrote, a cancel confirmed above, commits first).
        if any(service._waiting(s) for s in segments):
            await db.commit()
            return
        if (awaiting := service._awaiting_items(segments)) is not None:
            # F4 lane B: the draft's roadmap items, re-checked on every tick.
            await service._submit(db, run, awaiting, segments)
            await db.commit()
            return
        # Resumed after an overrun with a finished segment not yet advanced.
        done = [s for s in segments if s.status == "succeeded"]
        if done and await service._advance(db, run, done[-1], segments):
            stats.advanced += 1
        await db.commit()
        return

    segment_id, workflow_id = running.id, running.swarm_workflow_id or ""
    await db.commit()  # nothing held across the runtime calls
    status = await service._within(runtime.status(workflow_id), deadline)
    files: dict[str, str] = {}
    skipped: dict[str, str] = {}
    if status.terminal and status.state == "succeeded":
        files, skipped = await service._within(runtime.read_artifacts(workflow_id), deadline)

    run, segments = await service._locked(db, run_id)
    running = next((s for s in segments if s.id == segment_id), None)
    if (
        run is None
        or run.status not in ("running", "paused_overrun")
        or running is None
        or running.status != "running"
        or running.swarm_workflow_id != workflow_id
    ):
        await db.rollback()  # cancelled, decided or ticked meanwhile: not ours to write
        return
    art = _art(running)
    # A workflow's cost counts once, on the first attempt that carries it: a later
    # segment of a multi-segment workflow left running on it counts nothing again.
    earlier = next(
        (
            s
            for s in segments
            if s.seq < running.seq
            and any(a.get("workflow_id") == running.swarm_workflow_id for a in _art(s)["attempts"])
        ),
        None,
    )
    if art["attempts"]:
        # The running workflow's attempt (one found later may sit after it). On an earlier
        # segment's workflow it keeps what its own agents spent (:func:`_take_cost`).
        current = service._current_attempt(art, running)
        if earlier is None:
            current["cost_usd"] = service._higher(status.cost_usd, current.get("cost_usd"))
        current["state"] = status.state
    running.cost_usd = _attempts_cost(art)
    _set_art(running, art)
    if earlier is not None:
        # The rest of the workflow's cost, counted once.
        service._cost_on(
            run, segments, {"seq": earlier.seq, "id": running.swarm_workflow_id}, status.cost_usd
        )
    service._recompute_spend(run, segments)
    service._record_agents(running, workflow_id, status)
    service._record_wait(
        run,
        running,
        workflow_id,
        service._current_attempt(art, running).get("submitted_at"),
        status,
    )
    art = _art(running)

    if status.terminal and status.state == "succeeded" and skipped:
        held = service._note_refused(
            run, running, art, skipped, await service._import_names(db, run, running)
        )
        if held is not None:
            # A file its import needs was refused: not taken, read again next tick.
            stats.errors.append(held)
            _set_art(running, art)
            await db.commit()
            return

    if status.terminal:
        stats.finished += 1
        running.finished_at = service._now()
        if status.state == "succeeded":
            art["files"] = {**art["files"], **files}
            running.status = "succeeded"
            await revoke_run_tokens(db, run.id)
        else:
            running.status = "failed" if status.state == "failed" else "cancelled"
            running.error = (
                service._failed_why(run, running, status)
                if status.state == "failed"
                else status.error or f"the workflow ended {status.state}"
            )
            _set_art(running, art)
            await service._finish(
                db, run, "failed", f"{service._title(run, running)}: {running.error}"
            )
            await audit.record(db, None, "run.failed", "run", run.id, {"segment": running.name})
            await db.commit()
            return
    _set_art(running, art)

    ceiling = _ceiling(run)
    if run.status == "running" and ceiling is not None and _spent(run) > ceiling:
        run.status = "paused_overrun"
        stats.paused += 1
        await audit.record(
            db,
            None,
            "run.paused_overrun",
            "run",
            run.id,
            {"spent_usd": str(run.spent_usd), "ceiling_usd": str(ceiling)},
        )
        await webhooks.capture(db, "run.paused_overrun", audit.ORACLE, run_id=run.id)
        await db.commit()
        return
    advanced = False
    if run.status == "running" and running.status == "succeeded":
        advanced = await service._advance(db, run, running, segments)
        stats.advanced += advanced
    await db.commit()


def _take_cost(
    run: Run, wf: dict[str, Any], status: WorkflowStatus, segments: list[RunSegment]
) -> RunSegment | None:
    """The live workflow's cost, on the attempt of the segment it was submitted for, and
    the run's spend from it. Returns that segment.

    #258: a later segment started in the workflow carries what its own steps cost; the
    rest of the workflow's cost goes on the first attempt of the segment it was submitted
    for: a revision inside the workflow is another attempt on the same workflow, and
    counts nothing again. The workflow's cost and a step's are never lowered."""
    start = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    others = Decimal(0)
    for entry in wf.get("segments") or []:
        later = next((s for s in segments if s.seq == entry.get("seq")), None)
        if later is None or later is start:
            continue
        own = {*entry.get("work", []), *entry.get("reviews", []), *entry.get("revises", [])}
        spent = _known_sum(st.cost_usd for st in status.steps if st.step_id in own)
        art = _art(later)
        first = True
        for a in art["attempts"]:
            if a.get("workflow_id") == wf["id"]:
                a["cost_usd"] = service._higher(spent, a.get("cost_usd")) if first else 0
                others += Decimal(str(a["cost_usd"] or 0))
                first = False
        later.cost_usd = _attempts_cost(art)
        _set_art(later, art)
    if start is not None:
        art = _art(start)
        first = True
        for a in art["attempts"]:
            if a.get("workflow_id") == wf["id"]:
                # Never lowered: a read made earlier (cancel() reads before it takes the
                # run's row lock) is not newer than one the tick recorded meanwhile.
                if first:
                    total = service._higher(
                        status.cost_usd, a.get("workflow_cost_usd", a.get("cost_usd"))
                    )
                    a["workflow_cost_usd"] = total
                    a["cost_usd"] = None if total is None else max(total - float(others), 0)
                else:
                    a["cost_usd"] = 0
                first = False
        start.cost_usd = _attempts_cost(art)
        _set_art(start, art)
    service._recompute_spend(run, segments)
    return start


def _overrun(run: Run) -> Decimal | None:
    """The ceiling when the run's spend is over it."""
    ceiling = _ceiling(run)
    return ceiling if ceiling is not None and _spent(run) > ceiling else None


async def _pause_overrun(
    db: AsyncSession, run: Run, ceiling: Decimal, stats: _TickStats | None = None
) -> None:
    run.status = "paused_overrun"
    if stats is not None:
        stats.paused += 1
    await audit.record(
        db,
        None,
        "run.paused_overrun",
        "run",
        run.id,
        {"spent_usd": str(run.spent_usd), "ceiling_usd": str(ceiling)},
    )
    await webhooks.capture(db, "run.paused_overrun", audit.ORACLE, run_id=run.id)


# Run states the ceiling pauses (a run waiting on a checkpoint can spend too).
_SPENDING = ("running", "awaiting_checkpoint")


def _rested(pending: dict[str, Any]) -> bool:
    """A cancel past :data:`NOT_FOUND_TRIES` (in the Inbox) is tried again now and then
    (only the cancel call rests: the workflow's status and cost are read every tick)."""
    tried = service._parse_at(pending.get("tried_at"))
    return (
        bool(pending.get("stuck"))
        and tried is not None
        and (service._now() - tried).total_seconds() < service.STUCK_LOOKUP_SECONDS
    )


async def _retry_pending_cancel(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    segments: list[RunSegment],
    stats: _TickStats,
) -> bool:
    """A workflow Oracle is cancelling and SwarmCloud has not confirmed it: read its cost
    (it may still be spending) and cancel it again. True once it is cancelled or ended.
    A lost submission (no id yet) is looked up by its label first; a workflow SwarmCloud
    does not know (404) is given up, and recorded. A 404 that proves nothing is counted:
    past :data:`NOT_FOUND_TRIES` the run shows in the Inbox with Cancel, and is tried
    again every :data:`STUCK_LOOKUP_SECONDS`."""
    runtime = service._rt()
    pending = wf.get("cancel_pending") or {}
    state = pending.get("state") or "ended"
    # Past the cap only the cancel call rests: its status and cost are read every tick.
    rested = _rested(pending)
    if not wf.get("id"):
        label = wf.get("lookup") or ""
        try:
            found = await runtime.find_by_label(
                label, since=service._parse_at(wf.get("lookup_since"))
            )
        except RuntimeUnavailable as exc:
            log.warning("run %s: looking up %s to cancel it: %s", run.id, label, exc)
            lookups = int(pending.get("lookups") or 0) + 1
            since = wf.get("lookup_since") or pending.get("since")
            if service._lookup_exhausted({"submitted_at": since, "lookups": lookups}):
                # Never found, never ruled out: looked for in the background instead.
                await _stop_looking(db, run, wf, segments, state, exc)
                return True
            _set_knob(run, "workflow", {**wf, "cancel_pending": {**pending, "lookups": lookups}})
            return False
        if not found:
            await service._end_workflow(db, run, wf, state)
            return True
        wf = {**wf, "id": found}
        _set_knob(run, "workflow", wf)
        _adopt(segments, wf)
    try:
        status = await runtime.status(wf["id"])
    except RuntimeUnavailable as exc:
        if exc.gone and pending.get("confirmed"):
            # Its cancel was confirmed: read once more before it is taken as ended.
            service._read_once_more(run, wf)
            await service._end_workflow(db, run, wf, state)
            return True
        if exc.gone:
            await service._give_up(db, run, wf, state)
            return True
        if rested:
            log.warning("run %s: %s not read (resting): %s", run.id, wf["id"], exc)
            return False
        if pending.get("confirmed"):
            # Its cancel was confirmed and this was the one more read of its last cost:
            # read on in the background, so that nothing waits on it here.
            note = (
                f"SwarmCloud confirmed cancelling workflow {wf['id']}, but its last cost could "
                f"not be read ({service._shown(exc)}); Oracle reads it in the background until it "
                "ends and counts it on the run."
            )
            target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
            service._note(target or segments[0], note)
            service._read_on(run, wf)
            await service._end_workflow(db, run, wf, state)
            return True
        if service._not_found(exc):
            # Proves nothing: counted (kept, not rolled back), and tried again.
            marker = {
                **pending,
                "tried_at": service._now().isoformat(),
                "error": service._shown(exc),
            }
            service._count_not_found(marker, pending, True)
            _set_knob(run, "workflow", {**wf, "cancel_pending": marker})
            stats.errors.append(f"run {run.id}: {exception_text(exc)}")
            return False
        raise
    _take_cost(run, wf, status, segments)
    if status.terminal:
        await service._end_workflow(db, run, wf, state)
        return True
    if pending.get("confirmed"):
        # Confirmed and winding down: read on in the background until it ends.
        service._read_on(run, wf, costed=True)
        await service._end_workflow(db, run, wf, state)
        return True
    if not rested and await service._detach(db, run, cancel=True, state=state):
        return True
    if run.status in _SPENDING and (ceiling := _overrun(run)) is not None:
        await _pause_overrun(db, run, ceiling, stats)
    return False


async def _stop_looking(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    segments: list[RunSegment],
    state: str,
    exc: RuntimeUnavailable,
) -> None:
    """A lost submission of a run that ended, looked for past the lookup cap without an
    answer either way: no longer looked up on every tick, but in the background
    (:func:`_search_earlier`) until found (then cancelled, its cost counted) or ruled
    out, within its credential's lifetime. Its token is revoked."""
    label = wf.get("lookup") or ""
    service._search_for(
        run,
        label=label,
        seq=wf.get("start_seq"),
        submitted_at=wf.get("lookup_since") or (wf.get("cancel_pending") or {}).get("since"),
        until=wf.get("lookup_until"),
        why="cancel",
    )
    note = (
        f"After {service._duration(service.LOST_LOOKUP_SECONDS)} SwarmCloud's task listing still "
        "neither shows "
        f"submission {label} nor rules it out ({service._shown(exc)}). Its run token is revoked, "
        "and "
        f"Oracle keeps looking for it in the background every "
        f"{service._duration(service.STUCK_LOOKUP_SECONDS)}: if it landed, Oracle cancels it and "
        "counts its "
        "cost."
    )
    log.warning("run %s: %s", run.id, note)
    target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if target is not None or segments:
        service._note(target or segments[0], note)
    await service._end_workflow(db, run, wf, state)


def _attempt_of(label: str | None, fallback: int) -> int:
    """The attempt number in a submission's key (``oracle-<run>-<segment>-<attempt>``)."""
    tail = (label or "").rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else fallback


def _add_attempt(
    segment: RunSegment, workflow_id: str, label: str | None, state: str, **extra: Any
) -> None:
    """A workflow found for the segment (a lost submission), as one of its attempts in
    the order of their numbers, so that its cost counts in the run's spend."""
    art = _art(segment)
    if any(a.get("workflow_id") == workflow_id for a in art["attempts"]):
        return
    number = _attempt_of(label, len(art["attempts"]) + 1)
    at = next(
        (i for i, a in enumerate(art["attempts"]) if int(a.get("attempt") or 0) > number),
        len(art["attempts"]),
    )
    art["attempts"].insert(
        at,
        {
            "attempt": number,
            "workflow_id": workflow_id,
            "submitted_at": service._now().isoformat(),
            "cost_usd": None,
            "note": None,
            "state": state,
            "label": label,
            **extra,
        },
    )
    _set_art(segment, art)


def _adopt(segments: list[RunSegment], wf: dict[str, Any]) -> None:
    """A lost submission found while cancelling: an attempt of its segment, so that its
    cost is counted in the run's spend."""
    segment = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if segment is not None:
        _add_attempt(segment, wf["id"], wf.get("label"), "cancelled", mode=wf.get("mode"))


async def _tick_searches(db: AsyncSession, run_id: uuid.UUID, stats: _TickStats) -> bool:
    """Look for the submissions Oracle gave up on (:func:`_search_earlier`), committed on
    its own: what was found, cancelled and counted stays so, whatever the rest of this
    tick does, and is never counted again by a pass run again for a runtime call."""
    run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
    if run is None or not (run.knobs or {}).get("searches"):
        await db.rollback()
        return False
    await service._search_earlier(db, run, await _segments(db, run_id), stats)
    await db.commit()
    return True


async def _tick_one(
    db: AsyncSession, run_id: uuid.UUID, stats: _TickStats, deadline: float
) -> bool:
    """One run's pass under its row lock (skipped when another transaction holds it, or
    nothing there needs a tick); False when the run was skipped. Run inside
    :func:`_replay`: it reads the run afresh every time it starts."""
    run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
    if run is None or not (
        run.status in ("running", "paused_overrun")
        or service._live(run) is not None
        or (run.knobs or {}).get("searches")
    ):
        await db.rollback()
        return False
    stats.checked += 1
    if run.status == "running":
        stats.active.add(run.id)
    await service._tick_run(db, run, stats, deadline)
    await db.commit()
    return True


async def _stamp_checked(db: AsyncSession, run_id: uuid.UUID, since: datetime) -> None:
    """run-progress: a running run this tick read shows it was checked now, even where
    its pass recorded no agents (they stay as last read)."""
    run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
    if run is None or run.status != "running":
        await db.rollback()
        return
    current = next((s for s in await _segments(db, run_id) if s.status == "running"), None)
    if current is None or not current.swarm_workflow_id:
        await db.rollback()
        return
    art = _art(current)
    progress = art.get("progress") or {}
    if (at := service._parse_at(progress.get("checked_at"))) is not None and at >= since:
        await db.rollback()
        return
    same = progress.get("workflow_id") == current.swarm_workflow_id
    art["progress"] = {
        "workflow_id": current.swarm_workflow_id,
        "checked_at": service._now().isoformat(),
        "agents": progress.get("agents") or [] if same else [],
    }
    _set_art(current, art)
    await db.commit()


def _unchecked_reason(exc: BaseException | str) -> str:
    """run-progress: why a tick could not check a run, in a few plain words: never the
    runtime's path, a workflow id, an HTTP code or an error's class name."""
    again = "; the next check tries again"
    if exc == "dates_pending":
        return "its roadmap's dates are still being worked out" + again
    if isinstance(exc, safe_yaml.ParseBusy):
        return "Oracle was busy reading other files" + again
    if isinstance(exc, RuntimeUnavailable):
        if exc.gone or exc.status == 404:
            return "SwarmCloud could not find its workflow" + again
        if exc.status is not None and exc.status >= 500:
            return "SwarmCloud had a problem on its side" + again
        if exc.status is not None:
            return "SwarmCloud refused Oracle's request" + again
        return "SwarmCloud did not answer in time" + again
    return "something went wrong while reading it" + again


async def _unchecked(db: AsyncSession, why: dict[uuid.UUID, str]) -> list[TickUnchecked]:
    """run-progress: each run whose pass broke off before it was read, with why. A run
    whose pass ran is checked, whatever it reported (an import that failed, a file
    SwarmCloud refused to send, a decision not posted yet): its error says so."""
    if not why:
        return []
    runs = list(await db.scalars(select(Run).where(Run.id.in_(why))))
    refs = await _refs(db, runs)
    # As the run's page heads it: "Team onboarding · Ground Truth to PRD".
    titles = {r.id: " · ".join(t for t in (refs.title(r), _flow(r).title) if t) for r in runs}
    await db.rollback()
    return [
        TickUnchecked(run_id=rid, title=titles.get(rid, "A run"), reason=w)
        for rid, w in why.items()
    ]


async def _has_waiting(db: AsyncSession, run_id: uuid.UUID) -> bool:
    """Whether a segment of the run waits to be submitted (:func:`_waiting`), read without
    a lock: :func:`submit_queued` locks the run and looks again."""
    segments = await _segments(db, run_id)
    waiting = any(service._waiting(s) for s in segments)
    await db.rollback()
    return waiting


async def tick(db: AsyncSession, principal: Principal | None = None) -> TickOut:
    """Advance every active run of the session's tenant; within :data:`TICK_RUN_SECONDS`
    of runtime calls per run, and never with a run's row lock held across one."""
    stats = _TickStats()
    errors: list[str] = []
    # run-progress: the runs whose pass broke off before they were read, and why.
    unread: dict[uuid.UUID, str] = {}
    # E1: queued derivations of PRD drafts start first, so this pass submits them.
    from oracle.roadmap import draft_items

    errors += await draft_items.start_due(db)
    # Runs with a live workflow are watched whatever their state: a wait may be answered
    # outside Oracle or expire, the workflow may end in SwarmCloud, and one Oracle is
    # cancelling (even for a run that ended) has its cost read until the cancel holds.
    live = Run.knobs["workflow"]["state"].astext == "live"
    # And runs looking for a submission given up on, ended ones too: if it landed, it
    # spends until Oracle finds and cancels it.
    searching = Run.knobs.has_key("searches")
    # And runs owing SwarmCloud an Inbox decision recorded but not posted yet.
    owing = Run.id.in_(
        select(Checkpoint.run_id).where(
            Checkpoint.status.in_(DECIDED), Checkpoint.payload["wait"].has_key("posting")
        )
    )
    ids = list(
        await db.scalars(
            select(Run.id)
            .where(Run.status.in_(("running", "paused_overrun")) | live | searching | owing)
            .order_by(Run.started_at, Run.id)
        )
    )
    await db.rollback()
    loop = asyncio.get_running_loop()
    for run_id in ids:
        # One cap on the runtime calls of this run's whole pass, its submission included.
        deadline = loop.time() + service.TICK_RUN_SECONDS
        stats.pass_id = uuid.uuid4().hex
        began = service._now()
        read = False
        try:
            # Its parses count against the run (oracle.safe_yaml.MAX_PER_OWNER).
            with safe_yaml.parse_owner(str(run_id)):
                owed = await service._owed_decision(db, run_id)
                if owed is not None:
                    # An Inbox decision recorded, its post to SwarmCloud not finished: tried
                    # first. Whether or not SwarmCloud takes it, the run's pass still runs
                    # (its cost, the ceiling, its workflow's end): a post that keeps failing
                    # must not stop Oracle from watching the run.
                    try:
                        await service._complete_decision(db, run_id, owed, deadline, stats)
                    except Unavailable as exc:
                        errors.append(f"run {run_id}: {exception_text(exc)}")
                # Each replay puts back only what its own unfinished passes counted: what an
                # earlier one committed (the searches' pause, say) stays counted.
                await service._replay(
                    db,
                    deadline,
                    lambda run_id=run_id: _tick_searches(db, run_id, stats),
                    reset=_resetter(stats),
                )
                ran = await service._replay(
                    db,
                    deadline,
                    lambda run_id=run_id, deadline=deadline: _tick_one(db, run_id, stats, deadline),
                    reset=_resetter(stats),
                )
                if not ran:
                    if owed is None:
                        continue
                    stats.checked += 1  # counted once: by its pass when that ran
                read = True
                await _stamp_checked(db, run_id, began)
                if (
                    refused := await service.refresh_key(db, run_id, deadline=deadline)
                ) is not None:
                    errors.append(refused)
                if await _has_waiting(db, run_id):
                    await service.submit_queued(db, run_id, deadline=deadline)
        except safe_yaml.ParseBusy as exc:
            # No free worker for its import within the wait: the run stays as it was
            # (retryable), the tick gives up on it and the next tick tries again. The
            # run's row lock and transaction end here, not after the wait.
            await db.rollback()
            errors.append(f"run {run_id}: {exc.code}")
            if not read:
                unread.setdefault(run_id, _unchecked_reason(exc))
        except RuntimeUnavailable as exc:
            await db.rollback()
            errors.append(f"run {run_id}: {exception_text(exc)}")
            if not read:
                unread.setdefault(run_id, _unchecked_reason(exc))
        except Exception as exc:  # one broken run must not stop the others
            if _dates_pending(exc):
                # The run stays as it was and the next tick tries again: never a failed
                # run. Its row lock and transaction end here.
                await db.rollback()
                errors.append(f"run {run_id}: dates_pending")
                if not read:
                    unread.setdefault(run_id, _unchecked_reason("dates_pending"))
                continue
            log.exception("tick failed for run %s", run_id)
            await db.rollback()
            errors.append(f"run {run_id}: {type(exc).__name__}")
            if not read:
                unread.setdefault(run_id, _unchecked_reason(exc))
    errors += stats.errors
    unchecked = await _unchecked(db, unread)
    return TickOut(
        runs_checked=stats.checked,
        segments_finished=stats.finished,
        runs_advanced=stats.advanced,
        runs_paused=stats.paused,
        errors=errors,
        # A run that could not be checked is named, not counted as checked.
        active_runs=len(stats.active - {u.run_id for u in unchecked}),
        unchecked=unchecked,
    )
