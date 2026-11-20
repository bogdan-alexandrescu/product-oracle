"""Runs: W5, the run token's writes held while a checkpoint wait is open in SwarmCloud."""

import asyncio
import time
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.runs import service
from oracle.runs.models import Checkpoint, Run
from oracle.runs.service import (
    CHECKPOINT_TITLES,
    _art,
    _checkpoints,
    _segments,
    log,
)
from oracle.swarm import RuntimeUnavailable
from oracle.swarm.runtime import not_reached
from oracle.tenancy import tenant_session

# Console answers that did not count (W5): one Oracle could not count (its answerer),
# one it could not read (the form over its limit or odd, a verdict that is neither
# MERGE nor NOT_YET, a refused read of a step that SUCCEEDED), and one it cannot read
# yet (``unread``: SwarmCloud errors, a 404, a record that lags the step; read again on
# every tick). Each waits for an approver or for the read, and the run's token is
# read-only meanwhile.
_HOLDING = ("confirm", "unreadable", "unread")
# A counted console answer whose follow-up (Redo or Continue) is still to choose: the
# answer counts and Oracle has read it, so the wait no longer holds the token.
_COUNTED = ("redo_or_continue",)


def _holds_token(cp: Checkpoint) -> bool:
    """W5 (owner, 2026-10-19): the run's token is read-only while a checkpoint wait is
    open in SwarmCloud (unanswered, answered and not read yet, unreadable, or answered by
    someone whose answer does not count); writes return once Oracle has read an answer
    that counts. A wait that ended (expired, closed, paused) is no longer open.
    Owner decision 2026-10-20: a decision recorded in the Inbox and not delivered to the
    workflow yet (:func:`_owes`, "Delivering decision") holds it too, until delivered; a
    voided one leaves the checkpoint pending, which holds as any other."""
    if service._owes(cp):
        return True
    if cp.status != "pending":
        return False
    wait = (cp.payload or {}).get("wait") or {}
    needs = (wait.get("console") or {}).get("needs")
    if needs in _HOLDING:
        return True
    return bool(wait.get("workflow_id")) and not wait.get("ended") and needs not in _COUNTED


def console_blocked(cp: Checkpoint) -> bool:
    """A console approval held because the feature set (C6) or the priority order (C8)
    has blocking problems."""
    return bool((((cp.payload or {}).get("wait") or {}).get("console") or {}).get("blocking"))


def _hold_reason(cp: Checkpoint) -> str:
    needs = (((cp.payload or {}).get("wait") or {}).get("console") or {}).get("needs")
    if service._owes(cp):
        why = "has a decision recorded in Oracle that is not delivered to the run yet"
    elif needs == "confirm" and console_blocked(cp):
        what = CHECKPOINT_TITLES.get(cp.kind, cp.kind).lower()
        why = (
            f"was approved in SwarmCloud's console while the {what} has blocking "
            "problems; an Oracle approver confirms it once they are fixed or waived"
        )
    elif needs == "confirm":
        why = (
            "was answered in SwarmCloud's console by someone whose answer does not count "
            "until an Oracle approver confirms it"
        )
    elif needs == "unread":
        why = (
            "was answered in SwarmCloud's console and Oracle has not read the recorded "
            "answer yet (it reads it again each tick)"
        )
    elif needs == "unreadable":
        why = (
            "was answered in SwarmCloud's console and Oracle could not read the recorded "
            "answer, so an Oracle approver decides"
        )
    else:
        why = "waits for a decision in SwarmCloud"
    return f"{cp.kind} {why}"


def _held(why: str) -> str:
    return (
        f"waiting for approval: {why}; until Oracle reads an answer that counts, this run's "
        "token may read Oracle but not write to it"
    )


# What the run's agents are told when their write is held back (W5): a fixed reason,
# never what Oracle recorded of the checkpoint or what SwarmCloud said (that is logged).
HOLD_DECISION = "waiting for a checkpoint decision"
HOLD_UNKNOWN = "status unknown"
# The live read a write waits on: one deadline for all of it (past it, or on an error,
# the token is read-only), and how long a read-only answer is reused (W5, owner
# 2026-10-19: a 'read-only' answer may be cached for up to 5 seconds; 'may write' is
# never cached).
HOLD_READ_SECONDS = 3.0
HOLD_CACHE_SECONDS = 5.0
_hold_clock = time.monotonic
# The read's deadline (tests fire it themselves rather than wait on the runner's clock).
_hold_deadline = asyncio.timeout

