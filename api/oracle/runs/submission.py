"""Runs: a segment submitted to SwarmCloud, its workflow recorded, cancelled or detached."""

import asyncio
import copy
import uuid
from collections.abc import Awaitable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.engineering import dates as eng_dates
from oracle.errors import exception_text
from oracle.runs import flows, service, waits, workflow
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.schemas import QueueWait
from oracle.runs.service import (
    Unavailable,
    _art,
    _creator,
    _disarm,
    _flow,
    _knobs,
    _next,
    _prompt_context,
    _rt,
    _segments,
    _set_art,
    _set_knob,
    _target_kind,
    log,
)
from oracle.runtokens import mint_run_token, revoke_run_tokens
from oracle.swarm import (
    AgentRuntime,
    McpAccess,
    RuntimeUnavailable,
    StepSpec,
    WorkflowSpec,
    WorkflowStatus,
    redact,
)
from oracle.swarm.runtime import WORKING
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import current_tenant

# A segment a request queued for the runtime (a start, an approval, a resume, a checkpoint
# decision): the request commits under the review gate, then submits it outside the gate
# (:func:`submit_queued`). If that never happens, the tick submits it.
QUEUED = "waiting to be submitted to the agent runtime"
# How long one tick pass on one run may spend on its status and artifact reads: past it
# the pass gives up and the next tick tries again.
TICK_RUN_SECONDS = 60.0


@dataclass
class _Mode:
    """How a submission uses the runtime: the run token attached for the agents, and the
    rest of the run as one workflow with its checkpoints as waits for a person."""

    attach: bool
    waits: bool
    notes: list[str]


# Refusals at submit that a submission survives by dropping the feature they concern.
_DROP_WAITS = ("await_input_disabled",)
_DROP_MCP = (
    "mcp_unavailable",
    "mcp_server_profile_refused",
    "mcp_credential_missing",
    "mcp_credential_unexpected",
    "mcp_credential_shape",
)


async def _mode(runtime: AgentRuntime, url: str) -> _Mode:
    """Which v2 features this submission uses: the runtime's (cached) reading, and
    Oracle's MCP server registered once before the first credential is sent."""
    feats = await runtime.features()
    notes: list[str] = []
    registered = True
    # The run token is sent only once caller MCP is confirmed on. Reads are served while
    # the switch is off, so "unknown" is the usual first reading: registering confirms it
    # (SwarmCloud accepts the write only while caller MCP is on).
    if feats.mcp != "off":
        try:
            await runtime.ensure_mcp_server(url)
        except RuntimeUnavailable as exc:
            # Not registered at this URL (a failed PATCH may leave an old one): an earlier
            # "on" does not make it safe to send the token.
            registered = False
            if exc.code == "mcp_unavailable":
                notes.append(workflow.advice(exc.code, exception_text(exc)))
            else:
                notes.append(
                    "Oracle's MCP server could not be registered in SwarmCloud "
                    f"({exception_text(exc)}): "
                    "agents run without it. An owner can retry with POST "
                    "/v1/runtime/mcp-server."
                )
        else:
            feats = await runtime.features()
    attach = feats.mcp == "on" and registered
    if not attach and not notes and feats.reasons.get("mcp"):
        notes.append(f"Agents run without Oracle's MCP server: {feats.reasons['mcp']}.")
    waits = attach and feats.await_input != "off" and feats.service_answer != "off"
    if not waits:
        why = None
        if feats.await_input == "off":
            why = feats.reasons.get("await_input")
        elif feats.service_answer == "off":
            why = feats.reasons.get("service_answer")
        elif feats.reasons and not attach:
            why = "a run is one workflow only while agents can read Oracle's MCP server"
        if why:
            notes.append(f"Checkpoints wait in Oracle's Inbox, one workflow per segment: {why}.")
        if attach:
            notes.append(workflow.SEGMENT_MODE_WITH_MCP)
    return _Mode(attach, waits, notes)


def _degrade(mode: _Mode, exc: RuntimeUnavailable) -> _Mode | None:
    """The mode to submit again with after a refusal, or None when none helps."""
    if exc.code in _DROP_WAITS and mode.waits:
        return _Mode(
            mode.attach, False, [*mode.notes, workflow.advice(exc.code, exception_text(exc))]
        )
    if exc.code in _DROP_MCP and mode.attach:
        return _Mode(False, False, [*mode.notes, workflow.advice(exc.code, exception_text(exc))])
    return None


def _note(segment: RunSegment, note: str) -> None:
    art = _art(segment)
    _note_art(art, note)
    _set_art(segment, art)


def _note_art(art: dict[str, Any], note: str) -> None:
    if note not in art["notes"]:
        art["notes"].append(note)


def _live(run: Run) -> dict[str, Any] | None:
    """The run's workflow (adapter v2) that is still attached: Oracle drives it, or is
    cancelling it (``cancel_pending``) and still reads its cost."""
    wf = (run.knobs or {}).get("workflow")
    # A copy: the column is not mutation-tracked, so changes go back with _set_knob.
    return copy.deepcopy(wf) if isinstance(wf, dict) and wf.get("state") == "live" else None


def _drivable(run: Run) -> dict[str, Any] | None:
    """The live workflow, unless Oracle is cancelling it: nothing more runs in it."""
    wf = _live(run)
    return wf if wf is not None and not wf.get("cancel_pending") else None


