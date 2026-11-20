"""Runs: calls to SwarmCloud made outside a run's lock, the pass replayed with their answers."""

import contextvars
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, webhooks
from oracle.runs import service
from oracle.runs.models import Run, RunSegment
from oracle.runs.service import (
    _art,
    _flow,
    _known_sum,
    _set_art,
    _set_knob,
    log,
)
from oracle.runs.submission import _Cancelled
from oracle.runtokens import revoke_run_tokens
from oracle.swarm import RuntimeUnavailable

if TYPE_CHECKING:
    from oracle.members.models import MemberFollowUp


#
# Code that decides under a run's row lock (the tick's pass over a run, the claim of a
# queued segment, an Inbox decision's follow-through) also needs to read or change things
# at SwarmCloud. It never does so with the lock (or the review gate) held: it runs inside
# :func:`_replay`, where a runtime call goes through :func:`_rt`. A call whose result is not
# known yet raises :class:`_NeedCall`; the transaction is rolled back (every lock is
# released), the call is made, and the code runs again from the top, locking and reading
# the run as it is now, with the result of that call (and every earlier one) at hand. So
# whatever the code writes is decided on the run as it is when it writes, never as it was
# when SwarmCloud was asked; a run that changed meanwhile is simply handled as it is. This
# is a crash and a restart at that point, which every pass has to survive anyway, with the
# answers of calls already made kept.
#
# The replayed code is therefore written like the tick's: it starts by reading the run
# afresh, commits only what stays true if it runs again, and keeps in-memory counters
# through ``reset``.


class _NeedCall(BaseException):
    """A runtime call made inside :func:`_replay` with no result yet. A BaseException: the
    ``except Exception`` of the code between must not take it for a failed call."""

    def __init__(self, slot: tuple, call: Any, args: tuple, kwargs: dict[str, Any]) -> None:
        super().__init__(slot[0])
        self.slot, self.call, self.args, self.kwargs = slot, call, args, kwargs


# The calls that go to SwarmCloud and are decided outside the lock (the rest of the
# runtime's surface is local: its notes, whether it reaches Oracle).
_OUTSIDE = frozenset(
    {
        "status",
        "cost",
        "artifacts",
        "read_artifacts",
        "cancel",
        "features",
        "ensure_mcp_server",
        "find_by_label",
        "answer",
        "answer_record",
    }
)
# How many different calls one replayed pass may need before it gives up.
REPLAY_LIMIT = 64


@dataclass
class _Guard:
    cache: dict[tuple, tuple[bool, Any]]
    seen: dict[tuple, int] = field(default_factory=dict)
    armed: bool = True


_GUARD: contextvars.ContextVar[_Guard | None] = contextvars.ContextVar(
    "oracle_runs_guard", default=None
)


class _Guarded:
    """The runtime as :func:`_rt` hands it out inside :func:`_replay`."""

    def __init__(self, inner: Any, guard: _Guard) -> None:
        self._inner, self._guard = inner, guard

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._inner, name)
        if name not in _OUTSIDE:
            return attr
        guard = self._guard

        async def call(*args: Any, **kwargs: Any) -> Any:
            if not guard.armed:
                return await attr(*args, **kwargs)
            key = (name, repr((args, kwargs)))
            n = guard.seen.get(key, 0)
            guard.seen[key] = n + 1
            slot = (*key, n)
            if slot in guard.cache:
                ok, value = guard.cache[slot]
                if ok:
                    return value
                raise value
            raise _NeedCall(slot, attr, args, kwargs)

        return call


def _rt() -> Any:
    """The runtime for code that may run inside :func:`_replay` (else the runtime itself)."""
    runtime = service.get_runtime()
    guard = _GUARD.get()
    return runtime if guard is None else _Guarded(runtime, guard)


def _disarm() -> None:
    """From here the code is not run again (it committed what must not be done twice):
    its runtime calls go straight to the runtime, made with nothing held."""
    guard = _GUARD.get()
    if guard is not None:
        guard.armed = False