# Run, workflow, and each review step no checkpoint stands for yet with the step it
# depends on (None: not known, so it holds).
_Reviews = tuple[tuple[str, str | None], ...]
_HoldKey = tuple[uuid.UUID, str, _Reviews]
_hold_cache: dict[_HoldKey, tuple[float, str]] = {}
_hold_reads: dict[_HoldKey, "asyncio.Task[str | None]"] = {}


@dataclass(frozen=True)
class _HoldPlan:
    """What Oracle's records say of a run token's hold: held (``reason``, and the
    ``detail`` logged for it), or decided by a live read of workflow ``workflow_id``:
    its review steps no checkpoint stands for yet, each with the step it depends on
    (``reviews``)."""

    reason: str | None = None
    detail: str | None = None
    workflow_id: str | None = None
    reviews: _Reviews = ()


def _review_predecessors(entry: dict[str, Any]) -> list[tuple[str, str | None]]:
    """A segment's review steps, each with the step it depends on in Oracle's own plan
    (:func:`workflow.build_plan`): the segment's last work step for the first round, the
    previous round's revise step after it. None when Oracle's record does not say."""
    work = entry.get("work") or []
    before = [work[-1] if work else None, *(entry.get("revises") or [])]
    return [
        (str(r), before[i] if i < len(before) else None)
        for i, r in enumerate(entry.get("reviews") or [])
    ]


async def _hold_plan(db: AsyncSession, run_id: uuid.UUID) -> _HoldPlan:
    checkpoints = await _checkpoints(db, [run_id])
    held = next((c for c in checkpoints if _holds_token(c)), None)
    if held is not None:
        return _HoldPlan(HOLD_DECISION, _hold_reason(held))
    run = await db.get(Run, run_id)
    if run is None:
        return _HoldPlan()
    for s in await _segments(db, run_id):
        lost = _art(s).get("lost")
        if s.status == "pending" and isinstance(lost, dict):
            # Its answer was lost and its token kept alive: it may run, and a wait in it
            # may be open, until the lookup resolves it.
            return _HoldPlan(HOLD_UNKNOWN, f"submission {lost.get('label')} was lost")
    wf = service._drivable(run)
    if wf is None:
        return _HoldPlan()
    opening = (run.knobs or {}).get("opening_wait")
    if isinstance(opening, dict) and opening.get("workflow_id") == wf.get("id"):
        # _advance is opening a checkpoint on this wait (its import commits first).
        return _HoldPlan(HOLD_DECISION, f"{opening.get('kind') or 'a checkpoint'} is opening")
    known = {
        ((c.payload or {}).get("wait") or {}).get("step_id")
        for c in checkpoints
        if ((c.payload or {}).get("wait") or {}).get("workflow_id") == wf.get("id")
    }
    for e in wf.get("segments") or []:
        reviews = e.get("reviews") or []
        for answered in e.get("oracle_answered") or []:
            # Oracle's answer is no person's (_send_back): held until the checkpoint of a
            # later round stands, and then as that checkpoint holds.
            later = reviews[reviews.index(answered) + 1 :] if answered in reviews else []
            if not any(r in known for r in later):
                return _HoldPlan(
                    HOLD_DECISION, f"{e.get('name')}'s refused draft is back with the writer"
                )
    reviews = [
        p
        for e in wf.get("segments") or []
        for p in _review_predecessors(e)
        if p[0] not in (e.get("oracle_answered") or [])
    ]
    unknown = tuple(p for p in reviews if p[0] not in known)
    if not unknown or not wf.get("id"):
        return _HoldPlan()
    return _HoldPlan(workflow_id=wf["id"], reviews=unknown)