def _cancel_pending(run: Run) -> bool:
    wf = _live(run)
    return wf is not None and bool(wf.get("cancel_pending"))


def _unconfirmed(what: str) -> "Unavailable":
    """The Inbox decision path when a cancel is not confirmed: nothing proceeds."""
    return Unavailable(
        f"SwarmCloud did not confirm cancelling the run's workflow (or Oracle could not read "
        f"its last cost), so Oracle did not {what} yet: the decision is recorded and Oracle "
        "goes on with it on its next tick, there is no need to decide again"
    )


def _shown(value: Any) -> str | None:
    """An upstream value as Oracle stores it: text, redacted, at most 200 characters."""
    if value in (None, ""):
        return None
    text = exception_text(value) if isinstance(value, BaseException) else str(value)
    return redact(text)[:200]


def _cause(exc: BaseException) -> str | None:
    """Why a call to SwarmCloud did not finish, in a few words for the run page and the
    Inbox: "SwarmCloud HTTP 503 unavailable" when SwarmCloud answered, else what failed
    ("cannot reach SwarmCloud ...", a timeout, the replay limit). Stored like
    :func:`_shown`."""
    cause = exc.cause if isinstance(exc, Unavailable) and exc.cause is not None else exc
    if isinstance(cause, RuntimeUnavailable) and cause.status is not None:
        code = f" {cause.code}" if cause.code else ""
        return _shown(f"SwarmCloud HTTP {cause.status}{code}")
    held = exc.held if isinstance(exc, Unavailable) else None
    if held is not None and cause is exc:
        # A cancel the decision needs, not confirmed (_unconfirmed): its own marker's why.
        why = (held.get("cancel_pending") or {}).get("error")
        return _shown(f"cancelling the run's workflow is not confirmed: {why or 'no answer'}")
    return _shown(cause)


def _clip(text: str, limit: int = 200) -> str:
    """For a note or a log line only: what goes to the agents is never clipped."""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _set_wait(cp: Checkpoint, wait: dict[str, Any]) -> None:
    """The checkpoint's wait, as a copy: the column is not mutation-tracked, so a dict
    changed after an autoflush must not be the one already flushed."""
    cp.payload = {**copy.deepcopy(cp.payload or {}), "wait": copy.deepcopy(wait)}


def _parse_at(value: Any) -> datetime | None:
    try:
        at = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return at if at.tzinfo is not None else at.replace(tzinfo=UTC)


# A lost submission is looked up on every tick; past either cap without an answer either
# way (SwarmCloud's listing neither shows it nor reaches a task older than it), the run
# shows in the Inbox with Retry and Cancel.
LOST_LOOKUP_SECONDS = 30 * 60
LOST_LOOKUP_TRIES = 30
_STUCK = (
    "Oracle cannot tell whether SwarmCloud created it: in the Inbox, Retry submits the "
    "segment again (if the lost one landed, it may run too, without Oracle's data, until "
    "Oracle finds it, cancels it and counts its cost) or Cancel ends the run"
)
# A 404 that is not SwarmCloud's not_found envelope (a bare one, or another reason)
# proves nothing and is tried again; past this many on a cancel or an answer post, the
# run shows in the Inbox with Cancel.
NOT_FOUND_TRIES = 5
# A submission given up on (Retry, or Cancel past the lookup cap) is looked for in the
# background until found or ruled out, at most this long after it was sent when its
# credential's end is not recorded (a credential never outlives 86400 s).
SEARCH_SECONDS = 86400
# A searched workflow known by its id whose status does not read past its search's end
# (or past NOT_FOUND_TRIES bare 404s) has an unknown cost: it shows in the Inbox (Retry
# lookup) and is read again now and then for this much longer, then dropped (noted).
COST_UNKNOWN_SECONDS = 3 * 86400


# How often a lost submission past the lookup cap is looked up again (it waits in the
# Inbox meanwhile).
STUCK_LOOKUP_SECONDS = 10 * 60


def _resting(run: Run, lost: dict[str, Any]) -> bool:
    if not (run.knobs or {}).get("stuck_lookup"):
        return False
    looked = _parse_at(lost.get("looked_at"))
    return looked is not None and (service._now() - looked).total_seconds() < STUCK_LOOKUP_SECONDS


def _lookup_exhausted(lost: dict[str, Any]) -> bool:
    """Whether the search for a lost submission passed its attempt or age cap."""
    if int(lost.get("lookups") or 0) >= service.LOST_LOOKUP_TRIES:
        return True
    since = _parse_at(lost.get("submitted_at"))
    return since is not None and (service._now() - since).total_seconds() >= LOST_LOOKUP_SECONDS


def _plan_entry(wf: dict[str, Any], seq: int) -> dict[str, Any] | None:
    return next((e for e in wf.get("segments") or [] if e.get("seq") == seq), None)


def _record_agents(
    segment: RunSegment, workflow_id: str, status: WorkflowStatus, steps: set[str] | None = None
) -> None:
    """#258: the running segment's working agents as this tick read them (``steps``: the
    segment's own steps in a workflow that runs several; None: every step), and when."""
    agents = [
        {
            "role": st.role,
            "state": st.state.lower(),
            "started_at": st.started_at.isoformat() if st.started_at else None,
            "heartbeat_at": st.heartbeat_at.isoformat() if st.heartbeat_at else None,
            "cost_usd": float(st.cost_usd) if st.cost_usd is not None else None,
            "event_at": st.event_at.isoformat() if st.event_at else None,
        }
        for st in status.steps
        if st.state in WORKING and (steps is None or st.step_id in steps)
    ]
    art = _art(segment)
    checked = service._now().isoformat()
    art["progress"] = {"workflow_id": workflow_id, "checked_at": checked, "agents": agents}
    _set_art(segment, art)