async def _replay[T](
    db: AsyncSession,
    deadline: float | None,
    body: Callable[[], Awaitable[T]],
    *,
    reset: Callable[[], None] | None = None,
) -> T:
    """Run ``body`` (which locks and reads what it needs itself) with its runtime calls
    made outside any lock: see the note above. Each call is bounded by ``deadline`` (loop
    time; a call past it fails like a call that timed out), and its failure is what the
    code sees, at the same place. ``reset``: puts back what an unfinished run of ``body``
    counted in memory."""
    cache: dict[tuple, tuple[bool, Any]] = {}
    for _ in range(service.REPLAY_LIMIT):
        token = _GUARD.set(_Guard(cache))
        try:
            return await body()
        except _NeedCall as need:
            wanted = need
        finally:
            _GUARD.reset(token)
        await db.rollback()
        if reset is not None:
            reset()
        try:
            cache[wanted.slot] = (
                True,
                await service._within(wanted.call(*wanted.args, **wanted.kwargs), deadline),
            )
        except Exception as exc:  # noqa: BLE001 - the code sees the call's own failure
            cache[wanted.slot] = (False, exc)
    raise RuntimeUnavailable("this pass needed more calls to SwarmCloud than it may make")


def _cancel_follow_up(
    db: AsyncSession, member_id: uuid.UUID, segment_id: uuid.UUID, workflow_id: str
) -> "MemberFollowUp":
    """Record the cancel of a workflow at the runtime as a follow-up, in the transaction
    that decides it: made right after the commit, retried by the tick if it fails or the
    process dies first (``oracle.members.service.run_follow_ups``)."""
    from oracle.members.models import MemberFollowUp

    row = MemberFollowUp(
        id=uuid.uuid4(),
        member_id=member_id,
        kind="run_cancel",
        target_id=segment_id,
        workflow_id=workflow_id,
    )
    db.add(row)
    return row


async def submit_queued(
    db: AsyncSession, run_id: uuid.UUID, *, deadline: float | None = None
) -> None:
    """Submit the run's waiting segment (:func:`_waiting`), after the request that queued
    it committed: outside the review gate. The tick calls it too, for a segment the
    runtime refused before.

    The segment is claimed under the run's row lock; :func:`_submit_now` commits before
    the submit call (nothing held across it) and reads the run again after it. If the
    run changed meanwhile (cancelled, its approval or the checkpoint decision voided by
    a disable), the workflow SwarmCloud started is cancelled at once (a follow-up
    recorded first, retried from the tick). A submission whose process died mid-call
    keeps its claim until it expires. Before the commit that precedes the submit call, the
    runtime calls it needs (looking up a lost submission, cancelling an earlier workflow,
    the features, the MCP server) are made outside the run's row lock too, by
    :func:`_replay`. ``deadline`` (loop time): bounds each of those calls; the tick's cap
    for a run bounds its submission with it. Commits."""
    await _replay(db, deadline, lambda: _submit_queued(db, run_id))


async def _submit_queued(db: AsyncSession, run_id: uuid.UUID) -> None:
    run, segments = await service._locked(db, run_id)
    segment = next((s for s in segments if service._waiting(s)), None)
    if run is None or run.status != "running" or segment is None or _claimed(segment):
        await db.rollback()
        return
    if service._live(run) is not None:
        # A workflow is still attached (driven, or its cancel not confirmed): the tick
        # follows it and submits what waits only once it is done with.
        await db.rollback()
        return
    claim = uuid.uuid4().hex
    art = _art(segment)
    art["claim"] = {"id": claim, "at": service._now().isoformat()}
    _set_art(segment, art)
    segment_id = segment.id
    orphan = await service._submit_now(db, run, segment, segments, claim=claim)
    if orphan is None:
        await db.commit()
        return
    # The run changed while SwarmCloud started the workflow: nothing runs for it.
    await audit.record(
        db, None, "run.workflow_cancelled", "run", run_id,
        {"workflow_id": orphan, "segment_id": str(segment_id),
         "reason": "the run changed while its segment was submitted"},
    )  # fmt: skip
    fresh = await db.get(Run, run_id)
    member_id = (fresh.created_by if fresh is not None else None) or run_id
    row = _cancel_follow_up(db, member_id, segment_id, orphan)
    await db.commit()
    await cancel_at_runtime(db, [row.id])


# How long a submission under way keeps the tick off its segment: past it, the process
# that claimed it is taken to be gone and the tick submits the segment again.
CLAIM_SECONDS = 300


def _claimed(segment: RunSegment) -> bool:
    """A submission of this segment is under way (claimed less than CLAIM_SECONDS ago)."""
    at = service._parse_at(((segment.artifacts or {}).get("claim") or {}).get("at"))
    return at is not None and (service._now() - at).total_seconds() < CLAIM_SECONDS


