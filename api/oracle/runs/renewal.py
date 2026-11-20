"""Runs: a run's key renewed, and its workflow paused while the key cannot be renewed."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.runs import service, workflow
from oracle.runs.models import Run, RunSegment
from oracle.runs.service import (
    _art,
    _checkpoints,
    _current_attempt,
    _detach,
    _drivable,
    _harvest,
    _live,
    _locked,
    _note,
    _parse_at,
    _plan_entry,
    _set_art,
    _set_knob,
    _within,
    log,
)
from oracle.runtokens import RunToken, mint_run_token, revoke_run_tokens
from oracle.swarm import Parked, RuntimeUnavailable, WorkflowStatus
from oracle.swarm.runtime import MCP_SERVER
from oracle.swarm.settings import (
    MAX_CREDENTIAL_SECONDS,
    MIN_CREDENTIAL_SECONDS,
    get_runtime_settings,
)

#
# SwarmCloud #2498: a step that starts after the workflow's MCP credential expired (it
# waited in SwarmCloud's queue past the run token's lifetime) is parked CREDENTIAL_MISSING
# with code mcp_credential_expired, not failed. The tick marks the park on the run's
# workflow (``key_refresh``); after the pass commits, :func:`refresh_key` revokes the run's
# token, mints one with the same scopes and a lifetime sized for the steps still to run,
# and re-stores it (``PUT /v1/workflows/{id}/mcp-credentials``), which returns the parked
# steps to READY. Once per park, and never twice within KEY_REFRESH_SECONDS. A SwarmCloud
# that fails the step instead of parking it fails the run as before (``mcp_credential_
# expired``'s advice): the two paths never both act on one step, since a parked step has
# not failed and a failed one is never parked again.

# The least time between two renewals of a run's key.
KEY_REFRESH_SECONDS = 60
# The parks remembered as handled (the newest).
_KEY_REFRESH_PARKS = 20
_FINISHED_STEPS = frozenset({"SUCCEEDED", "SKIPPED", "FAILED", "CANCELLED", "DEAD_LETTERED"})


def _key_park_advice(parked: Parked) -> str:
    """The advice for a CREDENTIAL_MISSING park Oracle does not renew: a missing key, an
    expired one without a server to name, else (no detail) a switched-off server."""
    if parked.credential == "mcp" and parked.code == "mcp_credential_missing":
        return "key_missing"
    if parked.credential == "mcp" and parked.code == "mcp_credential_expired":
        return "key_expired_unnamed"
    return "CREDENTIAL_MISSING"


def _park_key(parked: Parked) -> str:
    at = parked.parked_at or parked.expired_at
    return f"{parked.task_id or parked.step_id}@{at.isoformat() if at else ''}"


def _mark_key_refresh(
    run: Run, wf: dict[str, Any], status: WorkflowStatus, parks: list[Parked]
) -> dict[str, Any]:
    """Mark the run's workflow for a key renewal when a park not handled yet is seen; the
    lifetime is sized as at submission, for the steps still to run. Returns the workflow
    as marked (unchanged when every park was handled, when SwarmCloud refused a renewal
    of this workflow already, or when the key stored last is newer than the park's
    expiry: the steps it promoted use it)."""
    refresh = dict(wf.get("key_refresh") or {})
    if refresh.get("state") == "refused":
        return wf
    minted = _parse_at(refresh.get("minted_at")) if refresh.get("state") == "stored" else None
    if minted is not None:
        parks = [p for p in parks if p.expired_at is None or p.expired_at > minted]
    handled = list(refresh.get("parks") or [])
    new = [k for k in (_park_key(p) for p in parks) if k not in handled]
    if not new:
        return wf
    wait_steps = (
        set(wf["waits"])
        if "waits" in wf
        else {r for e in wf.get("segments") or [] for r in e.get("reviews") or []}
    )
    left = [s for s in status.steps if s.state not in _FINISHED_STEPS]
    agents = sum(1 for s in left if s.step_id not in wait_steps)
    ttl = workflow.credential_seconds(agents, len(left) - agents, get_runtime_settings())
    refresh.update(
        parks=(handled + new)[-_KEY_REFRESH_PARKS:],
        park=new[-1],
        server=parks[0].server,
        seconds=ttl,
        state="due",
        seen_at=service._now().isoformat(),
    )
    wf = {**wf, "key_refresh": refresh}
    _set_knob(run, "workflow", wf)
    return wf


def _renewed_note(at: datetime, zone: str) -> str:
    return (
        f"Key renewed at {company_time.stamp(at, zone)}: the step started after its key "
        "expired while it waited in SwarmCloud's queue"
    )


async def refresh_key(
    db: AsyncSession, run_id: uuid.UUID, *, deadline: float | None = None
) -> str | None:
    """Renew the run's key for a park :func:`_mark_key_refresh` marked (nothing when none
    is due): commits the new token before the call, so no lock is held across it, then
    records what SwarmCloud answered. The token goes only in the call's body. Returns an
    error to report once (a 403 or a 422), else None. Commits."""
    run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
    wf = _drivable(run) if run is not None else None
    refresh = dict((wf or {}).get("key_refresh") or {})
    if (
        run is None
        or wf is None
        or run.status not in ("running", "awaiting_checkpoint")
        or refresh.get("state") not in ("due", "retry", "storing")
    ):
        await db.rollback()
        return None
    minted = _parse_at(refresh.get("minted_at"))
    if minted is not None and (service._now() - minted).total_seconds() < KEY_REFRESH_SECONDS:
        await db.rollback()
        return None
    # The same scopes as the run's token (its newest): never wider.
    scopes = await db.scalar(
        select(RunToken.scopes)
        .where(RunToken.run_id == run.id)
        .order_by(RunToken.created_at.desc())
        .limit(1)
    )
    if not scopes:
        _set_knob(run, "workflow", {**wf, "key_refresh": {**refresh, "state": "ended"}})
        await db.commit()
        return None
    seconds = int(refresh.get("seconds") or 0) or int(wf.get("credential_seconds") or 0)
    seconds = max(MIN_CREDENTIAL_SECONDS, min(MAX_CREDENTIAL_SECONDS, seconds))
    await revoke_run_tokens(db, run.id)
    token = await mint_run_token(db, run.id, scopes, seconds)
    workflow_id, server = wf["id"], str(refresh.get("server") or MCP_SERVER)
    refresh.update(state="storing", minted_at=service._now().isoformat())
    _set_knob(run, "workflow", {**wf, "key_refresh": refresh})
    await db.commit()
    refused: RuntimeUnavailable | None = None
    try:
        await _within(
            service.get_runtime().store_mcp_credentials(workflow_id, server, token, seconds),
            deadline,
        )
    except RuntimeUnavailable as exc:
        refused = exc
    run, segments = await _locked(db, run_id)
    wf = _live(run) if run is not None else None
    if run is None or wf is None or wf["id"] != workflow_id:
        await db.commit()
        return None
    refresh = dict(wf.get("key_refresh") or {})
    target = next(
        (s for s in segments if s.status == "running"),
        next((s for s in reversed(segments) if s.swarm_workflow_id == workflow_id), segments[0]),
    )
    status = refused.status if refused is not None else 200
    error: str | None = None
    if refused is None:
        refresh["state"] = "stored"
        # The decision's tail rule (:func:`_left`) counts from the renewed key.
        minted_at = _parse_at(refresh.get("minted_at")) or service._now()
        wf["expires_at"] = workflow.expires_at(minted_at, seconds).isoformat()
        _note(target, _renewed_note(service._now(), await company_time.company_time_zone(db)))
        await audit.record(
            db, None, "run.key_renewed", "run", run.id,
            {"workflow_id": workflow_id, "server": server, "expires_in": seconds},
        )  # fmt: skip
        log.info("run %s: key renewed for workflow %s (%s s)", run.id, workflow_id, seconds)
    elif status in (404, 409):
        # The workflow finished, or SwarmCloud does not know it: the run's own end
        # handling follows on the next read.
        refresh["state"] = "ended"
        log.info("run %s: key renewal not needed (HTTP %s)", run.id, status)
    elif status in (403, 422):
        refresh["state"] = "refused"
        # The key SwarmCloud refused was sent nowhere else: it is not left valid.
        await revoke_run_tokens(db, run.id)
        code = "key_refresh_forbidden" if status == 403 else "key_refresh_refused"
        _note(target, workflow.ADVICE[code])
        error = f"run {run_id}: SwarmCloud refused the run's key renewal (HTTP {status})"
        log.warning("run %s: key renewal refused: %s", run.id, refused)
    else:
        # Not answered, or SwarmCloud unavailable: tried again after KEY_REFRESH_SECONDS.
        refresh["state"] = "retry"
        log.warning("run %s: key renewal not confirmed: %s", run.id, refused)
    _set_knob(run, "workflow", {**wf, "key_refresh": refresh})
    await db.commit()
    return error


async def _pause_workflow(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    status: WorkflowStatus,
    segments: list[RunSegment],
) -> None:
    """Paused on overrun: cancel the live workflow, so that nothing more is spent (its
    checkpoint-off segments would run on, one after another). The segment it was on keeps
    its files when they are written (resuming opens its checkpoint in the Inbox), else it
    is submitted again as a new workflow once the run is resumed."""
    current = next((s for s in segments if s.status == "running"), None)
    entry = _plan_entry(wf, current.seq) if current is not None else None
    if current is not None and entry is not None:
        round_ = int(entry.get("round") or 1)
        producers = tuple(entry["work"]) if round_ == 1 else (entry["revises"][round_ - 2],)
        done = status.step(producers[-1])
        held = None
        if done is not None and done.state == "SUCCEEDED":
            held = await _harvest(db, run, current, wf["id"], producers)
        if done is None or done.state != "SUCCEEDED" or held is not None:
            art = _art(current)
            if art["attempts"]:
                _current_attempt(art, current)["state"] = "cancelled"
            _set_art(current, art)
            current.status = "pending"
            current.error = (
                "Paused on overrun before this segment finished: Oracle cancelled its "
                "workflow, and resuming submits the segment again."
            )
    for cp in await _checkpoints(db, [run.id]):
        wait = (cp.payload or {}).get("wait") or {}
        if cp.status == "pending" and wait.get("workflow_id") == wf["id"]:
            # Its wait goes with the workflow: the checkpoint stays open in the Inbox.
            wait = {**wait, "ended": "paused", "ended_at": service._now().isoformat()}
            console = wait.get("console") or {}
            if console.get("needs") == "unread":
                # Never read now (the workflow is cancelled): an approver decides.
                wait["console"] = {
                    **console,
                    "needs": "unreadable",
                    "reason": "the run was paused on overrun before Oracle could read the "
                    "recorded answer (its workflow was cancelled), so an Oracle approver "
                    "decides",
                }
            cp.payload = {**(cp.payload or {}), "wait": wait}
    _note(
        current or segments[0],
        "Paused on overrun: Oracle cancelled the run's SwarmCloud workflow so that nothing "
        "more is spent; resuming continues as a new workflow.",
    )
    if not await _detach(db, run, cancel=True, state="paused"):
        _note(
            current or segments[0],
            "SwarmCloud did not confirm cancelling the workflow: Oracle cancels it again on "
            "every tick and keeps counting its cost, and submits nothing after it until "
            "the cancel is confirmed.",
        )


# How often the tick reads a wait while its run waits on it (GET .../input).
WATCH_SECONDS = 60