def _record_running(wf: dict[str, Any], status: WorkflowStatus, segments: list[RunSegment]) -> None:
    """#258: the agents of the run's running segment in the workflow just read, its own
    steps only."""
    current = next((s for s in segments if s.status == "running"), None)
    if current is None or current.swarm_workflow_id != wf["id"]:
        return
    entry = _plan_entry(wf, current.seq)
    own = {*(entry.get("work") or []), *(entry.get("revises") or [])} if entry else None
    _record_agents(current, wf["id"], status, own)


def _record_workflow_wait(
    run: Run, wf: dict[str, Any], status: WorkflowStatus, segments: list[RunSegment]
) -> None:
    """:func:`_record_wait` for the running segment of the live workflow just read."""
    current = next((s for s in segments if s.status == "running"), None)
    if current is None or current.swarm_workflow_id != wf["id"]:
        return
    entry = _plan_entry(wf, current.seq)
    own = {*(entry.get("work") or []), *(entry.get("revises") or [])} if entry else None
    _record_wait(run, current, wf["id"], wf.get("submitted_at"), status, own)


def _record_wait(
    run: Run,
    segment: RunSegment,
    workflow_id: str,
    submitted_at: Any,
    status: WorkflowStatus,
    own: set[str] | None = None,
) -> None:
    """Why SwarmCloud holds the running segment's step, as this read saw it, in the run's
    ``queue_wait`` knob (oracle.runs.waits): whether any agent of the workflow started,
    the steps seen started, since when each step waits to start, and the first of the
    segment's own steps (``own``; None: every step) parked for a reason shown in words.
    A moment is kept while the step waits the same way; on the workflow's first read it
    is its submission (it waited from there). Nothing is kept for a run that ended."""
    if run.status != "running":
        return
    prev = (run.knobs or {}).get("queue_wait") or {}
    first = prev.get("workflow_id") != workflow_id
    if first:
        prev = {}
    now = service._now().isoformat()
    since = (_parse_at(submitted_at) or service._now()).isoformat() if first else now
    started_steps = set(prev.get("started_steps") or [])
    waiting = dict(prev.get("waiting") or {})
    held = None
    for st in status.steps:
        if waits.began(st):
            started_steps.add(st.step_id)
            waiting.pop(st.step_id, None)
            continue
        if not waits.waits(st):
            continue
        waiting.setdefault(st.step_id, since)
        if (
            held is None
            and (own is None or st.step_id in own)
            and st.state == "PARKED"
            and waits.words(st.park_reason)
        ):
            was = prev.get("held") or {}
            kept = was.get("step_id") == st.step_id and was.get("code") == st.park_reason
            held = {
                "step_id": st.step_id,
                "code": st.park_reason,
                "since": was["since"] if kept else since,
            }
    _set_knob(
        run,
        "queue_wait",
        {
            "workflow_id": workflow_id,
            "seq": segment.seq,
            "submitted_at": submitted_at,
            "checked_at": now,
            "started": bool(prev.get("started")) or bool(started_steps),
            "started_steps": sorted(started_steps),
            "waiting": waiting,
            "held": held,
        },
    )


def _queue_wait(run: Run) -> dict[str, Any] | None:
    """The ``queue_wait`` knob while it is the running run's current workflow's."""
    qw = (run.knobs or {}).get("queue_wait")
    if run.status != "running" or not isinstance(qw, dict):
        return None
    wf = _live(run)
    if wf is not None and wf.get("id") != qw.get("workflow_id"):
        return None
    return qw


def _queue_wait_out(run: Run, seq: int | None = None) -> QueueWait | None:
    """What the Runs row (and with ``seq``, that segment) shows of a held step."""
    qw = _queue_wait(run)
    held = (qw or {}).get("held")
    if not held or (seq is not None and qw.get("seq") != seq):  # type: ignore[union-attr]
        return None
    text = waits.words(held.get("code"))
    since = _parse_at(held.get("since"))
    if text is None or since is None:
        return None
    return QueueWait(code=held["code"], text=text, since=since)


def _not_started(run: Run, zone: str) -> str | None:
    """The Inbox's words for a run whose current workflow started no agent
    :data:`waits.NOT_STARTED_SECONDS` after its submission (Cancel, Open)."""
    qw = _queue_wait(run)
    if qw is None or qw.get("started"):
        return None
    submitted = _parse_at(qw.get("submitted_at"))
    if submitted is None:
        return None
    age = (service._now() - submitted).total_seconds()
    if age < waits.NOT_STARTED_SECONDS:
        return None
    said = (
        f"SwarmCloud has started no agent of this run {waits.minutes(age)} after it was submitted."
    )
    shown = _queue_wait_out(run)
    if shown is not None:
        why = f"{shown.text}, since {company_time.in_words(shown.since, zone)}."
    else:
        moments = [m for m in map(_parse_at, (qw.get("waiting") or {}).values()) if m]
        since = min(moments, default=submitted)
        why = f"Its first step is queued there since {company_time.in_words(since, zone)}."
    return f"{said} {why} It starts on its own once SwarmCloud lets it; Cancel ends the run."