async def _read_hold(key: _HoldKey) -> str | None:
    """One live read of a workflow's status: whether it reached a review step no
    checkpoint stands for yet (not :func:`not_reached` given the step it depends on in
    the same read, or not listed).
    Bounded by :data:`HOLD_READ_SECONDS`; a read-only answer
    is kept for :data:`HOLD_CACHE_SECONDS`."""
    run_id, workflow_id, reviews = key
    held: str | None = None
    try:
        async with service._hold_deadline(service.HOLD_READ_SECONDS):
            status = await service.get_runtime().status(workflow_id)
    except (RuntimeUnavailable, TimeoutError) as exc:
        log.warning(
            "run %s: token read-only, status of %s not read: %s",
            run_id,
            workflow_id,
            exc or f"no answer in {service.HOLD_READ_SECONDS:g} s",
        )
        held = HOLD_UNKNOWN
    else:
        for review, after in reviews:
            step = status.step(review)
            before = status.step(after) if after else None
            if step is None or not not_reached(step, before):
                log.info(
                    "run %s: token read-only, step %s of %s is %s (park reason %s, after %s: %s)",
                    run_id,
                    review,
                    workflow_id,
                    step.state if step else "not listed",
                    step.park_reason if step else None,
                    after,
                    before.state if before else "not listed",
                )
                held = HOLD_DECISION
                break
    if held is not None:
        now = service._hold_clock()
        _prune_hold_cache(now)
        _hold_cache[key] = (now, held)
    return held


def _prune_hold_cache(now: float) -> None:
    for k in [k for k, (at, _) in _hold_cache.items() if now - at >= HOLD_CACHE_SECONDS]:
        del _hold_cache[k]


def _cached_hold(key: _HoldKey) -> str | None:
    """A read-only answer from the last :data:`HOLD_CACHE_SECONDS` (expired ones pruned)."""
    now = service._hold_clock()
    _prune_hold_cache(now)
    cached = _hold_cache.get(key)
    return cached[1] if cached is not None else None


async def _live_hold(run_id: uuid.UUID, workflow_id: str, reviews: _Reviews) -> str | None:
    """The live read's answer: a read-only one from the last 5 seconds, else a read.

    W5, shared status checks (owner, 2026-10-20): a request that starts a read uses its
    own answer, and requests arriving while it is in flight join it, but share only a
    read-only answer. On 'may write' each joiner makes a read of its own, never joining
    one started before it arrived (a wait may have opened since that read was sent)."""
    key = (run_id, workflow_id, reviews)
    cached = _cached_hold(key)
    if cached is not None:
        return cached
    loop = asyncio.get_running_loop()
    task = _hold_reads.get(key)
    if task is not None and task.get_loop() is loop:
        # Shielded: one request going away does not cancel the read the others wait on.
        shared = await asyncio.shield(task)
        if shared is not None:
            return shared
        cached = _cached_hold(key)
        if cached is not None:
            return cached
        # 'May write' was read before this request arrived: read for itself.
        return await _read_hold(key)
    task = loop.create_task(_read_hold(key))
    _hold_reads[key] = task

    def done(t: "asyncio.Task[str | None]") -> None:
        if _hold_reads.get(key) is t:
            del _hold_reads[key]

    task.add_done_callback(done)
    return await asyncio.shield(task)


async def token_hold(db: AsyncSession, run_id: uuid.UUID, *, live: bool = True) -> str | None:
    """Why the run's token is read-only now (W5), or None: its agents may read Oracle,
    and their writes (drafts, proposals) are refused while any checkpoint wait of the
    run is open in SwarmCloud, until Oracle has read an answer that counts, while a
    decision recorded in Oracle is not delivered to the workflow yet, and while a lost
    submission (whose token is alive) is unresolved.

    From the moment the workflow reaches the wait, not from Oracle's next look at it: a
    review step of the live workflow that no checkpoint stands for yet is read from
    SwarmCloud, and reached (once the step it depends on succeeded, whatever its own row
    says; in any state but parked on that unfinished step; not listed, or not read) it
    holds.
    ``live`` False: from what Oracle recorded only (the run's page). A write checks it
    with :func:`run_token_hold`, which releases the database before SwarmCloud is read."""
    plan = await _hold_plan(db, run_id)
    if plan.reason is not None:
        return _held(plan.reason)
    if not live or plan.workflow_id is None:
        return None
    why = await service._live_hold(run_id, plan.workflow_id, plan.reviews)
    return _held(why) if why else None


async def run_token_hold(tenant_id: uuid.UUID, run_id: uuid.UUID) -> str | None:
    """:func:`token_hold` for a write a run token is about to make: Oracle's records are
    read in a session of their own, closed before SwarmCloud is called."""
    async with tenant_session(tenant_id) as s:
        plan = await _hold_plan(s, run_id)
    if plan.reason is not None:
        log.info("run %s: token read-only: %s", run_id, plan.detail)
        return _held(plan.reason)
    if plan.workflow_id is None:
        return None
    why = await service._live_hold(run_id, plan.workflow_id, plan.reviews)
    return _held(why) if why else None