# How long a cancel's follow-up, recorded before its call, waits before the tick may make
# it: the request that recorded it is making the call meanwhile.
CANCEL_FOLLOW_UP_GRACE_SECONDS = 120


async def _settle_cancel_follow_ups(
    db: AsyncSession, follow_ups: dict[str, uuid.UUID], done: dict[str, "_Cancelled"]
) -> None:
    """Record the outcome of the cancel calls :func:`cancel` made on their follow-ups, in
    the transaction that records them on the run: from here a cancel not confirmed is the
    run's to retry (``cancel_pending`` or a background search), not the follow-up's."""
    from oracle.members.models import MemberFollowUp

    for workflow_id, follow_up_id in follow_ups.items():
        row = await db.get(MemberFollowUp, follow_up_id, with_for_update=True)
        if row is None or row.status != "pending":
            continue
        out = done.get(workflow_id)
        confirmed = out is not None and (out.error is None or out.gone)
        row.attempts += 1
        row.outcome = "cancelled" if confirmed else "followed_by_run"
        row.last_error = (
            None if confirmed or out is None or out.error is None else service._shown(out.error)
        )
        row.status = "done"
        row.done_at = service._now()
        row.next_attempt_at = None


async def cancel_at_runtime(db: AsyncSession, follow_ups: list[uuid.UUID]) -> None:
    """Make the run_cancel follow-ups a cancel recorded (:func:`_cancel_follow_up`),
    after it committed (outside the review gate). A cancel the runtime does not confirm
    is noted on its segment and retried from the tick. Commits."""
    from oracle.members import service as members_service

    for follow_up_id in follow_ups:
        try:
            await members_service.attempt_follow_up(db, follow_up_id)
        except Exception:  # noqa: BLE001 - the tick retries it
            log.exception("run cancel follow-up %s could not be made", follow_up_id)
            await db.rollback()


def _recompute_spend(run: Run, segments: list[RunSegment]) -> None:
    run.spent_usd = _known_sum(s.cost_usd for s in segments)


async def _finish(
    db: AsyncSession,
    run: Run,
    status: str,
    error: str | None = None,
    *,
    state: str = "ended",
    done: dict[str, "_Cancelled"] | None = None,
) -> None:
    run.status = status
    run.finished_at = service._now()
    if error:
        run.error = error
    _set_knob(run, "post_404", None)
    # Nothing waits in SwarmCloud's queue once the run ended (the Inbox reads running
    # runs' waits only).
    _set_knob(run, "queue_wait", None)
    # A run that ends early stops its workflow; a finished one's ends on its own. A cancel
    # SwarmCloud does not confirm leaves the workflow attached: the tick cancels it again
    # and keeps reading its cost.
    await service._detach(db, run, cancel=status != "succeeded", state=state, done=done)
    _set_knob(run, "spent_at_end", str(run.spent_usd or 0))
    await revoke_run_tokens(db, run.id)
    # I1: every ending, from here only; a code on failure, never the error's text.
    if status in ("succeeded", "failed", "cancelled"):
        await webhooks.capture(
            db,
            f"run.{status}",
            audit.ORACLE,
            run_id=run.id,
            error_kind="run_failed" if status == "failed" else None,
        )
    if status in ("failed", "cancelled") and _flow(run).stores_draft_items:
        from oracle.roadmap import draft_items

        await draft_items.run_ended(db, run, run.error or "Cancelled")


async def _next(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
) -> None:
    later = [s for s in segments if s.seq > segment.seq and s.status != "skipped"]
    wf = service._drivable(run)
    if later and wf is not None and service._plan_entry(wf, later[0].seq) is not None:
        # Already part of the live workflow: it runs once the wait is answered.
        nxt = later[0]
        art = _art(nxt)
        art["attempts"].append(
            {
                "attempt": len(art["attempts"]) + 1,
                "workflow_id": wf["id"],
                "submitted_at": service._now().isoformat(),
                "cost_usd": None,
                "note": None,
                "state": "running",
                "label": wf.get("label"),
                "mode": "workflow",
            }
        )
        _set_art(nxt, art)
        nxt.status = "running"
        nxt.swarm_workflow_id = wf["id"]
        nxt.error = None
        nxt.started_at = nxt.started_at or service._now()
        run.status = "running"
        return
    if later:
        await service._submit(db, run, later[0], segments)
    else:
        await _finish(db, run, "succeeded")