@dataclass
class _Cancelled:
    """What SwarmCloud said to cancelling a workflow, then to reading it: the network half
    of a cancel, made without the run's row lock (:func:`_cancel_call`), and applied to
    the run under it (:func:`_apply_cancel`)."""

    # The cancel was not confirmed (None: confirmed).
    error: RuntimeUnavailable | None = None
    # SwarmCloud does not know the workflow (its enveloped 404): nothing is left to cancel.
    gone: bool = False
    # Not confirmed, but the workflow has ended anyway.
    ended: bool = False
    # The workflow as read after the cancel (its last cost), and why it was not read.
    final: WorkflowStatus | None = None
    unread: RuntimeUnavailable | None = None
    # The cancel was confirmed, then SwarmCloud no longer knew the workflow (its
    # enveloped 404): its cost is read once more, then it is taken as ended.
    forgotten: bool = False


def _not_found(exc: RuntimeUnavailable | None) -> bool:
    """A 404 that is not SwarmCloud's not_found envelope: it proves nothing."""
    return exc is not None and exc.status == 404 and not exc.gone


async def _cancel_call(wf: dict[str, Any]) -> _Cancelled:
    """Cancel workflow ``wf`` and read it after (its last cost, or that it ended): calls
    only, nothing written, so the caller may hold no lock."""
    runtime = _rt()
    out = _Cancelled()
    if not wf.get("id"):
        # A lost submission not found yet: the tick looks it up, then cancels it.
        out.error = RuntimeUnavailable(f"submission {wf.get('lookup')} not looked up yet")
        return out
    try:
        await runtime.cancel(wf["id"])
    except RuntimeUnavailable as exc:
        if exc.gone:
            out.gone = True
            return out
        out.error = exc
    try:
        out.final = await runtime.status(wf["id"])
    except RuntimeUnavailable as exc:
        if exc.gone:
            # Not cancelled and unknown: given up. Cancelled: nothing more to read, its
            # cost is what Oracle last read.
            out.gone = out.error is not None
            out.forgotten = out.error is None
        else:
            out.unread = exc
        return out
    out.ended = out.error is not None and out.final.terminal
    return out


async def _apply_cancel(
    db: AsyncSession, run: Run, wf: dict[str, Any], out: _Cancelled, state: str
) -> bool:
    """Record a cancel (:func:`_cancel_call`) on the run: True when the workflow is done
    with (cancelled, ended, or unknown to SwarmCloud), else it stays attached with a
    ``cancel_pending`` marker for the tick. A 404 that proves nothing is counted on the
    marker: past :data:`NOT_FOUND_TRIES` the run shows in the Inbox with Cancel."""
    pending = wf.get("cancel_pending") or {}
    if out.gone:
        await _give_up(db, run, wf, state)
        return True
    if out.final is not None and wf.get("id"):
        service._take_cost(run, wf, out.final, await _segments(db, run.id))
    now = service._now().isoformat()
    if out.error is not None and not out.ended:
        log.warning("run %s: cancel of %s not confirmed: %s", run.id, wf.get("id"), out.error)
        marker: dict[str, Any] = {
            "state": state,
            "since": pending.get("since") or now,
            "tries": int(pending.get("tries") or 0) + 1,
            "tried_at": now,
            "error": _shown(out.error),
        }
        _count_not_found(marker, pending, _not_found(out.error) or _not_found(out.unread))
        _set_knob(run, "workflow", {**wf, "cancel_pending": marker})
        # Nothing Oracle drives runs in it any more: its agents lose Oracle's data now,
        # not when SwarmCloud confirms.
        await revoke_run_tokens(db, run.id)
        return False
    if out.unread is not None:
        # Cancelled, its last cost unread: attached for one more read (the tick's), so
        # that nothing is submitted after it before its spend is counted.
        log.warning("run %s: final cost of %s not read: %s", run.id, wf.get("id"), out.unread)
        marker = {
            "state": state,
            "since": pending.get("since") or now,
            "tries": int(pending.get("tries") or 0),
            "tried_at": now,
            "confirmed": True,
            "error": "its last cost was not read",
        }
        _set_knob(run, "workflow", {**wf, "cancel_pending": marker})
        await revoke_run_tokens(db, run.id)
        return False
    if out.error is None and out.final is not None and not out.final.terminal:
        _read_on(run, wf, costed=True)
    elif out.forgotten and wf.get("id"):
        _read_once_more(run, wf)
    await _end_workflow(db, run, wf, state)
    return True


def _read_on(run: Run, wf: dict[str, Any], *, costed: bool = False) -> None:
    """A workflow whose cancel SwarmCloud confirmed and that has not ended yet (winding
    down), or whose last cost was not read: detached, and read on ``searches`` until its
    status reads terminal, so that what it spends meanwhile is counted on the run.
    ``costed``: its cost was read after the cancel."""
    service._search_for(
        run,
        label=wf.get("label") or wf["id"],
        seq=wf.get("start_seq"),
        submitted_at=wf.get("submitted_at"),
        until=service._credential_end(wf),
        why="cancel",
        workflow_id=wf["id"],
        cancelled=True,
        costed=costed,
    )


def _read_once_more(run: Run, wf: dict[str, Any]) -> None:
    """A workflow SwarmCloud no longer knows (its enveloped 404) right after confirming
    its cancel: its cost is read once more (``searches``, the next tick) before it is
    taken as ended, so what it spent since Oracle's last read is counted. A second 404
    ends it; a read that fails follows the cost-unknown rules (:func:`_found_apply`)."""
    _read_on(run, wf)
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    for e in entries:
        if e.get("id") == wf["id"]:
            e["gone_reads"] = 1
            e["error"] = "SwarmCloud did not know it right after confirming its cancel"
    _set_knob(run, "searches", entries)


def _count_not_found(marker: dict[str, Any], pending: dict[str, Any], hit: bool) -> None:
    count = int(pending.get("not_found") or 0) + (1 if hit else 0)
    if count:
        marker["not_found"] = count
    if count >= NOT_FOUND_TRIES:
        marker["stuck"] = True


async def _detach(
    db: AsyncSession,
    run: Run,
    *,
    cancel: bool,  # noqa: F811
    state: str,
    done: dict[str, _Cancelled] | None = None,
) -> bool:
    """Stop driving the run's live workflow (cancelling it when asked) and revoke its
    run token: what comes next is a new workflow with a fresh token, or the end.

    Returns False when SwarmCloud did not confirm the cancel (and the workflow has not
    ended): it may still run, so it stays attached with a ``cancel_pending`` marker. Its
    cost is still read into the run's spend, the tick cancels it again, and nothing is
    submitted after it until the cancel is confirmed: no segment runs in two workflows.
    A workflow already being cancelled stays so; only ``cancel`` tries again. ``done``:
    cancels already made (outside the run's row lock), by workflow id."""
    wf = _live(run)
    if wf is None:
        return True
    if wf.get("cancel_pending") and not cancel:
        return False
    if cancel:
        out = (done or {}).get(wf.get("id") or "")
        if out is None:
            out = await _cancel_call(wf)
        return await _apply_cancel(db, run, wf, out, state)
    await _end_workflow(db, run, wf, state)
    return True


async def _give_up(db: AsyncSession, run: Run, wf: dict[str, Any], state: str) -> None:
    """SwarmCloud does not know the workflow (404): nothing is left to cancel."""
    gone = (
        f"SwarmCloud does not know workflow {wf.get('id')} (HTTP 404): Oracle stopped "
        "cancelling it; its cost is what Oracle last read."
    )
    log.warning("run %s: %s", run.id, gone)
    segments = await _segments(db, run.id)
    target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if target is not None or segments:
        _note(target or segments[0], gone)
    await _end_workflow(db, run, wf, state, gone=gone)


async def _end_workflow(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    state: str,
    *,
    gone: str | None = None,
    stopped: bool = False,
) -> None:
    """Detach the run's workflow: Oracle no longer drives or cancels it. ``stopped``: an
    approver stopped cancelling it, and its cost is still read (``searches``)."""
    rest = {k: v for k, v in wf.items() if k != "cancel_pending"}
    if gone:
        rest["gone"] = gone
    if stopped:
        rest["stopped"] = True
    _set_knob(run, "workflow", {**rest, "state": state, "ended_at": service._now().isoformat()})
    await revoke_run_tokens(db, run.id)


def _pending(
    segment: RunSegment, art: dict[str, Any], change_request: str | None, error: str
) -> None:
    """Left pending: the next tick submits it again."""
    art.pop("claim", None)
    segment.status = "pending"
    segment.error = error
    if change_request:
        art["pending_note"] = change_request
    _set_art(segment, art)


async def _submit_now(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    change_request: str | None = None,
    *,
    claim: str | None = None,
) -> str | None:
    """Mint the run token and submit the segment's workflow (the caller commits).

    With ``claim`` (:func:`submit_queued`: the segment carries that claim) the
    transaction commits right before the submit call, so neither the run's row lock nor
    the new token's key lock is held across it, and the run is locked and read again
    after it. If the run changed meanwhile (cancelled, a disable voided the decision or
    the approval), nothing is recorded and the id of the workflow SwarmCloud started is
    returned, for the caller to cancel; otherwise None.

    With caller MCP on, the token goes to the agents through the workflow's credential
    map; with await-input on too, the workflow covers the rest of the run and its
    checkpoints wait for a person in SwarmCloud (oracle.runs.workflow). A refusal that
    names a switched-off feature submits again without it; a lost answer is looked up by
    the submission's label before anything is submitted again."""
    runtime = _rt()
    settings = get_runtime_settings()
    flow, knobs = _flow(run), _knobs(run)
    sdef = flow.segment(segment.name)
    art = _art(segment)
    # Submissions given up on (Retry from the Inbox) keep their numbers: a new key each.
    attempt = len(art["attempts"]) + len(art.get("abandoned") or []) + 1
    # A retry after the runtime refused a re-run keeps the reviewer's note; it stays
    # recorded until a submission succeeds (:func:`_accepted`).
    change_request = change_request or art.get("pending_note")
    # What the agents get: the structured review of a send-back (D4), else the note.
    agents_request = art.get("pending_review") or change_request
    if segment.estimate_usd is None:
        segment.estimate_usd = flows.segment_estimate(sdef, knobs)
    tag = workflow.label(run.id, segment.name, attempt)

    async def still_ours() -> bool:
        fresh, _ = await _locked(db, run.id)
        return (
            fresh is not None
            and fresh.status == "running"
            and segment.status == "pending"
            and ((segment.artifacts or {}).get("claim") or {}).get("id") == claim
        )

    # SwarmCloud has no idempotency keys: a submission whose answer was lost may exist.
    lost = art.get("lost")
    if isinstance(lost, dict) and lost.get("label") == tag and _resting(run, lost):
        return  # past the lookup cap, in the Inbox: looked up again now and then
    lost = art.pop("lost", None)
    if isinstance(lost, dict) and lost.get("label") == tag:
        lost["looked_at"] = service._now().isoformat()
        try:
            found = await runtime.find_by_label(tag, since=_parse_at(lost.get("submitted_at")))
        except RuntimeUnavailable as exc:
            lost["lookups"] = int(lost.get("lookups") or 0) + 1
            art["lost"] = lost
            error = f"looking up submission {tag}: {exception_text(exc)}"
            if _lookup_exhausted(lost):
                # Never resolved either way: an owner or the run's creator decides.
                error += f". {_STUCK}"
                _set_knob(
                    run,
                    "stuck_lookup",
                    {"seq": segment.seq, "label": tag, "since": lost.get("submitted_at")},
                )
            _pending(segment, art, change_request, error)
            return
        _set_knob(run, "stuck_lookup", None)
        if found:
            _accepted(run, segment, art, found, lost, change_request, runtime)
            return

    # One submission at a time: an earlier workflow and its token end before a new one,
    # and nothing is submitted while SwarmCloud has not confirmed its cancel.
    earlier = _live(run)
    if not await _detach(db, run, cancel=True, state="replaced"):
        _pending(
            segment,
            art,
            change_request,
            f"Waiting for SwarmCloud to confirm that workflow {earlier['id'] if earlier else ''} "
            "is cancelled: no segment runs in two workflows, so this one is submitted once it "
            "is (Oracle tries again on every tick).",
        )
        return
    # The spend, the cancelled workflow's last cost included, is checked before every
    # submission: nothing new starts over the ceiling.
    if (ceiling := service._overrun(run)) is not None:
        _pending(
            segment,
            art,
            change_request,
            f"Not submitted: the run spent ${run.spent_usd}, over its ${ceiling} ceiling, so "
            "it paused; resuming submits this segment.",
        )
        await service._pause_overrun(db, run, ceiling)
        return
    await revoke_run_tokens(db, run.id)
    url = settings.public_url.rstrip("/") + "/mcp"
    mode = await _mode(runtime, url)
    kind = await _target_kind(db, run)
    registered_again = False
    while True:
        covered = _workflow_segments(flow, segment, segments) if mode.waits else [segment]
        planned: list[tuple[int, str, list[str]]] = []
        contexts: list[tuple[int, flows.SegmentDef, flows.PromptContext]] = []
        for s in covered:
            d = flow.segment(s.name)
            own = s.seq == segment.seq
            ctx = await _prompt_context(
                db,
                run,
                s,
                segments,
                attempt if own else 1,
                agents_request if own else None,
                runtime,
                attached=mode.attach,
                planned=list(planned),
            )
            contexts.append((s.seq, d, ctx))
            planned.append((s.seq, d.title, list(d.outputs_for(kind))))
        plan = None
        if mode.waits:
            plan = workflow.build_plan(
                flow, contexts, knobs, settings, settings.swarmcloud_profile, run_id=str(run.id)
            )
            steps = tuple(plan.steps)
            scopes = workflow.scopes_for([d for _, d, _ in contexts])
            outputs = contexts[-1][1].outputs_for(kind)
        else:
            steps = tuple(
                StepSpec(
                    key=key,
                    role=role,
                    profile=settings.swarmcloud_profile,
                    prompt=prompt,
                    depends_on=deps,
                    input_from=inputs,
                )
                for key, role, prompt, deps, inputs in flows.build_steps(
                    flow, sdef, knobs, contexts[0][2]
                )
            )
            scopes = sdef.scopes
            outputs = sdef.outputs_for(kind)
        if (run.knobs or {}).get("triage_automatic"):
            # Oracle's daily request triage acts as a member and reads no one's sources.
            scopes = tuple(sc for sc in scopes if sc != "read:sources")
        if mode.attach:
            agents = sum(1 for s in steps if not s.waits)
            ttl = workflow.credential_seconds(agents, len(steps) - agents, settings)
        else:
            ttl = settings.run_token_ttl_seconds
        await revoke_run_tokens(db, run.id)
        token = await mint_run_token(db, run.id, scopes, ttl)
        submitted_at = service._now()
        info: dict[str, Any] = {
            "label": tag,
            "attempt": attempt,
            "mode": "workflow" if mode.waits else "segment",
            "attach": mode.attach,
            "notes": mode.notes,
            "submitted_at": submitted_at.isoformat(),
            "credential_seconds": ttl if mode.attach else None,
            "expires_at": workflow.expires_at(submitted_at, ttl).isoformat(),
            "segments": plan.segments if plan else None,
            # The wait steps, as the lifetime was sized: a renewal sizes the rest the same.
            "waits": [s.key for s in steps if s.waits],
            "start_seq": segment.seq,
        }
        spec = WorkflowSpec(
            name=f"oracle-{run.flow}-{segment.name}",
            steps=steps,
            outputs=outputs,
            mcp=McpAccess(
                url=url,
                token=token,
                scopes=scopes,
                expires_in=ttl if mode.attach else 0,
                attach=mode.attach,
            ),
            budget_usd=knobs.budget_usd,
            labels={
                "run_id": str(run.id),
                "segment": segment.name,
                "attempt": str(attempt),
                "estimate_usd": str(segment.estimate_usd),
            },
            label=tag,
        )
        if claim is not None:
            # Nothing held across the call: a cancel or a disable never waits on it. From
            # here the submission is not run again (:func:`_replay`).
            await db.commit()
            _disarm()
        try:
            try:
                workflow_id = await runtime.submit(spec)
            except RuntimeUnavailable:
                raise
            except Exception as unexpected:
                if claim is None:
                    raise
                # After a commit: recorded as a refusal, never a 500.
                log.exception("run %s: submission failed", run.id)
                raise RuntimeUnavailable(
                    f"the submission failed ({type(unexpected).__name__})"
                ) from None
        except RuntimeUnavailable as exc:
            if claim is not None and not await still_ours():
                return None
            if exc.code == "mcp_server_unregistered" and mode.attach and not registered_again:
                registered_again = True
                await db.commit()  # the run's row lock is not held across the call
                try:
                    await runtime.ensure_mcp_server(url)
                    registered = True
                except RuntimeUnavailable:
                    registered = False
                if claim is not None and not await still_ours():
                    return None
                if registered:
                    continue
            fallback = _degrade(mode, exc)
            if fallback is None and exc.code == "mcp_server_unregistered" and mode.attach:
                fallback = _Mode(False, False, [*mode.notes, workflow.advice(exc.code, "")])
            if fallback is not None:
                log.info("run %s: submitting %s again: %s", run.id, segment.name, exc.code)
                mode = fallback
                continue
            if exc.lost:
                # The workflow may exist: keep its token alive and look before resubmitting.
                found = None
                await db.commit()  # the run's row lock is not held across the lookup
                try:
                    found = await runtime.find_by_label(tag, since=submitted_at)
                except RuntimeUnavailable:
                    pass
                if claim is not None and not await still_ours():
                    return found or None  # found: nothing runs for it, the caller cancels it
                if found:
                    _accepted(run, segment, art, found, info, change_request, runtime)
                    return None
                art["lost"] = info
                _pending(
                    segment,
                    art,
                    change_request,
                    f"{exception_text(exc)}; Oracle looks for submission {tag} "
                    "before submitting again",
                )
                log.warning("run %s segment %s: submit lost: %s", run.id, segment.name, exc)
                return None
            await revoke_run_tokens(db, run.id)
            _pending(segment, art, change_request, workflow.advice(exc.code, exception_text(exc)))
            log.warning("run %s segment %s: submit failed: %s", run.id, segment.name, exc)
            return None
        if claim is not None and not await still_ours():
            return workflow_id
        _accepted(run, segment, art, workflow_id, info, change_request, runtime)
        return None


def _accepted(
    run: Run,
    segment: RunSegment,
    art: dict[str, Any],
    workflow_id: str,
    info: dict[str, Any],
    change_request: str | None,
    runtime: AgentRuntime,
) -> None:
    """Record a submission the runtime holds (just made, or found by its label)."""
    art.pop("lost", None)
    art.pop("decision", None)
    art.pop("claim", None)
    art.pop("pending_note", None)
    art.pop("pending_review", None)
    # A new workflow: what was read of the last one's waits no longer applies.
    _set_knob(run, "queue_wait", None)
    art["attempts"].append(
        {
            # The number in its key: submissions given up on (Retry) keep theirs.
            "attempt": int(info.get("attempt") or service._attempt_of(info.get("label"), 0))
            or len(art["attempts"]) + 1,
            "workflow_id": workflow_id,
            "submitted_at": info.get("submitted_at") or service._now().isoformat(),
            "cost_usd": None,
            "note": change_request,
            "state": "running",
            "label": info.get("label"),
            "mode": info.get("mode"),
        }
    )
    notes = list(info.get("notes") or [])
    if not info.get("attach") and not runtime.can_reach_oracle:
        notes += runtime.notes()
    if info.get("mode") == "workflow":
        hours = get_runtime_settings().checkpoint_wait_seconds / 3600
        notes.append(
            f"From '{_flow(run).segment(segment.name).title}' on, this run is one SwarmCloud "
            f"workflow: each checkpoint waits there for up to {hours:g} h and is answered "
            "from the Inbox, and the run token lasts "
            f"{info.get('credential_seconds')} s from submission."
        )
    for note in notes:
        if note not in art["notes"]:
            art["notes"].append(note)
    _set_art(segment, art)
    segment.status = "running"
    segment.swarm_workflow_id = workflow_id
    segment.error = None
    segment.finished_at = None
    segment.started_at = segment.started_at or service._now()
    run.status = "running"
    if info.get("mode") == "workflow":
        _set_knob(
            run,
            "workflow",
            {
                "id": workflow_id,
                "label": info.get("label"),
                "state": "live",
                "start_seq": info.get("start_seq", segment.seq),
                "submitted_at": info.get("submitted_at"),
                "expires_at": info.get("expires_at"),
                "credential_seconds": info.get("credential_seconds"),
                "segments": info.get("segments") or [],
                "waits": info.get("waits") or [],
            },
        )
    else:
        _set_knob(run, "workflow", None)


async def _submit(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    change_request: str | None = None,
    review: str | None = None,
) -> None:
    """Queue the segment for submission (the caller commits): the runtime is not called,
    the segment waits (:data:`QUEUED`) for :func:`submit_queued` to submit it after the
    caller commits, with neither the review gate nor the run's row lock held across the
    call. Every path that starts a segment queues; none submits under a lock.

    ``change_request`` is the person's note (the attempt's note, kept until a submission
    succeeds); ``review``, the structured review a send-back delivers (D4), is what the
    agents get instead when given."""
    if _flow(run).segment(segment.name).waits_for_draft_items and not await _draft_items_ready(
        db, run, segment, segments
    ):
        return
    art = _art(segment)
    if change_request or review:
        _keep_previous(art)
    if change_request:
        art["pending_note"] = change_request
    if review:
        art["pending_review"] = review
    elif change_request:
        art.pop("pending_review", None)
    art.pop("claim", None)
    _set_art(segment, art)
    segment.status = "pending"
    segment.error = QUEUED
    run.status = "running"


def _workflow_segments(
    flow: flows.FlowDef, segment: RunSegment, segments: list[RunSegment]
) -> list[RunSegment]:
    """The segments one workflow covers from ``segment`` on: up to, not including, a later
    segment that waits for the draft's roadmap items (F4 lane B: Oracle starts it once they
    are ready, as a workflow of its own)."""
    out: list[RunSegment] = []
    for s in segments:
        if s.seq < segment.seq or s.status == "skipped":
            continue
        if s.seq > segment.seq and flow.segment(s.name).waits_for_draft_items:
            break
        out.append(s)
    return out


async def _draft_items_ready(
    db: AsyncSession, run: Run, segment: RunSegment, segments: list[RunSegment]
) -> bool:
    """F4 lane B: whether a segment that reads the approved PRD version's draft roadmap
    items may be queued now. Otherwise the run waits for them (``waiting_for`` on the
    segment, re-checked each tick, a Derive asked for when there are none) or the segment
    is skipped with its note, and the run goes on (it ends)."""
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        creator: Principal | None = _creator(current_tenant(db), user, token)
    except LookupError:
        creator = None
    state, n, note = await eng_dates.start_state(db, run, creator)
    art = _art(segment)
    waited = art.pop("waiting_for", None)
    if state == "go":
        if waited is not None:
            _set_art(segment, art)
        return True
    if state == "wait":
        art["waiting_for"] = {"kind": "draft_items", "version": n}
        _set_art(segment, art)
        segment.status = "pending"
        segment.error = None
        run.status = "running"
        return False
    art["note"] = note
    _note_art(art, note or "")
    _set_art(segment, art)
    segment.status = "skipped"
    segment.estimate_usd = Decimal("0.00")
    segment.cost_usd = Decimal("0")
    segment.finished_at = service._now()
    segment.error = None
    await _next(db, run, segment, segments)
    return False


def _awaiting_items(segments: list[RunSegment]) -> RunSegment | None:
    """The segment waiting for the draft's roadmap items (F4 lane B), if any."""
    return next(
        (s for s in segments if s.status == "pending" and (s.artifacts or {}).get("waiting_for")),
        None,
    )


def _keep_previous(art: dict[str, Any]) -> None:
    """A person sent the segment back (D5): its current files and what Oracle's check found
    in them become ``previous``, the files the re-run starts from (and that ``?attempt=``
    serves). One level only: an earlier ``previous`` is replaced."""
    files = art.get("files") or {}
    if not files or not art["attempts"]:
        return
    last = art["attempts"][-1]
    imported = art.get("import") or {}
    art["previous"] = {
        "attempt": int(last.get("attempt") or len(art["attempts"])),
        "files": dict(files),
        "items_check": art.get("items_check"),
        "import_problems": list(imported.get("problems") or []),
        "kept_at": service._now().isoformat(),
    }


# Set on a segment a voided overrun Resume had queued: the next Resume queues it again.
RESUME_VOIDED = "resume_voided"


def unqueue(segment: RunSegment) -> None:
    """Take a pending segment off the queue (its run no longer waits on the runtime): a
    submission under way finds its claim gone and cancels what it started."""
    art = _art(segment)
    art.pop("claim", None)
    art.pop("decision", None)
    _set_art(segment, art)
    segment.error = None


async def _locked(db: AsyncSession, run_id: uuid.UUID) -> tuple[Run | None, list[RunSegment]]:
    """The run, locked and read afresh, with its segments read afresh."""
    run = await db.scalar(
        select(Run)
        .where(Run.id == run_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if run is None:
        return None, []
    segments = list(
        await db.scalars(
            select(RunSegment)
            .where(RunSegment.run_id == run_id)
            .order_by(RunSegment.seq)
            .execution_options(populate_existing=True)
        )
    )
    return run, segments


def _waiting(segment: RunSegment) -> bool:
    """Pending with a reason: queued by a request (:data:`QUEUED`), or refused by the
    runtime earlier (the error it gave). Either waits to be submitted."""
    return segment.status == "pending" and bool(segment.error)


async def _within[T](call: Awaitable[T], deadline: float | None) -> T:
    """A runtime call, cut at ``deadline`` (loop time; None: the client's own timeouts).
    Only the call is timed: a database query is never cancelled halfway."""
    if deadline is None:
        return await call
    try:
        async with asyncio.timeout_at(deadline):
            return await call
    except TimeoutError:
        raise RuntimeUnavailable(
            f"the agent runtime did not answer within the tick's {service.TICK_RUN_SECONDS:g} s "
            "for "
            "this run"
        ) from None
