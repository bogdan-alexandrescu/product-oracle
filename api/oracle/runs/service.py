"""Runs: drafts, estimates and approval, segments on the agent runtime, checkpoints.

    draft --start--> running                     (estimate <= $50)
    draft --start--> awaiting_approval --approve (owner)--> running
    running --segment ends--> awaiting_checkpoint --approved--> running (next segment)
                                                  --changes_requested--> running (re-run)
    running --spend > ceiling--> paused_overrun --resume (owner)--> running
    last checkpoint approved (or off) --> succeeded; a failed segment --> failed
    any non-final state --cancel--> cancelled

Every state change locks the run row. ``tick`` advances runs: it polls running
segments, records cost, pauses on overrun, and on success merges ``baseline.yaml``
into the baseline (through its YAML import: locked items get proposals), checks
``roadmap_items.yaml``, imports the draft (``prd.md`` or ``roadmap.md``, the target
document's kind) as the document's next version, and opens the segment's checkpoint (or
skips a disabled one).

Adapter v2 (oracle.runs.workflow, docs/swarmcloud-interface.md): whenever SwarmCloud's
caller MCP is on, the run token reaches the agents through the workflow's credential map,
in either mode, so agents read Oracle's data; while await-input is on too, a run is one
workflow whose checkpoints wait for a person in SwarmCloud, and the Inbox decision is
posted as the answer. Await-input off (or refused at submit): today's one workflow per
segment, the token still attached while MCP is on; MCP off: nothing attached. The run's
notes say which.

    running --wait opens--> awaiting_checkpoint (the workflow parked on its step)
            --approved / changes posted--> running (the same workflow goes on)
            --already answered, the workflow ran what the decision needs (same verdict,
              or an approval)--> running (the workflow goes on)
            --answered in SwarmCloud's console (the tick reads the wait once a
              minute) by an Oracle member with the approver role--> the checkpoint
              decided by that answer; the run follows it (W5)
            --answered there by anyone else--> stays open in the Inbox, showing the
              answer, for an approver to confirm or request changes
            --a counted console NOT_YET with no revision step (an earlier checkpoint)-->
              stays open with the findings: Redo from the segment (a new workflow, one
              more segment) or Continue; nothing re-runs without that choice
            --already answered with MERGE, changes requested (a correction), expired,
              closed, tail rule, refused--> the workflow cancelled; today's flow: a new
              workflow
    running / awaiting_checkpoint --spend > ceiling--> paused_overrun, the live workflow
            cancelled

A cancel SwarmCloud does not confirm keeps the workflow attached (``cancel_pending``):
its cost is still counted, its run token is revoked, every tick cancels it again (giving
up, recorded, on SwarmCloud's not_found; other 404s are counted, and past
``NOT_FOUND_TRIES`` the run shows in the Inbox with Cancel), and nothing is submitted
after it until the cancel holds; an Inbox decision that would need it says "decide
again". Past the cap only the cancel call rests: the workflow's status and cost are read
every tick. Stop cancelling (P3d) ends the cancel calls and clears the Inbox item, but
the workflow is never detached from the spend: it goes on ``searches`` with its id, its
status and cost read on every tick until it ends. On a run that has not ended, Stop
cancelling ends the run (owner, 2026-10-19): no second workflow starts for that segment,
and a spend over the ceiling after the end shows in the Inbox. A submission given up
on (Retry, or a cancel past the lookup cap) is looked for in the background
(``searches``, the first look on the next tick) until found, then cancelled and its cost
counted, or ruled out, within its credential's lifetime plus a step's timeout of slack;
a found workflow whose status reads is followed (on every tick) until SwarmCloud says it
ended, a confirmed cancel still winding down included. One whose status does not read
past that (or past ``NOT_FOUND_TRIES`` bare 404s) shows in the Inbox as "Cost unknown"
(Retry lookup reads it now), read again now and then until ``COST_UNKNOWN_SECONDS``
later, then dropped (noted). A workflow's cost counts once, on the first attempt that
carries it. Search results are committed on their own, before the rest of the tick. A
confirmed cancel reads the workflow's final cost (a recorded cost is never lowered), and
the spend is checked against the ceiling before every submission and before anything
follows an answer.

W5 (owner, 2026-10-19, 'Open waits'): while any checkpoint wait of the run is open in
SwarmCloud, from the moment the workflow reaches it, the run token is read-only; writes
return once Oracle has read an answer that counts. A wait Oracle has not opened a
checkpoint for yet is read from SwarmCloud when the token is checked (:func:`token_hold`);
an answered one Oracle cannot read yet (SwarmCloud errors, a 404, a record that lags the
step, or a 409 already_answered whose record does not read) is shown as ``needs: unread``
until the answer is read; the approver rule applies then.

Segment ``artifacts`` (jsonb) hold ``files`` (name -> text), ``attempts`` (one entry
per submission or in-workflow round: workflow id, label, cost, the reviewer's note),
``notes``, ``import``, ``baseline_import``, ``items_check`` and ``lost`` (a submission
whose answer was lost, looked up by its label before resubmitting).
Run ``knobs`` hold the resolved knobs plus values Oracle sets: ``document_slug`` (a
document the run will create), ``spend_ceiling_usd``, and for prd_to_roadmap
``source_version_id`` (the approved PRD version), ``template``, ``template_version`` and
``theme`` (the roadmap's), ``workflow``: the live v2 workflow's id, label, credential
expiry and plan (oracle.runs.workflow), ``stuck_lookup`` (a lost submission past the
lookup cap, for Retry), ``searches`` (submissions given up on, still looked for) and
``post_404`` (404s that prove nothing on an answer post, counted).
"""

import asyncio
import copy
import logging
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, confidence
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.baseline import yaml_io
from oracle.baseline.models import Edge, Entity
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.parser import DraftError, is_uuid
from oracle.docs.schemas import VersionSource
from oracle.priorities import service as priorities_service
from oracle.priorities.models import PrioritySnapshot
from oracle.review.models import FeedbackItem
from oracle.review.service import locked_section_keys
from oracle.runs import flows, roadmap, workflow
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.schemas import (
    AgentRoleOut,
    CheckpointOut,
    ConsoleAnswer,
    DraftImport,
    EstimateOut,
    FlowCatalog,
    FlowOut,
    FlowSegmentOut,
    InboxCheckpoint,
    InboxDocument,
    InboxFeedbackItem,
    InboxOut,
    ItemsCheck,
    KnobsIn,
    KnobsOut,
    RunCreate,
    RunOut,
    RunPatch,
    RunSummary,
    SegmentAttempt,
    SegmentEstimate,
    SegmentOut,
    TickOut,
)
from oracle.runtokens import mint_run_token, revoke_run_tokens
from oracle.sources.models import Snapshot
from oracle.swarm import (
    AgentRuntime,
    McpAccess,
    RecordedAnswer,
    RuntimeUnavailable,
    StepSpec,
    WorkflowSpec,
    WorkflowStatus,
    get_runtime,
    redact,
)
from oracle.swarm.runtime import MERGE, NOT_YET
from oracle.swarm.settings import get_runtime_settings
from oracle.templates import service as templates_service
from oracle.templates.builtins import (
    DEFAULT_TEMPLATE_FOR_KIND,
    DEFAULT_THEME_FOR_KIND,
    ensure_builtins,
)
from oracle.templates.models import Template, TemplateVersion, Theme
from oracle.tenancy import current_tenant, tenant_session
from oracle.tenant_settings import TenantSetting

log = logging.getLogger(__name__)

FINAL = ("succeeded", "failed", "cancelled")
ACTIVE = ("running", "awaiting_checkpoint", "paused_overrun")
# Run knobs Oracle sets (not the user's knobs): kept when a draft's knobs change.
ORACLE_KNOBS = ("document_slug", "source_version_id", "template", "template_version", "theme")
ITEMS_FILE = "roadmap_items.yaml"


class RunError(Exception):
    status = 409


class NotFound(RunError):
    status = 404


class Invalid(RunError):
    status = 422


class Forbidden(RunError):
    status = 403


class Unavailable(RunError):
    """The agent runtime did not confirm a call; repeating it is safe."""

    status = 503


def _now() -> datetime:
    return datetime.now(UTC)


def _usd(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def _flow(run: Run) -> flows.FlowDef:
    return flows.FLOWS[run.flow]


def _knobs(run: Run) -> flows.Knobs:
    return flows.resolve_knobs(_flow(run), run.knobs)


def _art(segment: RunSegment) -> dict[str, Any]:
    """A copy of the segment's artifacts to edit; assign it back with ``_set_art``."""
    data = copy.deepcopy(segment.artifacts or {})
    data.setdefault("files", {})
    data.setdefault("attempts", [])
    data.setdefault("notes", [])
    return data


def _set_art(segment: RunSegment, data: dict[str, Any]) -> None:
    # A fresh object every time: the column is not mutation-tracked.
    segment.artifacts = copy.deepcopy(data)


def _set_knob(run: Run, key: str, value: Any) -> None:
    knobs = dict(run.knobs or {})
    if value is None:
        knobs.pop(key, None)
    else:
        knobs[key] = value
    run.knobs = knobs


def _ceiling(run: Run) -> Decimal | None:
    raw = (run.knobs or {}).get("spend_ceiling_usd")
    if raw is not None:
        return Decimal(str(raw))
    if run.estimate_usd is None:
        return None
    return run.estimate_usd * flows.OVERRUN_FACTOR


# --------------------------------------------------------------------------- reads


def flow_catalog() -> FlowCatalog:
    runtime = get_runtime()
    return FlowCatalog(
        flows=[
            FlowOut(
                key=f.key,  # type: ignore[arg-type]
                title=f.title,
                description=f.description,
                requires_document=f.requires_document,
                target_kind=f.target_kind,  # type: ignore[arg-type]
                source_kind=f.source_kind,  # type: ignore[arg-type]
                segments=[
                    FlowSegmentOut(
                        name=s.name,
                        title=s.title,
                        roles=list(s.roles),
                        scopes=list(s.scopes),
                        outputs=list(s.outputs_for(f.target_kind or "prd")),
                        checkpoint=s.checkpoint,  # type: ignore[arg-type]
                        approver_role=s.approver_role,  # type: ignore[arg-type]
                    )
                    for s in f.segments
                ],
            )
            for f in flows.FLOWS.values()
        ],
        roles=[
            AgentRoleOut(key=r.key, title=r.title, description=r.description, base_usd=r.base_usd)
            for r in flows.ROLES.values()
        ],
        depths={k: float(v) for k, v in flows.DEPTHS.items()},
        approval_threshold_usd=float(flows.APPROVAL_THRESHOLD_USD),
        overrun_factor=float(flows.OVERRUN_FACTOR),
        runtime=runtime.name,
        runtime_notes=runtime.notes(),
    )


async def _get_run(db: AsyncSession, run_id: uuid.UUID, *, lock: bool = False) -> Run:
    stmt = select(Run).where(Run.id == run_id)
    if lock:
        # Read again as it is now: the caller may have read it unlocked before.
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    run = await db.scalar(stmt)
    if run is None:
        raise NotFound(f"run {run_id} not found")
    return run


async def _segments(
    db: AsyncSession, run_id: uuid.UUID, *, fresh: bool = False
) -> list[RunSegment]:
    stmt = select(RunSegment).where(RunSegment.run_id == run_id).order_by(RunSegment.seq)
    if fresh:
        # Read again as they are now: another transaction may have changed them.
        stmt = stmt.execution_options(populate_existing=True)
    return list(await db.scalars(stmt))


async def _checkpoints(db: AsyncSession, run_ids: list[uuid.UUID]) -> list[Checkpoint]:
    if not run_ids:
        return []
    rows = await db.scalars(
        select(Checkpoint)
        .where(Checkpoint.run_id.in_(run_ids))
        .order_by(Checkpoint.created_at, Checkpoint.id)
    )
    return list(rows)


@dataclass
class _Refs:
    """What run summaries show of the documents they name, loaded once per list."""

    slugs: dict[uuid.UUID, str]
    kinds: dict[uuid.UUID, str]
    sources: dict[uuid.UUID, VersionSource]

    def get(self, document_id: uuid.UUID | None) -> str | None:
        return self.slugs.get(document_id) if document_id else None


def _source_id(run: Run) -> uuid.UUID | None:
    raw = (run.knobs or {}).get("source_version_id")
    return uuid.UUID(raw) if raw else None


async def _refs(db: AsyncSession, runs: list[Run]) -> _Refs:
    ids = {r.document_id for r in runs if r.document_id}
    slugs: dict[uuid.UUID, str] = {}
    kinds: dict[uuid.UUID, str] = {}
    if ids:
        rows = await db.execute(
            select(Document.id, Document.slug, Document.kind).where(Document.id.in_(ids))
        )
        for doc_id, slug, kind in rows.all():
            slugs[doc_id], kinds[doc_id] = slug, kind
    sources = await docs_service.version_sources(db, [_source_id(r) for r in runs])
    return _Refs(slugs, kinds, sources)


def _summary(run: Run, refs: _Refs, waiting: Checkpoint | None) -> RunSummary:
    flow = _flow(run)
    source_id = _source_id(run)
    return RunSummary(
        id=run.id,
        flow=run.flow,  # type: ignore[arg-type]
        flow_title=flow.title,
        status=run.status,  # type: ignore[arg-type]
        document_id=run.document_id,
        document_slug=refs.get(run.document_id)
        if run.document_id
        else run.knobs.get("document_slug"),
        document_kind=(refs.kinds.get(run.document_id) if run.document_id else None)
        or flow.target_kind,  # type: ignore[arg-type]
        source=refs.sources.get(source_id) if source_id else None,
        template=run.knobs.get("template"),
        theme=run.knobs.get("theme"),
        estimate_usd=_usd(run.estimate_usd),
        spent_usd=float(run.spent_usd or 0),
        created_by=run.created_by,
        created_at=run.created_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        waiting_on=waiting.kind if waiting else None,  # type: ignore[arg-type]
        error=run.error,
        stuck=_stuck(run),
        can_retry=_can_retry(run),
        can_stop_cancelling=_cancel_stuck(run) is not None,
        can_retry_lookup=_cost_unknown(run) is not None,
        searching=_searching(run),
    )


def _can_retry(run: Run) -> bool:
    return run.status == "running" and isinstance((run.knobs or {}).get("stuck_lookup"), dict)


def _stuck(run: Run) -> str | None:
    """What the Inbox says of a run that waits for an owner or its creator: its lost
    submission is past the lookup cap (Retry or Cancel), or SwarmCloud answered a cancel
    or an answer post with :data:`NOT_FOUND_TRIES` 404s that prove nothing (Cancel)."""
    knobs = run.knobs or {}
    if _can_retry(run):
        label = knobs["stuck_lookup"].get("label")
        return f"Submission {label} was lost and is still not found. {_STUCK}."
    wf = _cancel_stuck(run)
    if wf is not None:
        pending = wf.get("cancel_pending") or {}
        return (
            f"SwarmCloud answered HTTP 404 {pending.get('not_found')} times while Oracle "
            f"cancelled workflow {wf.get('id')}, without saying it does not exist "
            f"({pending.get('error')}): it may still run. Oracle keeps reading its cost and "
            f"cancels it again every {_duration(STUCK_LOOKUP_SECONDS)}; in the Inbox, Stop "
            "cancelling stops the cancel calls and ends the run (its cost is still read and "
            "counted until it ends; cancel it in SwarmCloud's console)."
        )
    over = knobs.get("overrun_after_end")
    running = [str(e["id"]) for e in knobs.get("searches") or [] if e.get("id")]
    if isinstance(over, dict) and running and run.status in FINAL:
        return (
            f"After the run ended its spend reached ${run.spent_usd}, over its "
            f"${over.get('ceiling_usd')} ceiling: workflow {', '.join(running)} still runs in "
            "SwarmCloud, and Oracle counts its spend on the run until it ends. Cancel it in "
            "SwarmCloud's console."
        )
    unknown = _cost_unknown(run)
    if unknown is not None:
        n = unknown.get("not_found")
        why = (
            f"SwarmCloud answered HTTP 404 {n} times without saying it does not exist"
            if n
            else "SwarmCloud has not served its status"
        )
        return (
            f"Cost unknown for workflow {unknown.get('id')} (submission {unknown.get('label')}): "
            f"{why} ({unknown.get('error')}) since {str(unknown.get('cost_unknown'))[:16]}. "
            f"Oracle reads it again every {_duration(STUCK_LOOKUP_SECONDS)} until "
            f"{_cost_cap(unknown).isoformat(timespec='minutes')}, and Retry lookup reads it "
            "now; the run's spend has what Oracle last read. If it still runs, cancel it in "
            "SwarmCloud's console."
        )
    post = knobs.get("post_404")
    if (
        run.status == "awaiting_checkpoint"
        and isinstance(post, dict)
        and int(post.get("tries") or 0) >= NOT_FOUND_TRIES
    ):
        return (
            f"SwarmCloud answered the checkpoint's decision with HTTP 404 {post.get('tries')} "
            f"times, without saying the wait does not exist ({post.get('error')}): nothing "
            "was recorded. Decide again later, or in the Inbox, Cancel ends the run."
        )
    return None


def _cost_unknown(run: Run) -> dict[str, Any] | None:
    """The first searched workflow whose cost is unknown (in the Inbox: Retry lookup)."""
    return next(
        (
            e
            for e in (run.knobs or {}).get("searches") or []
            if e.get("id") and e.get("cost_unknown")
        ),
        None,
    )


def _checkpoint_out(cp: Checkpoint, principal: Principal | None) -> CheckpointOut:
    console = ((cp.payload or {}).get("wait") or {}).get("console")
    return CheckpointOut(
        id=cp.id,
        run_id=cp.run_id,
        kind=cp.kind,  # type: ignore[arg-type]
        status=cp.status,  # type: ignore[arg-type]
        approver_role=cp.approver_role,  # type: ignore[arg-type]
        segment_seq=(cp.payload or {}).get("segment_seq"),
        decided_by=cp.decided_by,
        decided_at=cp.decided_at,
        note=cp.note,
        payload=cp.payload or {},
        created_at=cp.created_at,
        console=ConsoleAnswer.model_validate({**console, "can_redo": _can_redo(console)})
        if isinstance(console, dict) and cp.status == "pending"
        else None,
        can_decide=cp.status == "pending"
        and principal is not None
        and has_role(principal.role, cp.approver_role),  # type: ignore[arg-type]
    )


def _segment_out(
    run: Run, segment: RunSegment, knobs: flows.Knobs, kind: str = "prd"
) -> SegmentOut:
    sdef = _flow(run).segment(segment.name)
    art = segment.artifacts or {}
    imp = art.get("import")
    check = art.get("items_check")
    return SegmentOut(
        id=segment.id,
        seq=segment.seq,
        name=segment.name,
        title=sdef.title,
        status=segment.status,  # type: ignore[arg-type]
        roles=knobs.roles.get(segment.name, list(sdef.roles)),
        scopes=list(sdef.scopes),
        checkpoint=sdef.checkpoint_for(kind),  # type: ignore[arg-type]
        checkpoint_on=knobs.checkpoints.get(sdef.checkpoint, True),
        estimate_usd=_usd(segment.estimate_usd),
        cost_usd=float(segment.cost_usd or 0),
        workflow_id=segment.swarm_workflow_id,
        artifacts=sorted((art.get("files") or {}).keys()),
        attempts=[SegmentAttempt(**a) for a in art.get("attempts") or []],
        draft_import=DraftImport(**imp) if imp else None,
        items_check=ItemsCheck(**check) if check else None,
        started_at=segment.started_at,
        finished_at=segment.finished_at,
        error=segment.error,
    )


async def read_run(db: AsyncSession, run_id: uuid.UUID, principal: Principal | None) -> RunOut:
    run = await _get_run(db, run_id)
    segments = await _segments(db, run.id)
    checkpoints = await _checkpoints(db, [run.id])
    refs = await _refs(db, [run])
    knobs = _knobs(run)
    kind = await _target_kind(db, run)
    snapshot = await db.get(Snapshot, run.snapshot_id) if run.snapshot_id else None
    waiting = next((c for c in checkpoints if c.status == "pending"), None)
    runtime = get_runtime()
    notes: list[str] = []
    for s in segments:
        for n in (s.artifacts or {}).get("notes") or []:
            if n not in notes:
                notes.append(n)
    if run.status == "draft" or not segments or not any(s.swarm_workflow_id for s in segments):
        notes += [n for n in runtime.notes() if n not in notes]
    return RunOut(
        **_summary(run, refs, waiting).model_dump(),
        knobs=KnobsOut(
            depth=knobs.depth,  # type: ignore[arg-type]
            roles=knobs.roles,
            checkpoints=knobs.checkpoints,
            budget_usd=_usd(knobs.budget_usd),
        ),
        snapshot_id=run.snapshot_id,
        snapshot_as_of=snapshot.as_of if snapshot else None,
        approved_by=run.approved_by,
        approved_at=run.approved_at,
        needs_approval=run.estimate_usd is not None
        and run.estimate_usd > flows.APPROVAL_THRESHOLD_USD,
        overrun_ceiling_usd=_usd(_ceiling(run)),
        runtime=runtime.name,
        notes=notes,
        segments=[_segment_out(run, s, knobs, kind) for s in segments],
        checkpoints=[_checkpoint_out(c, principal) for c in checkpoints],
        token_read_only=await token_hold(db, run.id, live=False) is not None,
    )


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
    that counts. A wait that ended (expired, closed, paused) is no longer open."""
    if cp.status != "pending":
        return False
    wait = (cp.payload or {}).get("wait") or {}
    needs = (wait.get("console") or {}).get("needs")
    if needs in _HOLDING:
        return True
    return bool(wait.get("workflow_id")) and not wait.get("ended") and needs not in _COUNTED


def _hold_reason(cp: Checkpoint) -> str:
    needs = (((cp.payload or {}).get("wait") or {}).get("console") or {}).get("needs")
    if needs == "confirm":
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
# A review step SwarmCloud has not reached (or never will: gated off). Any other state,
# or no row for the step, is reached: read-only (deny by default).
_NOT_REACHED = ("PENDING", "SKIPPED")

_HoldKey = tuple[uuid.UUID, str, tuple[str, ...]]
_hold_cache: dict[_HoldKey, tuple[float, str]] = {}
_hold_reads: dict[_HoldKey, "asyncio.Task[str | None]"] = {}


@dataclass(frozen=True)
class _HoldPlan:
    """What Oracle's records say of a run token's hold: held (``reason``, and the
    ``detail`` logged for it), or decided by a live read of workflow ``workflow_id``:
    its review steps no checkpoint stands for yet (``reviews``)."""

    reason: str | None = None
    detail: str | None = None
    workflow_id: str | None = None
    reviews: tuple[str, ...] = ()


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
    wf = _drivable(run)
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
    reviews = [r for e in wf.get("segments") or [] for r in e.get("reviews") or []]
    unknown = tuple(r for r in reviews if r not in known)
    if not unknown or not wf.get("id"):
        return _HoldPlan()
    return _HoldPlan(workflow_id=wf["id"], reviews=unknown)


async def _read_hold(key: _HoldKey) -> str | None:
    """One live read of a workflow's status: whether it reached a review step no
    checkpoint stands for yet. Bounded by :data:`HOLD_READ_SECONDS`; a read-only answer
    is kept for :data:`HOLD_CACHE_SECONDS`."""
    run_id, workflow_id, reviews = key
    held: str | None = None
    try:
        async with asyncio.timeout(HOLD_READ_SECONDS):
            status = await get_runtime().status(workflow_id)
    except (RuntimeUnavailable, TimeoutError) as exc:
        log.warning(
            "run %s: token read-only, status of %s not read: %s",
            run_id,
            workflow_id,
            exc or f"no answer in {HOLD_READ_SECONDS:g} s",
        )
        held = HOLD_UNKNOWN
    else:
        for review in reviews:
            step = status.step(review)
            if step is None or step.state not in _NOT_REACHED:
                log.info(
                    "run %s: token read-only, step %s of %s is %s",
                    run_id,
                    review,
                    workflow_id,
                    step.state if step else "not listed",
                )
                held = HOLD_DECISION
                break
    if held is not None:
        now = _hold_clock()
        for k in [k for k, (at, _) in _hold_cache.items() if now - at >= HOLD_CACHE_SECONDS]:
            del _hold_cache[k]
        _hold_cache[key] = (now, held)
    return held


async def _live_hold(run_id: uuid.UUID, workflow_id: str, reviews: tuple[str, ...]) -> str | None:
    """The live read's answer: a read-only one from the last 5 seconds, else one read
    shared by every request asking meanwhile (single-flight per run and workflow)."""
    key = (run_id, workflow_id, reviews)
    cached = _hold_cache.get(key)
    if cached is not None and _hold_clock() - cached[0] < HOLD_CACHE_SECONDS:
        return cached[1]
    loop = asyncio.get_running_loop()
    task = _hold_reads.get(key)
    if task is None or task.get_loop() is not loop:
        task = loop.create_task(_read_hold(key))
        _hold_reads[key] = task

        def done(t: "asyncio.Task[str | None]") -> None:
            if _hold_reads.get(key) is t:
                del _hold_reads[key]

        task.add_done_callback(done)
    # Shielded: one request going away does not cancel the read the others wait on.
    return await asyncio.shield(task)


async def token_hold(db: AsyncSession, run_id: uuid.UUID, *, live: bool = True) -> str | None:
    """Why the run's token is read-only now (W5), or None: its agents may read Oracle,
    and their writes (drafts, proposals) are refused while any checkpoint wait of the
    run is open in SwarmCloud, until Oracle has read an answer that counts, and while a
    lost submission (whose token is alive) is unresolved.

    From the moment the workflow reaches the wait, not from Oracle's next look at it: a
    review step of the live workflow that no checkpoint stands for yet is read from
    SwarmCloud, and reached in any state (or not listed, or not read) it holds.
    ``live`` False: from what Oracle recorded only (the run's page). A write checks it
    with :func:`run_token_hold`, which releases the database before SwarmCloud is read."""
    plan = await _hold_plan(db, run_id)
    if plan.reason is not None:
        return _held(plan.reason)
    if not live or plan.workflow_id is None:
        return None
    why = await _live_hold(run_id, plan.workflow_id, plan.reviews)
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
    why = await _live_hold(run_id, plan.workflow_id, plan.reviews)
    return _held(why) if why else None


def _console_findings(console: dict[str, Any]) -> list[str]:
    return [str(f).strip() for f in console.get("findings") or [] if str(f).strip()]


def _can_redo(console: dict[str, Any]) -> bool:
    """Redo carries the console's findings as the change request; without any, a note
    is needed (the web disables the button until one is written)."""
    return bool(_console_findings(console))


async def list_runs(db: AsyncSession, status: str | None = None) -> list[RunSummary]:
    stmt = select(Run).order_by(Run.created_at.desc(), Run.id)
    if status:
        stmt = stmt.where(Run.status == status)
    runs = list(await db.scalars(stmt))
    refs = await _refs(db, runs)
    pending = {
        c.run_id: c for c in await _checkpoints(db, [r.id for r in runs]) if c.status == "pending"
    }
    return [_summary(r, refs, pending.get(r.id)) for r in runs]


async def read_artifact(db: AsyncSession, run_id: uuid.UUID, seq: int, name: str) -> str:
    await _get_run(db, run_id)
    segment = await db.scalar(
        select(RunSegment).where(RunSegment.run_id == run_id, RunSegment.seq == seq)
    )
    files = ((segment.artifacts or {}).get("files") or {}) if segment else {}
    if name not in files:
        raise NotFound(f"artifact {name!r} not found")
    return files[name]


# --------------------------------------------------------------------------- drafts


async def _resolve_document(
    db: AsyncSession, flow: flows.FlowDef, ref: str | None, default_slug: str | None = None
) -> tuple[Document | None, str | None]:
    """(document, new slug) for a run's target document."""
    if ref is None:
        if flow.requires_document:
            raise Invalid(f"the {flow.title} flow needs the document to work on")
        if default_slug is None:
            raise Invalid("name the PRD: an existing document, or a new slug to create")
        ref = default_slug
    document = await docs_service.find_document(db, ref)
    if document is None:
        if flow.requires_document or is_uuid(ref):
            raise Invalid(f"document '{ref}' not found")
        return None, ref
    if flow.target_kind and document.kind != flow.target_kind:
        raise Invalid(
            f"document '{ref}' is a {flows.KIND_NAMES.get(document.kind, document.kind)}, "
            f"not a {flows.KIND_NAMES[flow.target_kind]}"
        )
    if flow.requires_document:
        latest = await db.scalar(
            select(func.max(DocumentVersion.number)).where(
                DocumentVersion.document_id == document.id
            )
        )
        if latest is None:
            raise Invalid(f"document '{ref}' has no version to give feedback on")
    return document, None


async def _resolve_source(
    db: AsyncSession, flow: flows.FlowDef, ref: str | None, number: int | None
) -> tuple[Document, DocumentVersion] | None:
    """The approved source version a flow reads (prd_to_roadmap: a PRD version)."""
    if flow.source_kind is None:
        if ref is not None or number is not None:
            raise Invalid(f"the {flow.title} flow reads no source document")
        return None
    name = flows.KIND_NAMES[flow.source_kind]
    if ref is None:
        raise Invalid(f"name the approved {name} to build from")
    document = await docs_service.find_document(db, ref)
    if document is None:
        raise Invalid(f"document '{ref}' not found")
    if document.kind != flow.source_kind:
        raise Invalid(
            f"document '{ref}' is a {flows.KIND_NAMES.get(document.kind, document.kind)}, "
            f"not a {name}"
        )
    stmt = select(DocumentVersion).where(DocumentVersion.document_id == document.id)
    if number is not None:
        version = await db.scalar(stmt.where(DocumentVersion.number == number))
        if version is None:
            raise Invalid(f"version {number} of '{document.slug}' not found")
        if version.approved_at is None:
            raise Invalid(
                f"version {number} of '{document.slug}' is not approved: a roadmap is built "
                f"from an approved {name} version"
            )
        return document, version
    version = await db.scalar(
        stmt.where(DocumentVersion.approved_at.is_not(None))
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if version is None:
        raise Invalid(
            f"'{document.slug}' has no approved version: approve a version of the {name} "
            "before building its roadmap"
        )
    return document, version


async def _resolve_template(
    db: AsyncSession,
    kind: str,
    template: str | None,
    theme: str | None,
    document: Document | None,
) -> dict[str, Any]:
    """The target's template (key + version) and theme: the ones named, else the
    existing document's, else the company's new-draft default for the kind (Settings,
    as the new-draft picker), else the built-in defaults (O4: now-next-later and
    roadmap-board for roadmaps)."""
    await ensure_builtins(db)
    company = (await templates_service.company_draft_defaults(db)).get(kind) or {}
    key = template or (document.template if document and document.template else None)
    if not key and company.get("template"):
        key = await db.scalar(
            select(Template.key).where(
                Template.key == company["template"],
                Template.kind == kind,
                Template.archived_at.is_(None),
            )
        )
    key = key or DEFAULT_TEMPLATE_FOR_KIND[kind]
    row = await db.scalar(select(Template).where(Template.key == key))
    if row is None:
        raise Invalid(f"template '{key}' not found")
    if row.kind != kind:
        raise Invalid(f"template '{key}' is a {row.kind} template, not a {kind} template")
    if row.archived_at is not None and template:
        raise Invalid(f"template '{key}' is archived; restore it to start new drafts")
    number = None
    if (
        not template
        and document is not None
        and document.template == key
        and (document.template_version or "").isdigit()
    ):
        number = int(document.template_version)  # type: ignore[arg-type]
    stmt = select(TemplateVersion.version).where(TemplateVersion.template_id == row.id)
    if number is not None:
        stmt = stmt.where(TemplateVersion.version == number)
    number = await db.scalar(stmt.order_by(TemplateVersion.version.desc()).limit(1))
    if number is None:
        raise Invalid(f"template '{key}' has no version")
    company_theme = None
    if company.get("theme"):
        company_theme = await db.scalar(
            select(Theme.key).where(
                Theme.key == company["theme"],
                Theme.kind.in_((kind, "any")),
                Theme.archived_at.is_(None),
            )
        )
    theme_key = (
        theme
        or (document.theme if document else None)
        or company_theme
        or DEFAULT_THEME_FOR_KIND[kind]
    )
    trow = await db.scalar(select(Theme).where(Theme.key == theme_key))
    if trow is None:
        raise Invalid(f"theme '{theme_key}' not found")
    if trow.kind not in (kind, "any"):
        raise Invalid(f"theme '{theme_key}' is for {trow.kind} documents, not {kind}")
    if trow.archived_at is not None and theme:
        raise Invalid(f"theme '{theme_key}' is archived")
    return {"template": key, "template_version": number, "theme": theme_key}


async def _free_slug(db: AsyncSession, base: str) -> str:
    return await templates_service._free_slug(db, base)


@dataclass
class _Inputs:
    document: str | None = None
    source: str | None = None
    source_version: int | None = None
    template: str | None = None
    theme: str | None = None


async def _resolve_inputs(
    db: AsyncSession, flow: flows.FlowDef, inputs: _Inputs
) -> tuple[uuid.UUID | None, dict[str, Any]]:
    """(target document id, the knobs Oracle sets) for a run's document, source and
    template choices."""
    if flow.target_kind != "roadmap" and (inputs.template or inputs.theme):
        raise Invalid(f"the {flow.title} flow takes no template or theme")
    source = await _resolve_source(db, flow, inputs.source, inputs.source_version)
    default_slug = None
    if source is not None and inputs.document is None:
        # "<prd>-roadmap": that roadmap's next version, or a new roadmap.
        base = f"{source[0].slug}-roadmap"
        existing = await docs_service.find_document(db, base)
        default_slug = (
            base
            if existing is None or existing.kind == flow.target_kind
            else (await _free_slug(db, base))
        )
    document, new_slug = await _resolve_document(db, flow, inputs.document, default_slug)
    oracle: dict[str, Any] = {}
    if new_slug:
        oracle["document_slug"] = new_slug
    if source is not None:
        oracle["source_version_id"] = str(source[1].id)
    if flow.target_kind == "roadmap":
        oracle.update(
            await _resolve_template(db, "roadmap", inputs.template, inputs.theme, document)
        )
    return (document.id if document else None), oracle


def _resolve_knobs(flow: flows.FlowDef, knobs: KnobsIn) -> flows.Knobs:
    try:
        return flows.resolve_knobs(flow, knobs.model_dump())
    except flows.KnobError as exc:
        raise Invalid(str(exc)) from exc


async def _reset_segments(db: AsyncSession, run: Run, flow: flows.FlowDef) -> None:
    for s in await _segments(db, run.id):
        await db.delete(s)
    await db.flush()
    for i, sdef in enumerate(flow.segments, start=1):
        db.add(RunSegment(run_id=run.id, seq=i, name=sdef.name, status="pending"))
    run.estimate_usd = None


async def create_run(db: AsyncSession, principal: Principal, body: RunCreate) -> uuid.UUID:
    flow = flows.FLOWS[body.flow]
    knobs = _resolve_knobs(flow, body.knobs)
    document_id, oracle = await _resolve_inputs(
        db,
        flow,
        _Inputs(body.document, body.source, body.source_version, body.template, body.theme),
    )
    run = Run(
        flow=flow.key,
        status="draft",
        knobs={**knobs.as_json(), **oracle},
        document_id=document_id,
        created_by=principal.id,
    )
    db.add(run)
    await db.flush()
    await _reset_segments(db, run, flow)
    details: dict[str, Any] = {"flow": flow.key}
    if oracle.get("source_version_id"):
        details["source_version_id"] = oracle["source_version_id"]
    await audit.record(db, principal, "run.created", "run", run.id, details)
    await db.commit()
    return run.id


async def _current_inputs(db: AsyncSession, run: Run) -> _Inputs:
    knobs = run.knobs or {}
    source = number = None
    source_id = _source_id(run)
    if source_id:
        version = await db.get(DocumentVersion, source_id)
        if version is not None:
            source, number = str(version.document_id), version.number
    return _Inputs(
        document=str(run.document_id) if run.document_id else knobs.get("document_slug"),
        source=source,
        source_version=number,
        template=knobs.get("template"),
        theme=knobs.get("theme"),
    )


async def update_run(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, body: RunPatch
) -> None:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError("only a draft run can be changed")
    flow = _flow(run)
    oracle = {k: run.knobs[k] for k in ORACLE_KNOBS if k in (run.knobs or {})}
    stored = {k: v for k, v in run.knobs.items() if k not in ORACLE_KNOBS}
    if body.knobs is not None:
        stored = _resolve_knobs(flow, body.knobs).as_json()
    changed = body.model_fields_set & {"document", "source", "source_version", "template", "theme"}
    if any(getattr(body, k) is not None for k in changed):
        current = await _current_inputs(db, run)
        if body.source is not None:
            # Another PRD: its latest approved version unless one is named.
            current.source, current.source_version = body.source, None
        for k in ("document", "source_version", "template", "theme"):
            if getattr(body, k) is not None:
                setattr(current, k, getattr(body, k))
        run.document_id, oracle = await _resolve_inputs(db, flow, current)
    run.knobs = {**stored, **oracle}
    await _reset_segments(db, run, flow)
    await audit.record(db, principal, "run.updated", "run", run.id, {})
    await db.commit()


async def estimate(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> EstimateOut:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError("only a draft run can be estimated")
    flow, knobs = _flow(run), _knobs(run)
    segments = {s.name: s for s in await _segments(db, run.id)}
    rows = []
    for i, sdef in enumerate(flow.segments, start=1):
        amount = flows.segment_estimate(sdef, knobs)
        segments[sdef.name].estimate_usd = amount
        rows.append(
            SegmentEstimate(
                seq=i,
                name=sdef.name,
                title=sdef.title,
                roles=knobs.roles[sdef.name],
                estimate_usd=float(amount),
            )
        )
    total = sum((Decimal(str(r.estimate_usd)) for r in rows), Decimal(0))
    run.estimate_usd = total
    await audit.record(db, principal, "run.estimated", "run", run.id, {"usd": str(total)})
    await db.commit()
    return EstimateOut(
        run_id=run.id,
        depth=knobs.depth,  # type: ignore[arg-type]
        total_usd=float(total),
        segments=rows,
        approval_threshold_usd=float(flows.APPROVAL_THRESHOLD_USD),
        needs_approval=total > flows.APPROVAL_THRESHOLD_USD,
        budget_usd=_usd(knobs.budget_usd),
        within_budget=knobs.budget_usd is None or total <= knobs.budget_usd,
    )


# --------------------------------------------------------------------------- start


async def start(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError(f"run is {run.status}, not a draft")
    if run.estimate_usd is None:
        raise RunError("estimate the run first: POST /v1/runs/{id}/estimate")
    knobs = _knobs(run)
    source_id = _source_id(run)
    if source_id is not None and await db.get(DocumentVersion, source_id) is None:
        raise Invalid("the PRD version this roadmap is built from no longer exists")
    if knobs.budget_usd is not None and run.estimate_usd > knobs.budget_usd:
        raise Invalid(
            f"the estimate (${run.estimate_usd:.2f}) is over the budget "
            f"(${knobs.budget_usd:.2f}): lower the depth or roles, or raise the budget"
        )
    # The sources the run reads are pinned now, for the user who created it.
    snapshot = Snapshot(
        label=f"Run {str(run.id)[:8]} ({_flow(run).title})",
        as_of=_now(),
        created_by=run.created_by,
    )
    db.add(snapshot)
    await db.flush()
    run.snapshot_id = snapshot.id
    if run.estimate_usd > flows.APPROVAL_THRESHOLD_USD:
        run.status = "awaiting_approval"
        await audit.record(
            db, principal, "run.awaiting_approval", "run", run.id, {"usd": str(run.estimate_usd)}
        )
        await db.commit()
        return
    await audit.record(db, principal, "run.started", "run", run.id, {})
    await _launch(db, run)
    await db.commit()


async def approve(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "awaiting_approval":
        raise RunError(f"run is {run.status}, not awaiting approval")
    run.approved_by = principal.id
    run.approved_at = _now()
    await audit.record(db, principal, "run.approved", "run", run.id, {"usd": str(run.estimate_usd)})
    await _launch(db, run)
    await db.commit()


async def _launch(db: AsyncSession, run: Run) -> None:
    run.status = "running"
    run.started_at = _now()
    ceiling = (run.estimate_usd * flows.OVERRUN_FACTOR).quantize(Decimal("0.0001"))
    _set_knob(run, "spend_ceiling_usd", str(ceiling))
    segments = await _segments(db, run.id)
    await _submit(db, run, segments[0], segments)


# --------------------------------------------------------------------------- segments


async def _low_threshold(db: AsyncSession) -> float:
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == "confidence_weights"))
    overrides = row.value if row is not None and isinstance(row.value, dict) else None
    return float(confidence.merged(overrides)["low"])


async def _prompt_context(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    attempt: int,
    change_request: str | None,
    runtime: AgentRuntime,
    *,
    attached: bool = False,
    planned: list[tuple[int, str, list[str]]] | None = None,
) -> flows.PromptContext:
    """``attached``: the run token reaches the agents, so earlier outputs are named, not
    pasted; ``planned``: earlier segments of the same workflow and the files they write."""
    knobs = _knobs(run)
    snapshot = await db.get(Snapshot, run.snapshot_id) if run.snapshot_id else None
    document = None
    doc = await db.get(Document, run.document_id) if run.document_id else None
    if doc is not None:
        document = doc.slug
    document = document or run.knobs.get("document_slug")
    kind = await _target_kind(db, run)
    source = await _source_context(db, run)
    roadmap_ctx = None
    if source is not None and _flow(run).segment(segment.name).imports_draft:
        title = doc.title if doc is not None else f"{source.title} roadmap"
        roadmap_ctx = await _roadmap_context(db, run, document or "", title)
    prior: dict[str, str] = {}
    prior_files: list[tuple[int, str, list[str]]] = []
    in_workflow = {seq for seq, _, _ in planned or []}
    for s in segments:
        if s.seq < segment.seq and s.seq not in in_workflow:
            files = (s.artifacts or {}).get("files") or {}
            for name, content in files.items():
                prior[name] = content
            if files:
                prior_files.append((s.seq, _flow(run).segment(s.name).title, sorted(files)))
    prior_files += list(planned or [])
    notes = [
        f"{c.kind}: {c.note}"
        for c in await _checkpoints(db, [run.id])
        if c.status == "approved" and c.note
    ]
    feedback: list[dict[str, Any]] = []
    locked: list[str] = []
    if run.flow == "feedback_loop" and run.document_id:
        items = await db.scalars(
            select(FeedbackItem)
            .where(FeedbackItem.document_id == run.document_id, FeedbackItem.status == "open")
            .order_by(FeedbackItem.created_at, FeedbackItem.id)
        )
        feedback = [
            {"id": str(f.id), "section_key": f.section_key, "summary": f.summary} for f in items
        ]
        latest = await db.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == run.document_id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
        if latest is not None:
            locked = sorted(await locked_section_keys(db, latest.id))
    return flows.PromptContext(
        run_id=str(run.id),
        document=document,
        snapshot_as_of=snapshot.as_of.isoformat() if snapshot else None,
        low_confidence=await _low_threshold(db),
        depth=knobs.depth,
        prior_outputs=prior,
        reviewer_notes=notes,
        feedback=feedback,
        locked_sections=locked,
        attempt=attempt,
        change_request=change_request,
        # SwarmCloud reaches Oracle only through the credential it attaches; the local
        # runtime's agents are Oracle's own.
        mcp_reachable=attached or (runtime.can_reach_oracle and runtime.name != "swarmcloud"),
        mcp_attached=attached,
        prior_files=prior_files,
        kind=kind,
        source=source,
        roadmap=roadmap_ctx,
    )


async def _target_kind(db: AsyncSession, run: Run) -> str:
    """The kind of the document the run writes: the flow's, else the document's."""
    flow = _flow(run)
    if flow.target_kind:
        return flow.target_kind
    if run.document_id:
        kind = await db.scalar(select(Document.kind).where(Document.id == run.document_id))
        if kind:
            return kind
    return "prd"


def _explain(feature: dict[str, Any]) -> str:
    explanation = feature.get("explanation") or {}
    parts = [explanation.get("formula") or ""]
    parts += list(explanation.get("steps") or [])[:3]
    parts += list(explanation.get("order") or [])[:2]
    return " ".join(p for p in parts if p)[:400]


async def _source_context(db: AsyncSession, run: Run) -> flows.SourceContext | None:
    """prd_to_roadmap: the approved PRD version, priorities, edges and goals."""
    source_id = _source_id(run)
    if source_id is None:
        return None
    version = await db.get(DocumentVersion, source_id)
    if version is None:
        return None
    document = await db.get(Document, version.document_id)
    sections = list(
        (
            await db.execute(
                select(Section.section_key, Section.heading)
                .where(Section.version_id == version.id)
                .order_by(Section.ordinal)
            )
        ).all()
    )
    # The latest stored priority order, else the live goal-weighted ranking.
    stored = await db.scalar(
        select(PrioritySnapshot).order_by(PrioritySnapshot.created_at.desc()).limit(1)
    )
    if stored is not None:
        method = f"{stored.method}, priority snapshot of {stored.created_at:%Y-%m-%d}"
        ranking = list(stored.ranking or [])
    else:
        live = await priorities_service.compute(db, "goal_weighted")
        method = f"{live.method}, live ranking"
        ranking = [f.model_dump(mode="json") for f in live.features]
    priorities = [
        {
            "rank": f.get("rank"),
            "key": f.get("key"),
            "title": f.get("title"),
            "score": f.get("score"),
            "flags": f.get("flags") or [],
            "depends_on": f.get("depends_on") or [],
            "explanation": _explain(f),
        }
        for f in ranking
    ]
    entities = {
        e.id: e for e in await db.scalars(select(Entity).where(Entity.status != "rejected"))
    }
    edges = [
        {
            "src": f"{entities[e.src_id].type}:{entities[e.src_id].key}",
            "type": e.type,
            "dst": f"{entities[e.dst_id].type}:{entities[e.dst_id].key}",
        }
        for e in await db.scalars(
            select(Edge)
            .where(Edge.type.in_(("depends_on", "blocks")), Edge.status != "rejected")
            .order_by(Edge.created_at, Edge.id)
        )
        if e.src_id in entities and e.dst_id in entities
    ]
    goals = [
        {
            "key": e.key,
            "title": e.title,
            **{k: (e.attrs or {}).get(k) for k in ("metric", "target", "horizon")},
        }
        for e in sorted(entities.values(), key=lambda e: e.key)
        if e.type == "goal" and e.status == "confirmed"
    ]
    return flows.SourceContext(
        slug=document.slug if document else str(version.document_id),
        title=document.title if document else "",
        version=version.number,
        markdown=version.markdown,
        sections=[(k, h) for k, h in sections],
        priorities=priorities,
        priority_method=method,
        edges=edges,
        goals=goals,
    )


async def _roadmap_context(
    db: AsyncSession, run: Run, slug: str, title: str
) -> flows.RoadmapContext | None:
    """The roadmap draft's template, theme and skeleton (the template's body as a first
    draft of this document, front matter included)."""
    key, number = run.knobs.get("template"), run.knobs.get("template_version")
    if not key or not number:
        return None
    body = await docs_service.template_body(db, key, str(number))
    if body is None:
        return None
    theme = run.knobs.get("theme")
    skeleton = templates_service.draft_skeleton(
        body,
        slug=slug,
        title=title,
        kind="roadmap",
        template=key,
        version=int(number),
        theme=theme,
    )
    return flows.RoadmapContext(
        slug=slug, template=key, template_version=int(number), theme=theme, skeleton=skeleton
    )


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
                notes.append(workflow.advice(exc.code, str(exc)))
            else:
                notes.append(
                    f"Oracle's MCP server could not be registered in SwarmCloud ({exc}): "
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
        return _Mode(mode.attach, False, [*mode.notes, workflow.advice(exc.code, str(exc))])
    if exc.code in _DROP_MCP and mode.attach:
        return _Mode(False, False, [*mode.notes, workflow.advice(exc.code, str(exc))])
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
        f"its last cost), so Oracle did not {what}; decide again, it is safe to repeat"
    )


def _shown(value: Any) -> str | None:
    """An upstream value as Oracle stores it: text, redacted, at most 200 characters."""
    return None if value in (None, "") else redact(str(value))[:200]


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
    return looked is not None and (_now() - looked).total_seconds() < STUCK_LOOKUP_SECONDS


def _lookup_exhausted(lost: dict[str, Any]) -> bool:
    """Whether the search for a lost submission passed its attempt or age cap."""
    if int(lost.get("lookups") or 0) >= LOST_LOOKUP_TRIES:
        return True
    since = _parse_at(lost.get("submitted_at"))
    return since is not None and (_now() - since).total_seconds() >= LOST_LOOKUP_SECONDS


def _plan_entry(wf: dict[str, Any], seq: int) -> dict[str, Any] | None:
    return next((e for e in wf.get("segments") or [] if e.get("seq") == seq), None)


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


def _not_found(exc: RuntimeUnavailable | None) -> bool:
    """A 404 that is not SwarmCloud's not_found envelope: it proves nothing."""
    return exc is not None and exc.status == 404 and not exc.gone


async def _cancel_call(wf: dict[str, Any]) -> _Cancelled:
    """Cancel workflow ``wf`` and read it after (its last cost, or that it ended): calls
    only, nothing written, so the caller may hold no lock."""
    runtime = get_runtime()
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
        _take_cost(run, wf, out.final, await _segments(db, run.id))
    now = _now().isoformat()
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
        _read_on(run, wf)
    await _end_workflow(db, run, wf, state)
    return True


def _read_on(run: Run, wf: dict[str, Any]) -> None:
    """A workflow whose cancel SwarmCloud confirmed and that has not ended yet (winding
    down), or whose last cost was not read: detached, and read on ``searches`` until its
    status reads terminal, so that what it spends meanwhile is counted on the run."""
    _search_for(
        run,
        label=wf.get("label") or wf["id"],
        seq=wf.get("start_seq"),
        submitted_at=wf.get("submitted_at"),
        until=_credential_end(wf),
        why="cancel",
        workflow_id=wf["id"],
        cancelled=True,
    )


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
    cancel: bool,
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
    _set_knob(run, "workflow", {**rest, "state": state, "ended_at": _now().isoformat()})
    await revoke_run_tokens(db, run.id)


def _pending(
    segment: RunSegment, art: dict[str, Any], change_request: str | None, error: str
) -> None:
    """Left pending: the next tick submits it again."""
    segment.status = "pending"
    segment.error = error
    if change_request:
        art["pending_note"] = change_request
    _set_art(segment, art)


async def _submit(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    change_request: str | None = None,
) -> None:
    """Mint the run token and submit the segment's workflow (the caller commits).

    With caller MCP on, the token goes to the agents through the workflow's credential
    map; with await-input on too, the workflow covers the rest of the run and its
    checkpoints wait for a person in SwarmCloud (oracle.runs.workflow). A refusal that
    names a switched-off feature submits again without it; a lost answer is looked up by
    the submission's label before anything is submitted again."""
    runtime = get_runtime()
    settings = get_runtime_settings()
    flow, knobs = _flow(run), _knobs(run)
    sdef = flow.segment(segment.name)
    art = _art(segment)
    # Submissions given up on (Retry from the Inbox) keep their numbers: a new key each.
    attempt = len(art["attempts"]) + len(art.get("abandoned") or []) + 1
    # A retry after the runtime refused a re-run keeps the reviewer's note.
    change_request = change_request or art.pop("pending_note", None)
    if segment.estimate_usd is None:
        segment.estimate_usd = flows.segment_estimate(sdef, knobs)
    tag = workflow.label(run.id, segment.name, attempt)

    # SwarmCloud has no idempotency keys: a submission whose answer was lost may exist.
    lost = art.get("lost")
    if isinstance(lost, dict) and lost.get("label") == tag and _resting(run, lost):
        return  # past the lookup cap, in the Inbox: looked up again now and then
    lost = art.pop("lost", None)
    if isinstance(lost, dict) and lost.get("label") == tag:
        lost["looked_at"] = _now().isoformat()
        try:
            found = await runtime.find_by_label(tag, since=_parse_at(lost.get("submitted_at")))
        except RuntimeUnavailable as exc:
            lost["lookups"] = int(lost.get("lookups") or 0) + 1
            art["lost"] = lost
            error = f"looking up submission {tag}: {exc}"
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
    if (ceiling := _overrun(run)) is not None:
        _pending(
            segment,
            art,
            change_request,
            f"Not submitted: the run spent ${run.spent_usd}, over its ${ceiling} ceiling, so "
            "it paused; resuming submits this segment.",
        )
        await _pause_overrun(db, run, ceiling)
        return
    await revoke_run_tokens(db, run.id)
    url = settings.public_url.rstrip("/") + "/mcp"
    mode = await _mode(runtime, url)
    kind = await _target_kind(db, run)
    registered_again = False
    while True:
        covered = [s for s in segments if s.seq >= segment.seq] if mode.waits else [segment]
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
                change_request if own else None,
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
        if mode.attach:
            agents = sum(1 for s in steps if not s.waits)
            ttl = workflow.credential_seconds(agents, len(steps) - agents, settings)
        else:
            ttl = settings.run_token_ttl_seconds
        await revoke_run_tokens(db, run.id)
        token = await mint_run_token(db, run.id, scopes, ttl)
        submitted_at = _now()
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
        try:
            workflow_id = await runtime.submit(spec)
        except RuntimeUnavailable as exc:
            if exc.code == "mcp_server_unregistered" and mode.attach and not registered_again:
                registered_again = True
                try:
                    await runtime.ensure_mcp_server(url)
                    continue
                except RuntimeUnavailable:
                    pass
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
                try:
                    found = await runtime.find_by_label(tag, since=submitted_at)
                except RuntimeUnavailable:
                    pass
                if found:
                    _accepted(run, segment, art, found, info, change_request, runtime)
                    return
                art["lost"] = info
                _pending(
                    segment,
                    art,
                    change_request,
                    f"{exc}; Oracle looks for submission {tag} before submitting again",
                )
                log.warning("run %s segment %s: submit lost: %s", run.id, segment.name, exc)
                return
            await revoke_run_tokens(db, run.id)
            _pending(segment, art, change_request, workflow.advice(exc.code, str(exc)))
            log.warning("run %s segment %s: submit failed: %s", run.id, segment.name, exc)
            return
        _accepted(run, segment, art, workflow_id, info, change_request, runtime)
        return


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
    art["attempts"].append(
        {
            # The number in its key: submissions given up on (Retry) keep theirs.
            "attempt": int(info.get("attempt") or _attempt_of(info.get("label"), 0))
            or len(art["attempts"]) + 1,
            "workflow_id": workflow_id,
            "submitted_at": info.get("submitted_at") or _now().isoformat(),
            "cost_usd": 0,
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
    segment.started_at = segment.started_at or _now()
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
            },
        )
    else:
        _set_knob(run, "workflow", None)


def _recompute_spend(run: Run, segments: list[RunSegment]) -> None:
    run.spent_usd = sum((s.cost_usd or Decimal(0) for s in segments), Decimal(0))


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
    run.finished_at = _now()
    if error:
        run.error = error
    _set_knob(run, "post_404", None)
    # A run that ends early stops its workflow; a finished one's ends on its own. A cancel
    # SwarmCloud does not confirm leaves the workflow attached: the tick cancels it again
    # and keeps reading its cost.
    await _detach(db, run, cancel=status != "succeeded", state=state, done=done)
    await revoke_run_tokens(db, run.id)


async def _next(
    db: AsyncSession, run: Run, segment: RunSegment, segments: list[RunSegment]
) -> None:
    later = [s for s in segments if s.seq > segment.seq]
    wf = _drivable(run)
    if later and wf is not None and _plan_entry(wf, later[0].seq) is not None:
        # Already part of the live workflow: it runs once the wait is answered.
        nxt = later[0]
        art = _art(nxt)
        art["attempts"].append(
            {
                "attempt": len(art["attempts"]) + 1,
                "workflow_id": wf["id"],
                "submitted_at": _now().isoformat(),
                "cost_usd": 0,
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
        nxt.started_at = nxt.started_at or _now()
        run.status = "running"
        return
    if later:
        await _submit(db, run, later[0], segments)
    else:
        await _finish(db, run, "succeeded")


def _creator(principal_tenant: uuid.UUID, user: User | None, token: ApiToken | None) -> Principal:
    if user is not None:
        return Principal(
            tenant_id=principal_tenant,
            kind="user",
            role=user.role,  # type: ignore[arg-type]
            user_id=user.id,
        )
    if token is not None:
        return Principal(
            tenant_id=principal_tenant,
            kind="token",
            role=token.role,  # type: ignore[arg-type]
            token_id=token.id,
        )
    raise LookupError("run creator not found")


async def _draft_source(db: AsyncSession, run: Run) -> uuid.UUID | None:
    """The provenance of the draft a run imports: the run's source version
    (prd_to_roadmap), else the document's latest version's (the feedback loop keeps the
    PRD version a roadmap came from)."""
    source_id = _source_id(run)
    if source_id is not None or not run.document_id:
        return source_id
    return await db.scalar(
        select(DocumentVersion.source_version_id)
        .where(DocumentVersion.document_id == run.document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _prd_links(db: AsyncSession, markdown: str, source: VersionSource) -> dict[str, Any]:
    """Which of the draft's links to its source document resolve to a section of the
    source version."""
    keys = set(
        await db.scalars(select(Section.section_key).where(Section.version_id == source.version_id))
    )
    resolved, unresolved = 0, []
    for link in roadmap.doc_links(markdown):
        if link["slug"] not in (source.slug, str(source.document_id)):
            continue
        if link["version"] == source.version and (
            link["section"] is None or link["section"] in keys
        ):
            resolved += 1
        else:
            unresolved.append(link["href"])
    return {"resolved": resolved, "unresolved": unresolved}


async def _import_draft(db: AsyncSession, run: Run, kind: str, markdown: str) -> dict[str, Any]:
    """Import the draft as the next version of the run's document (of ``kind``, with
    the run's provenance), in its own transaction."""
    tenant_id = current_tenant(db)
    name = flows.draft_file(kind)
    ref = str(run.document_id) if run.document_id else run.knobs.get("document_slug")
    if not ref:
        return {"error": "the run names no document"}
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        principal = _creator(tenant_id, user, token)
    except LookupError as exc:
        return {"error": str(exc)}
    source_id = await _draft_source(db, run)
    knobs = run.knobs or {}
    template = (
        (knobs["template"], str(knobs["template_version"]))
        if knobs.get("template") and knobs.get("template_version")
        else None
    )
    async with tenant_session(tenant_id) as s:
        try:
            result = await docs_service.import_draft(
                s,
                ref,
                markdown,
                principal,
                kind=kind,
                theme=knobs.get("theme"),
                template=template,
                source_version_id=source_id,
            )
        except DraftError as exc:
            problems = "; ".join(f"[{p.code}] {p.message}" for p in exc.problems)
            return {"error": f"{name} was rejected: {problems}"}
        except (docs_service.NotFoundError, docs_service.ImportConflictError) as exc:
            return {"error": f"{name} was not imported: {exc}"}
        if not result.created and source_id and result.version.source is None:
            # The same draft was already imported (an agent pushed it) without its
            # provenance: record it now.
            row = await s.get(DocumentVersion, result.version.id)
            if row is not None and row.source_version_id is None:
                row.source_version_id = source_id
                await s.commit()
                result.version = await docs_service.read_version(s, row)
        document = await s.get(Document, result.version.document_id)
        out: dict[str, Any] = {
            "document_id": str(result.version.document_id),
            "slug": document.slug if document else None,
            "kind": document.kind if document else kind,
            "version": result.version.number,
            "created": result.created,
            "warnings": [w.code for w in result.version.warnings],
        }
        source = result.version.source
        if source is not None:
            out["source"] = source.model_dump(mode="json")
            out["prd_links"] = await _prd_links(s, markdown, source)
    return out


async def _import_baseline(db: AsyncSession, run: Run, text: str) -> dict[str, Any]:
    """Merge baseline.yaml through the baseline's YAML import, in its own transaction:
    the run's agent writes, as the run's creator; locked items get proposals."""
    tenant_id = current_tenant(db)
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        principal = _creator(tenant_id, user, token)
    except LookupError as exc:
        return {"error": str(exc)}
    async with tenant_session(tenant_id) as s:
        try:
            result = await yaml_io.import_yaml(
                s, principal, text, run_id=run.id, origin="agent", reason="Run baseline.yaml"
            )
        except yaml_io.YamlInvalid as exc:
            problems = "; ".join(
                f"[{p.code}] {p.message}" + (f" ({p.where})" if p.where else "")
                for p in exc.problems
            )
            return {"error": f"baseline.yaml was rejected: {problems}"}
        await s.commit()
    return result.model_dump(mode="json")


def _current_attempt(art: dict[str, Any], segment: RunSegment) -> dict[str, Any]:
    """The segment's current attempt: the latest on its workflow. A found earlier
    submission (a search, a cancel's lookup) is listed by its number and may sit after
    it; the last listed is taken only when none is on the segment's workflow."""
    ours = [a for a in art["attempts"] if a.get("workflow_id") == segment.swarm_workflow_id]
    if ours:
        return ours[-1]
    return art["attempts"][-1] if art["attempts"] else {}


async def _advance(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    wait: dict[str, Any] | None = None,
) -> bool:
    """After a segment succeeded: import its draft, then open or skip its checkpoint.

    ``wait``: the step of the live workflow that waits for this checkpoint's decision
    (adapter v2); the Inbox decision is posted to it.

    Returns False when this attempt of the segment was already advanced.
    """
    flow, knobs = _flow(run), _knobs(run)
    sdef = flow.segment(segment.name)
    art = _art(segment)
    attempt = _current_attempt(art, segment)
    if attempt.get("advanced"):
        return False
    attempt["advanced"] = True
    if wait is not None:
        # W5: the token is held from before the import's commit until the checkpoint
        # that stands for this wait is added (cleared in the same transaction).
        _set_knob(
            run,
            "opening_wait",
            {
                "workflow_id": wait.get("workflow_id"),
                "step_id": wait.get("step_id"),
                "kind": sdef.checkpoint_for(await _target_kind(db, run)),
            },
        )
    imported: dict[str, Any] | None = None
    baseline_import: dict[str, Any] | None = None
    if sdef.imports_baseline:
        text = art["files"].get("baseline.yaml")
        if text is None:
            baseline_import = {"error": "the segment left no baseline.yaml"}
        else:
            # Committed first: the import runs in its own transaction.
            _set_art(segment, art)
            await db.commit()
            baseline_import = await _import_baseline(db, run, text)
            # The commit released the run's row lock: take it again.
            await db.execute(select(Run.id).where(Run.id == run.id).with_for_update())
        art["baseline_import"] = baseline_import
    items_check: dict[str, Any] | None = None
    if ITEMS_FILE in sdef.outputs:
        items_check = await _check_items(db, run, art["files"].get(ITEMS_FILE))
        art["items_check"] = items_check
    if sdef.imports_draft:
        kind = await _target_kind(db, run)
        name = flows.draft_file(kind)
        markdown = art["files"].get(name)
        if markdown is None:
            imported = {"error": f"the segment left no {name}"}
        else:
            # Committed first: the import runs in its own transaction.
            _set_art(segment, art)
            await db.commit()
            imported = await _import_draft(db, run, kind, markdown)
            # The commit released the run's row lock: take it again.
            await db.execute(select(Run.id).where(Run.id == run.id).with_for_update())
            if imported.get("document_id"):
                run.document_id = uuid.UUID(imported["document_id"])
                _set_knob(run, "document_slug", None)
        art["import"] = imported
    _set_art(segment, art)

    payload = {
        "segment_seq": segment.seq,
        "segment": segment.name,
        "attempt": attempt.get("attempt", 1),
        "artifacts": sorted(art["files"].keys()),
    }
    if imported is not None:
        payload["import"] = imported
    if baseline_import is not None:
        payload["baseline_import"] = baseline_import
    if items_check is not None:
        payload["items_check"] = items_check
    if wait is not None:
        payload["wait"] = wait
        _set_knob(run, "opening_wait", None)
    checkpoint_kind = sdef.checkpoint_for(await _target_kind(db, run))
    if knobs.checkpoints.get(sdef.checkpoint, True):
        db.add(
            Checkpoint(
                run_id=run.id,
                kind=checkpoint_kind,
                status="pending",
                approver_role=sdef.approver_role,
                payload=payload,
            )
        )
        run.status = "awaiting_checkpoint"
        return True
    db.add(
        Checkpoint(
            run_id=run.id,
            kind=checkpoint_kind,
            status="skipped",
            approver_role=sdef.approver_role,
            note="Turned off when the run started.",
            payload=payload,
            decided_at=_now(),
        )
    )
    for result in (baseline_import, imported):
        if result is not None and result.get("error"):
            await _finish(db, run, "failed", result["error"])
            return True
    if items_check is not None and items_check["problems"]:
        problems = "; ".join(f"[{p['code']}] {p['message']}" for p in items_check["problems"][:5])
        await _finish(db, run, "failed", f"{ITEMS_FILE} was rejected: {problems}")
        return True
    await _next(db, run, segment, segments)
    return True


async def _check_items(db: AsyncSession, run: Run, text: str | None) -> dict[str, Any]:
    """roadmap_items.yaml checked against the run's PRD version (oracle.runs.roadmap)."""
    if text is None:
        return {
            "items": 0,
            "by_horizon": {},
            "problems": [{"code": "missing_file", "message": f"the segment left no {ITEMS_FILE}"}],
        }
    slug = version = None
    keys: set[str] | None = None
    source_id = _source_id(run)
    if source_id is not None:
        source = (await docs_service.version_sources(db, [source_id])).get(source_id)
        if source is not None:
            slug, version = source.slug, source.version
            keys = set(
                await db.scalars(select(Section.section_key).where(Section.version_id == source_id))
            )
    return roadmap.check_items(
        text, prd_slug=slug, prd_version=version, prd_sections=keys
    ).as_json()


# --------------------------------------------------------------------------- tick


@dataclass
class _TickStats:
    checked: int = 0
    finished: int = 0
    advanced: int = 0
    paused: int = 0
    # Kept, not raised: what a raise would roll back (a count of 404s) is written.
    errors: list[str] = field(default_factory=list)


async def _tick_run(db: AsyncSession, run: Run, stats: _TickStats) -> None:
    runtime = get_runtime()
    segments = await _segments(db, run.id)
    if (run.knobs or {}).get("searches"):
        await _search_earlier(db, run, segments, stats)
        # Committed on its own: what was found, cancelled and counted stays so, whatever
        # the rest of this tick does. The commit released the run's row lock: taken
        # again, the run and its segments are read as they are now.
        await db.commit()
        run = await _get_run(db, run.id, lock=True)
        segments = await _segments(db, run.id, fresh=True)
    wf = _live(run)
    if wf is not None and (wf.get("cancel_pending") or run.status in FINAL):
        if not await _cancel_again(db, run, wf, segments, stats) or run.status != "running":
            return
        wf = None  # confirmed: what was held back (a new workflow) goes on below
        # Its last cost may have crossed the ceiling: nothing is submitted over it.
        if (ceiling := _overrun(run)) is not None:
            await _pause_overrun(db, run, ceiling, stats)
            return
    if wf is not None:
        await _tick_workflow(db, run, wf, segments, stats)
        return
    if run.status in FINAL:
        return
    running = next((s for s in segments if s.status == "running"), None)
    if running is None:
        if run.status == "running":
            # A submission the runtime refused earlier: try again.
            pending = next((s for s in segments if s.status == "pending" and s.error), None)
            if pending is not None:
                await _submit(db, run, pending, segments)
            else:
                # Resumed after an overrun with a finished segment not yet advanced.
                done = [s for s in segments if s.status == "succeeded"]
                if done and await _advance(db, run, done[-1], segments):
                    stats.advanced += 1
        return

    status = await runtime.status(running.swarm_workflow_id)  # type: ignore[arg-type]
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
    if earlier is not None:
        _cost_on(
            run, segments, {"seq": earlier.seq, "id": running.swarm_workflow_id}, status.cost_usd
        )
    if art["attempts"]:
        # The running workflow's attempt (one found later may sit after it).
        current = _current_attempt(art, running)
        current["cost_usd"] = (
            0 if earlier is not None else _higher(status.cost_usd, current.get("cost_usd"))
        )
        current["state"] = status.state
    running.cost_usd = sum(
        (Decimal(str(a.get("cost_usd") or 0)) for a in art["attempts"]), Decimal(0)
    )
    _recompute_spend(run, segments)

    if status.terminal:
        stats.finished += 1
        running.finished_at = _now()
        if status.state == "succeeded":
            files = await runtime.artifacts(running.swarm_workflow_id)  # type: ignore[arg-type]
            art["files"] = {**art["files"], **files}
            running.status = "succeeded"
            await revoke_run_tokens(db, run.id)
        else:
            running.status = "failed" if status.state == "failed" else "cancelled"
            running.error = status.error or f"the workflow ended {status.state}"
            _set_art(running, art)
            await _finish(db, run, "failed", f"{running.name}: {running.error}")
            await audit.record(db, None, "run.failed", "run", run.id, {"segment": running.name})
            return
    _set_art(running, art)

    ceiling = _ceiling(run)
    if run.status == "running" and ceiling is not None and run.spent_usd > ceiling:
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
        return
    if run.status == "running" and running.status == "succeeded":
        if await _advance(db, run, running, segments):
            stats.advanced += 1


def _take_cost(
    run: Run, wf: dict[str, Any], status: WorkflowStatus, segments: list[RunSegment]
) -> RunSegment | None:
    """The live workflow's cost, on the attempt of the segment it was submitted for, and
    the run's spend from it. Returns that segment.

    The whole workflow's cost goes on its first attempt there: a revision inside the
    workflow is another attempt on the same workflow, and counts nothing again. A cost
    is never lowered."""
    start = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if start is not None:
        art = _art(start)
        first = True
        for a in art["attempts"]:
            if a.get("workflow_id") == wf["id"]:
                # Never lowered: a read made earlier (cancel() reads before it takes the
                # run's row lock) is not newer than one the tick recorded meanwhile.
                a["cost_usd"] = _higher(status.cost_usd, a.get("cost_usd")) if first else 0
                first = False
        start.cost_usd = sum(
            (Decimal(str(a.get("cost_usd") or 0)) for a in art["attempts"]), Decimal(0)
        )
        _set_art(start, art)
    _recompute_spend(run, segments)
    return start


def _overrun(run: Run) -> Decimal | None:
    """The ceiling when the run's spend is over it."""
    ceiling = _ceiling(run)
    return ceiling if ceiling is not None and run.spent_usd > ceiling else None


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


# Run states the ceiling pauses (a run waiting on a checkpoint can spend too).
_SPENDING = ("running", "awaiting_checkpoint")


def _rested(pending: dict[str, Any]) -> bool:
    """A cancel past :data:`NOT_FOUND_TRIES` (in the Inbox) is tried again now and then
    (only the cancel call rests: the workflow's status and cost are read every tick)."""
    tried = _parse_at(pending.get("tried_at"))
    return (
        bool(pending.get("stuck"))
        and tried is not None
        and (_now() - tried).total_seconds() < STUCK_LOOKUP_SECONDS
    )


async def _cancel_again(
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
    runtime = get_runtime()
    pending = wf.get("cancel_pending") or {}
    state = pending.get("state") or "ended"
    # Past the cap only the cancel call rests: its status and cost are read every tick.
    rested = _rested(pending)
    if not wf.get("id"):
        label = wf.get("lookup") or ""
        try:
            found = await runtime.find_by_label(label, since=_parse_at(wf.get("lookup_since")))
        except RuntimeUnavailable as exc:
            log.warning("run %s: looking up %s to cancel it: %s", run.id, label, exc)
            lookups = int(pending.get("lookups") or 0) + 1
            since = wf.get("lookup_since") or pending.get("since")
            if _lookup_exhausted({"submitted_at": since, "lookups": lookups}):
                # Never found, never ruled out: looked for in the background instead.
                await _stop_looking(db, run, wf, segments, state, exc)
                return True
            _set_knob(run, "workflow", {**wf, "cancel_pending": {**pending, "lookups": lookups}})
            return False
        if not found:
            await _end_workflow(db, run, wf, state)
            return True
        wf = {**wf, "id": found}
        _set_knob(run, "workflow", wf)
        _adopt(segments, wf)
    try:
        status = await runtime.status(wf["id"])
    except RuntimeUnavailable as exc:
        if exc.gone:
            await _give_up(db, run, wf, state)
            return True
        if rested:
            log.warning("run %s: %s not read (resting): %s", run.id, wf["id"], exc)
            return False
        if pending.get("confirmed"):
            # Its cancel was confirmed and this was the one more read of its last cost:
            # read on in the background, so that nothing waits on it here.
            note = (
                f"SwarmCloud confirmed cancelling workflow {wf['id']}, but its last cost could "
                f"not be read ({_shown(exc)}); Oracle reads it in the background until it "
                "ends and counts it on the run."
            )
            target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
            _note(target or segments[0], note)
            _read_on(run, wf)
            await _end_workflow(db, run, wf, state)
            return True
        if _not_found(exc):
            # Proves nothing: counted (kept, not rolled back), and tried again.
            marker = {**pending, "tried_at": _now().isoformat(), "error": _shown(exc)}
            _count_not_found(marker, pending, True)
            _set_knob(run, "workflow", {**wf, "cancel_pending": marker})
            stats.errors.append(f"run {run.id}: {exc}")
            return False
        raise
    _take_cost(run, wf, status, segments)
    if status.terminal:
        await _end_workflow(db, run, wf, state)
        return True
    if pending.get("confirmed"):
        # Confirmed and winding down: read on in the background until it ends.
        _read_on(run, wf)
        await _end_workflow(db, run, wf, state)
        return True
    if not rested and await _detach(db, run, cancel=True, state=state):
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
    _search_for(
        run,
        label=label,
        seq=wf.get("start_seq"),
        submitted_at=wf.get("lookup_since") or (wf.get("cancel_pending") or {}).get("since"),
        until=wf.get("lookup_until"),
        why="cancel",
    )
    note = (
        f"After {_duration(LOST_LOOKUP_SECONDS)} SwarmCloud's task listing still neither shows "
        f"submission {label} nor rules it out ({_shown(exc)}). Its run token is revoked, and "
        f"Oracle keeps looking for it in the background every "
        f"{_duration(STUCK_LOOKUP_SECONDS)}: if it landed, Oracle cancels it and counts its "
        "cost."
    )
    log.warning("run %s: %s", run.id, note)
    target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if target is not None or segments:
        _note(target or segments[0], note)
    await _end_workflow(db, run, wf, state)


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
            "submitted_at": _now().isoformat(),
            "cost_usd": 0,
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


# --------------------------------------------------------------------------- searches


def _credential_end(info: dict[str, Any]) -> str | None:
    """When a submission's run credential ends, if it was sent one (attached): its agents
    lose Oracle's data then. A submission sent without it is not bounded by the run
    token's lifetime: None (the default bound applies, :data:`SEARCH_SECONDS`)."""
    if info.get("credential_seconds"):
        return info.get("expires_at")
    return info.get("lookup_until")


def _search_end(entry: dict[str, Any]) -> datetime:
    """Past this, a search gives up while SwarmCloud neither shows the submission nor
    rules it out, or does not serve its status: the credential's end (else
    :data:`SEARCH_SECONDS` after it was sent) plus a step's timeout of slack, for a step
    already running then. A workflow whose status reads is followed until it ends."""
    sent = _parse_at(entry.get("submitted_at")) or _now()
    end = _parse_at(entry.get("until")) or sent + timedelta(seconds=SEARCH_SECONDS)
    return end + timedelta(seconds=get_runtime_settings().step_seconds)


def _cost_cap(entry: dict[str, Any]) -> datetime:
    """A searched workflow whose cost is unknown (its status does not read) is read again
    now and then until this, shown in the Inbox with it: :func:`_search_end` plus
    :data:`COST_UNKNOWN_SECONDS`."""
    return _search_end(entry) + timedelta(seconds=COST_UNKNOWN_SECONDS)


def _search_for(
    run: Run,
    *,
    label: str,
    seq: int | None,
    submitted_at: str | None,
    until: str | None,
    why: str,
    workflow_id: str | None = None,
    cancel: bool = True,
    cancelled: bool = False,
) -> None:
    """Keep checking work the run gave up on: the run's ``searches``. A submission whose
    answer was lost (Retry submitted the segment again, or a cancelled run stopped looking
    for it on every tick) is looked for by its label; a workflow known by its id (found,
    or one an approver stopped cancelling: ``cancel`` False; ``cancelled``: its cancel was
    confirmed and only its status and cost are left to read) has its status and cost read
    until it ends. The first look is on the next tick. One entry per submission (its id,
    or its label and when it was sent, compared as times): a second call merges into it."""
    entries = copy.deepcopy(list((run.knobs or {}).get("searches") or []))
    if not label:
        return
    at = _parse_at(submitted_at)
    for e in entries:
        same_id = bool(workflow_id) and e.get("id") == workflow_id
        same_sent = (
            e.get("label") == label
            and at is not None
            and _parse_at(e.get("submitted_at")) == at
            and (not workflow_id or not e.get("id") or e.get("id") == workflow_id)
        )
        if same_id or same_sent:
            if workflow_id and not e.get("id"):
                e["id"] = workflow_id
            if not cancel:
                e["cancel"] = False
            if cancelled:
                e["cancelled"] = True
            _set_knob(run, "searches", entries)
            return
    sent = at or _now()
    end = _parse_at(until) or sent + timedelta(seconds=SEARCH_SECONDS)
    entry: dict[str, Any] = {
        "label": label,
        "seq": seq,
        "submitted_at": sent.isoformat(),
        "until": end.isoformat(),
        "why": why,
        "looked_at": None,
        "lookups": 0,
    }
    if workflow_id:
        entry["id"] = workflow_id
    if not cancel:
        entry["cancel"] = False
    if cancelled:
        entry["cancelled"] = True
    entries.append(entry)
    _set_knob(run, "searches", entries)


def _searching(run: Run) -> str | None:
    """What the Inbox says while Oracle checks work the run gave up on."""
    entries = (run.knobs or {}).get("searches") or []
    if not entries:
        return None
    every = _duration(STUCK_LOOKUP_SECONDS)
    says: list[str] = []
    lost = [str(e.get("label")) for e in entries if not e.get("id")]
    if lost:
        says.append(
            f"Oracle is looking for an earlier submission ({', '.join(lost)}) every {every}: "
            "if it landed, Oracle cancels it and counts its cost in the run's spend; it stops "
            "once it is ruled out, or when its credential would have expired."
        )
    for e in entries:
        if not e.get("id"):
            continue
        if e.get("cancel") is False:
            says.append(
                f"Oracle stopped cancelling workflow {e['id']} ({e.get('label')}), and reads "
                "its status and cost on every tick until it ends, counting its spend on the "
                "run."
            )
        else:
            says.append(
                f"Oracle cancels workflow {e['id']} ({e.get('label')}), given up on earlier, "
                "and reads its status and cost on every tick until it ends, counting its "
                "spend on the run."
            )
    return " ".join(says)


def _cost_on(run: Run, segments: list[RunSegment], entry: dict[str, Any], cost: Decimal) -> None:
    """A searched workflow's cost on its segment's first attempt with its id (a revision
    inside a workflow counts nothing again), never lower than one already recorded."""
    segment = next((s for s in segments if s.seq == entry.get("seq")), None)
    if segment is None:
        return
    art = _art(segment)
    first = True
    for a in art["attempts"]:
        if a.get("workflow_id") == entry["id"]:
            a["cost_usd"] = _higher(cost, a.get("cost_usd")) if first else 0
            first = False
    segment.cost_usd = sum(
        (Decimal(str(a.get("cost_usd") or 0)) for a in art["attempts"]), Decimal(0)
    )
    _set_art(segment, art)
    _recompute_spend(run, segments)


def _higher(cost: Decimal, recorded: Any) -> float:
    """A cost read now, never lower than the one recorded: SwarmCloud's costs only grow,
    so a lower reading is an older one (read before a newer one was recorded)."""
    return max(float(cost), float(recorded or 0))


def _rests(at: Any) -> bool:
    looked = _parse_at(at)
    return looked is not None and (_now() - looked).total_seconds() < STUCK_LOOKUP_SECONDS


async def _read_call(workflow_id: str) -> _Cancelled:
    """Read a workflow Oracle no longer cancels (stopped, or its cancel confirmed): its
    cost and whether it ended. A call only, nothing written."""
    out = _Cancelled()
    try:
        out.final = await get_runtime().status(workflow_id)
    except RuntimeUnavailable as exc:
        if exc.gone:
            out.gone = True
        else:
            out.unread = exc
    return out


async def _search_earlier(
    db: AsyncSession, run: Run, segments: list[RunSegment], stats: _TickStats
) -> None:
    """Check the work the run gave up on (``searches``), each every
    :data:`STUCK_LOOKUP_SECONDS` (the first on the next tick). A submission looked for by
    its label: found, it is cancelled and its cost counted in the run's spend (as
    :func:`_adopt` does); ruled out by the listing, it is dropped; neither, past
    :func:`_search_end`, dropped (noted). A workflow known by its id (:func:`_read_found`)
    is cancelled (unless an approver stopped cancelling it) and its status and cost read
    until it ends. Whatever the run's state: a landed one spends otherwise."""
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    if not entries:
        return
    runtime = get_runtime()
    target = segments[0] if segments else None
    keep: list[dict[str, Any]] = []
    for e in entries:
        label = str(e.get("label") or "")
        segment = next((s for s in segments if s.seq == e.get("seq")), target)
        if not e.get("id"):
            if _rests(e.get("looked_at")):
                keep.append(e)
                continue
            e["looked_at"] = _now().isoformat()
            try:
                found = await runtime.find_by_label(label, since=_parse_at(e.get("submitted_at")))
            except RuntimeUnavailable as exc:
                e["lookups"] = int(e.get("lookups") or 0) + 1
                e["error"] = _shown(exc)
                if _now() >= _search_end(e):
                    if segment is not None:
                        _note(
                            segment,
                            f"Oracle stopped looking for submission {label}: its credential "
                            "would have expired, and SwarmCloud's task listing never showed "
                            f"it nor ruled it out ({_shown(exc)}). If it landed, cancel it in "
                            "SwarmCloud's console; its cost is not counted here.",
                        )
                    continue
                keep.append(e)
                continue
            if not found:
                log.info("run %s: submission %s ruled out", run.id, label)
                continue
            e["id"] = found
            if segment is not None:
                _add_attempt(segment, found, label, "cancelled", mode="abandoned")
        elif e.get("unread") and _rests(e.get("read_at")):
            # Its last read failed: read again now and then. One that reads is read on
            # every tick until it ends, so the ceiling is never overshot by a rest.
            keep.append(e)
            continue
        e["read_at"] = _now().isoformat()
        if await _read_found(run, segments, segment, e):
            keep.append(e)
    _set_knob(run, "searches", keep or None)
    if not keep:
        _set_knob(run, "overrun_after_end", None)
    if (ceiling := _overrun(run)) is not None:
        if run.status in _SPENDING:
            await _pause_overrun(db, run, ceiling, stats)
        elif run.status in FINAL and keep and not (run.knobs or {}).get("overrun_after_end"):
            await _overrun_after_end(db, run, ceiling, target)


async def _overrun_after_end(
    db: AsyncSession, run: Run, ceiling: Decimal, segment: RunSegment | None
) -> None:
    """The ceiling trips on a run that ended while a workflow it no longer cancels still
    spends (P3d: its spend counts on the run): nothing is left to pause, so the overrun
    is recorded and shown in the Inbox until the workflow ends."""
    _set_knob(
        run,
        "overrun_after_end",
        {"spent_usd": str(run.spent_usd), "ceiling_usd": str(ceiling), "at": _now().isoformat()},
    )
    if segment is not None:
        _note(
            segment,
            f"After the run ended its spend reached ${run.spent_usd}, over its ${ceiling} "
            "ceiling: a workflow Oracle no longer cancels still runs in SwarmCloud.",
        )
    await audit.record(
        db,
        None,
        "run.overrun_after_end",
        "run",
        run.id,
        {"spent_usd": str(run.spent_usd), "ceiling_usd": str(ceiling)},
    )


async def _read_found(
    run: Run, segments: list[RunSegment], segment: RunSegment | None, e: dict[str, Any]
) -> bool:
    """One look at a searched workflow known by its id: cancel it (until SwarmCloud
    confirms; not one an approver stopped cancelling) and read its status and cost, the
    cost counted in the run's spend. Returns True to keep it: until its status reads
    terminal (a confirmed cancel still winding down is read on, its cost counted), or
    SwarmCloud says it does not exist. When nothing could be read, 404s that prove
    nothing are counted; past :data:`NOT_FOUND_TRIES` of them, or past
    :func:`_search_end`, its cost is unknown: shown in the Inbox (Retry lookup) and read
    again now and then until :func:`_cost_cap`, then dropped (noted)."""
    label, wid = e.get("label"), e["id"]
    # The cancel call rests between tries (its status and cost are read every tick).
    cancelling = (
        e.get("cancel", True) and not e.get("cancelled") and not _rests(e.get("cancel_tried_at"))
    )
    out = await (_cancel_call({"id": wid}) if cancelling else _read_call(wid))
    if cancelling:
        e["cancel_tried_at"] = _now().isoformat()
        if out.error is None and not out.gone:
            e["cancelled"] = True  # confirmed: its status and cost are left to read
    final = out.final
    if final is not None:
        _cost_on(run, segments, e, final.cost_usd)
        for key in ("unread", "not_found", "stuck", "error", "cost_unknown"):
            e.pop(key, None)
        if final.terminal:
            if segment is not None:
                if e.get("cancel") is False:
                    said = (
                        f"Workflow {wid}, which an approver stopped cancelling, ended "
                        f"{final.state} in SwarmCloud: ${final.cost_usd} counted in the "
                        "run's spend."
                    )
                else:
                    said = (
                        f"Oracle cancelled workflow {wid} (submission {label}), given up on "
                        f"earlier; it ended {final.state} (${final.cost_usd} counted in the "
                        "run's spend)."
                    )
                _note(segment, said)
            return False
        return True  # still running, or winding down: read again (its cost counts)
    if out.gone and not e.get("cancelled"):
        if segment is not None:
            _note(
                segment,
                f"SwarmCloud does not know workflow {wid} (submission {label}, HTTP 404): "
                "Oracle stopped checking it; its cost is what Oracle last read.",
            )
        return False
    # Nothing read this time.
    e["error"] = _shown(out.error or out.unread) or "its status was not read"
    e["unread"] = int(e.get("unread") or 0) + 1
    if _not_found(out.error) or _not_found(out.unread):
        e["not_found"] = int(e.get("not_found") or 0) + 1
        if e["not_found"] >= NOT_FOUND_TRIES:
            e["stuck"] = True
    if e.get("stuck") or _now() >= _search_end(e):
        e.setdefault("cost_unknown", _now().isoformat())
    if e.get("cost_unknown") and _now() >= _cost_cap(e):
        if segment is not None:
            _note(
                segment,
                f"Cost unknown for workflow {wid} (submission {label}): SwarmCloud has not "
                f"served its status since {e['cost_unknown'][:16]} ({e['error']}). Oracle "
                f"stopped reading it at its cap ({_cost_cap(e).isoformat(timespec='minutes')}),"
                " and the run's spend has what Oracle last read. If it still runs, cancel it "
                "in SwarmCloud's console.",
            )
        return False
    return True


async def _harvest(run: Run, segment: RunSegment, workflow_id: str, steps: tuple[str, ...]) -> None:
    """A segment's files from the steps that wrote them (read by task id), in step order:
    a later step's file of the same name wins."""
    files = await get_runtime().artifacts(workflow_id, steps)
    art = _art(segment)
    art["files"] = {**art["files"], **files}
    if art["attempts"]:
        _current_attempt(art, segment)["state"] = "succeeded"
    _set_art(segment, art)
    segment.status = "succeeded"
    segment.finished_at = _now()


# A step state that is neither a failure nor an expiry.
_OPEN_OR_DONE = ("PENDING", "RUNNING", "PARKED", "SUCCEEDED", "SKIPPED")


async def _tick_workflow(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    segments: list[RunSegment],
    stats: _TickStats,
) -> None:
    """Advance a run that is one live workflow: record its cost, take each segment's files
    when the wait after it opens (or when it is done, checkpoint off), open the checkpoint
    with the wait to answer, and notice expiry, failures and the end."""
    status = await get_runtime().status(wf["id"])
    start = _take_cost(run, wf, status, segments)
    current = next((s for s in segments if s.status == "running"), None)
    for parked in status.parked:
        if parked.reason == "CREDENTIAL_MISSING":
            _note(current or start or segments[0], workflow.ADVICE["CREDENTIAL_MISSING"])
    if run.status == "paused_overrun":
        await _pause_workflow(db, run, wf, status, segments)
        return
    # The ceiling first, before anything that follows an answer or submits: it holds while
    # the run waits too (a workflow can spend while its run waits on a checkpoint).
    if (ceiling := _overrun(run)) is not None:
        await _pause_overrun(db, run, ceiling, stats)
        await _pause_workflow(db, run, wf, status, segments)
        return
    if run.status == "awaiting_checkpoint":
        # An answer given outside the Inbox is followed; the workflow ending is noticed.
        await _watch_wait(db, run, wf, status, segments)
        followed = _drivable(run)
        if run.status != "running" or followed is None or followed["id"] != wf["id"]:
            return  # still waiting, or done with this workflow
        wf = followed

    while run.status == "running":
        current = next((s for s in segments if s.status == "running"), None)
        entry = _plan_entry(wf, current.seq) if current is not None else None
        if current is None or entry is None:
            break
        round_ = int(entry.get("round") or 1)
        producers = tuple(entry["work"]) if round_ == 1 else (entry["revises"][round_ - 2],)
        done = status.step(producers[-1])
        if done is None or done.state != "SUCCEEDED":
            break
        reviews = entry.get("reviews") or []
        if entry.get("checkpoint") and round_ <= len(reviews):
            review = reviews[round_ - 1]
            parked = next(
                (p for p in status.parked if p.step_id == review and p.reason == "AWAITING_INPUT"),
                None,
            )
            ended = status.step(review)
            # Answered before Oracle opened its checkpoint (in SwarmCloud's console): the
            # checkpoint opens, and the next look at the wait follows that answer.
            answered = ended is not None and ended.state == "SUCCEEDED"
            closed = status.terminal and ended is not None and ended.state not in _OPEN_OR_DONE
            if parked is None and not answered and not closed:
                break
            await _harvest(run, current, wf["id"], producers)
            wait: dict[str, Any] = {
                "workflow_id": wf["id"],
                "step_id": review,
                "round": round_,
                "artifact": workflow.review_artifact(round_),
            }
            if parked is not None:
                wait["task_id"] = parked.task_id
                wait["opened_at"] = parked.opened_at.isoformat() if parked.opened_at else None
                wait["expires_at"] = parked.expires_at.isoformat() if parked.expires_at else None
            elif answered:
                wait["task_id"] = ended.task_id  # type: ignore[union-attr]
                # W5: answered and not read yet, so held from the start; the next look
                # at the wait reads it and applies the approver rule.
                wait["console"] = _unread_console(
                    run, current, wf, wait, "answered before Oracle opened the checkpoint"
                )
            else:
                # The wait ended before Oracle opened its checkpoint (it expired while the
                # run was paused): the checkpoint opens in the Inbox only.
                wait["ended"] = "expired"
                wait["ended_at"] = _now().isoformat()
                _note(current, workflow.ADVICE["expired"])
                await _detach(db, run, cancel=False, state="expired")
            stats.finished += 1
            if await _advance(db, run, current, segments, wait=wait):
                stats.advanced += 1
            break
        # Checkpoint off, or the last round's revision is done: the files are final.
        await _harvest(run, current, wf["id"], producers)
        stats.finished += 1
        if entry.get("checkpoint"):
            # Its checkpoint waits in the Inbox only: the workflow has nothing left.
            await _detach(db, run, cancel=False, state="ended")
        if await _advance(db, run, current, segments):
            stats.advanced += 1

    if status.terminal and run.status == "running" and _live(run) is not None:
        current = next((s for s in segments if s.status == "running"), None)
        if status.state == "succeeded":
            if current is None:
                await _detach(db, run, cancel=False, state="ended")
                return
            error = f"the workflow ended before '{current.name}' wrote its files"
        else:
            fallback = f"the workflow ended {status.state}: {status.error or 'no reason given'}"
            error = workflow.advice(status.error_code, fallback)
        if current is not None:
            current.status = "failed" if status.state != "cancelled" else "cancelled"
            current.error = error
            current.finished_at = _now()
        await _finish(db, run, "failed", f"{current.name if current else 'workflow'}: {error}")
        await audit.record(db, None, "run.failed", "run", run.id, {"workflow": wf["id"]})


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
        if done is not None and done.state == "SUCCEEDED":
            await _harvest(run, current, wf["id"], producers)
        else:
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
            wait = {**wait, "ended": "paused", "ended_at": _now().isoformat()}
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


async def _waiting_on(db: AsyncSession, run: Run, wf: dict[str, Any]) -> Checkpoint | None:
    """The run's open checkpoint whose wait is in workflow ``wf``."""
    return next(
        (
            c
            for c in await _checkpoints(db, [run.id])
            if c.status == "pending"
            and ((c.payload or {}).get("wait") or {}).get("workflow_id") == wf["id"]
        ),
        None,
    )


async def _watch_wait(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    status: WorkflowStatus,
    segments: list[RunSegment],
) -> None:
    """While the run waits on a checkpoint in its workflow: read the wait (at most once
    a minute) and, when it was answered without the Inbox (in SwarmCloud's console, or
    by an earlier post of Oracle's whose response was lost), take that answer (W5: it is
    the decision only if it counts, and a counted change request the workflow has no
    revision for waits for an approver's Redo or Continue). A workflow that ended
    unanswered leaves the checkpoint in the Inbox.

    A read SwarmCloud did not serve is tried again on the next tick (the tick keeps this
    one's cost reading); a refused read of a step that SUCCEEDED is an answer Oracle
    cannot read, never "unanswered"."""
    cp = await _waiting_on(db, run, wf)
    if cp is None:
        if status.terminal:
            await _wait_ended(db, run, wf, status, segments)
        return
    wait = dict((cp.payload or {}).get("wait") or {})
    if ((wait.get("console") or {}).get("needs")) in ("confirm", "redo_or_continue"):
        return  # answered, and the first answer is final: an approver decides in the Inbox
    try:
        checked = datetime.fromisoformat(wait["checked_at"])
    except (KeyError, TypeError, ValueError):
        checked = None
    if checked is not None and (_now() - checked).total_seconds() < WATCH_SECONDS:
        return
    round_ = int(wait.get("round") or 1)
    step = status.step(wait.get("step_id", ""))
    answered_step = step is not None and step.state == "SUCCEEDED"
    seq = (cp.payload or {}).get("segment_seq")
    segment = next(s for s in segments if s.seq == seq)
    try:
        record = await get_runtime().answer_record(
            wf["id"], wait["step_id"], wait.get("artifact") or workflow.review_artifact(round_)
        )
    except RuntimeUnavailable as exc:
        if exc.retryable:
            log.warning(
                "run %s: wait %s not read, again next tick: %s", run.id, wait["step_id"], exc
            )
            if answered_step:
                # W5: answered, not read yet: held until it is (read again next tick).
                _unread(run, cp, segment, wf, wait, f"SwarmCloud did not serve it ({_shown(exc)})")
            return
        log.warning("run %s: cannot read wait %s: %s", run.id, wait.get("step_id"), exc)
        record = RecordedAnswer(state="answered") if answered_step else RecordedAnswer()
    wait["checked_at"] = _now().isoformat()
    _set_wait(cp, wait)
    if record.answered:
        if record.verdict is None:
            # Never guessed: shown in the Inbox, and read again next time.
            _unreadable(run, cp, segment, wf, wait, record)
            return
        await _take_answer(db, run, cp, segment, segments, wf, wait, record)
        return
    if answered_step:
        # The record lags the step: answered, not read yet (W5), held; read again.
        _unread(run, cp, segment, wf, wait, "SwarmCloud's record does not show the answer yet")
        return
    if status.terminal:
        await _wait_ended(db, run, wf, status, segments)


async def _take_answer(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    wait: dict[str, Any],
    record: RecordedAnswer,
) -> None:
    """A wait answered without the Inbox, noticed by the tick. SwarmCloud's first answer
    is final and the workflow goes on with it; what Oracle does follows W5:

    - Oracle's own answer (a post whose response was lost), or a console answer whose
      answerer (``answered_by``, never the unverified ``on_behalf_of``) is an Oracle member
      with the checkpoint's approver role: the checkpoint's decision, followed;
    - any other console answer: recorded, and the checkpoint stays open in the Inbox for
      an approver to confirm it or request changes;
    - a counted NOT_YET where the workflow has no revision step (an earlier checkpoint:
      it went on into the next segment regardless): never re-run on its own; the
      checkpoint stays open with the findings for an approver's Redo or Continue."""
    round_ = int(wait.get("round") or 1)
    ours = record.answer_id == str(cp.id) and record.by_oracle
    at = record.answered_at.isoformat() if record.answered_at else _now().isoformat()
    findings = list(record.findings)
    applied = "; ".join(findings) or None
    by = record.answered_by
    wait["recorded"] = _recorded(record, by, at, record.via, ours)
    entry = _plan_entry(wf, segment.seq) or {}
    approved = record.verdict == MERGE
    revise = round_ <= len(entry.get("revises") or [])
    member, reason = (
        (None, None)
        if ours
        else await _console_member(db, cp, by, altered=record.answered_by_altered)
    )
    counted = ours or reason is None
    if not counted or (not approved and not revise):
        console = _console_record(run, segment, record, at, revise)
        console.update(
            counted=counted,
            reason=reason,
            needs="redo_or_continue" if counted else "confirm",
            role=member.role if member is not None else None,
        )
        wait["console"] = console
        _set_wait(cp, wait)
        await audit.record(
            db,
            None,
            "checkpoint.console_answer",
            "checkpoint",
            cp.id,
            {
                "run_id": str(run.id),
                "kind": cp.kind,
                "answered_in": "swarmcloud",
                "answered_by": by,
                "verdict": record.verdict,
                "counted": counted,
            },
        )
        if not counted:
            label = f" (labelled for {record.on_behalf_of})" if record.on_behalf_of else ""
            _note(
                segment,
                f"{cp.kind} (round {round_}) was answered in SwarmCloud by {by or 'someone'}"
                f"{label}: {_said(record, at)}. It does not count ({reason}), so the "
                "checkpoint stays open in the Inbox for an approver to confirm it or request "
                "changes.",
            )
        else:
            _note(
                segment,
                f"{_outside_note(cp, round_, record, at)} The workflow has no revision step "
                "there and went on regardless; "
                f"nothing is re-run on its own. In the Inbox an approver chooses Redo from "
                f"'{console['redo_segment']}' (a new workflow: one more segment, about "
                f"${console['redo_cost_usd']:g}) or Continue.",
            )
        return
    wait.pop("console", None)
    wait["answered"] = {
        "verdict": record.verdict,
        "at": at,
        "replayed": False,
        "answer_id": record.answer_id,
        "answered_by": by,
        "on_behalf_of": record.on_behalf_of,
        "via": record.via,
        "seen_by": "tick",
    }
    cp.status = "approved" if approved else "changes_requested"
    cp.decided_at = record.answered_at or _now()
    cp.note = applied
    if member is not None:
        cp.decided_by = member.id
    elif ours and record.on_behalf_of:
        # Oracle's own post: the label is the one Oracle sent, for its Inbox user.
        cp.decided_by = await db.scalar(select(User.id).where(User.email == record.on_behalf_of))
    _set_wait(cp, wait)
    await audit.record(
        db,
        None,
        f"checkpoint.{cp.status}",
        "checkpoint",
        cp.id,
        {"run_id": str(run.id), "kind": cp.kind, "answered_in": "swarmcloud", "answered_by": by},
    )
    if ours:
        what = (
            f"{cp.kind} (round {round_}): SwarmCloud recorded Oracle's own answer "
            f"{record.verdict}{f' for {record.on_behalf_of}' if record.on_behalf_of else ''}, "
            "whose response was lost; Oracle follows it."
        )
    else:
        what = (
            _outside_note(cp, round_, record, at)
            + f" {by} is an Oracle {member.role if member else 'member'}, so it counts: "
            "Oracle follows that answer."
        )
    _note(segment, what)
    await _follow(
        db,
        run,
        cp,
        segment,
        segments,
        wf,
        entry,
        round_,
        approved,
        note=applied or "",
        note_by=by if applied else None,
        strict=False,
    )


async def _console_member(
    db: AsyncSession, cp: Checkpoint, answered_by: str | None, *, altered: bool = False
) -> tuple[User | None, str | None]:
    """The Oracle member who answered in SwarmCloud, and why their answer does not count
    (None when it does): matched by ``answered_by`` only, never one that redaction
    altered. Emails match case-insensitively; an exact match wins, and two members that
    differ only by case with neither exact is no match (the same answer every time)."""
    if not answered_by:
        return None, "SwarmCloud recorded no answerer"
    if altered:
        return None, "SwarmCloud's answerer could not be read as recorded"
    users = list(
        await db.scalars(
            select(User)
            .where(func.lower(User.email) == answered_by.lower())
            .order_by(User.email, User.id)
        )
    )
    exact = [u for u in users if u.email == answered_by]
    if exact:
        user = exact[0]
    elif len(users) == 1:
        user = users[0]
    elif users:
        return None, f"{answered_by} matches more than one Oracle member (by case)"
    else:
        return None, f"{answered_by} is not an Oracle member"
    if not has_role(user.role, cp.approver_role):  # type: ignore[arg-type]
        return user, (
            f"{answered_by} is an Oracle {user.role}, below the checkpoint's "
            f"{cp.approver_role} role"
        )
    return user, None


def _console_record(
    run: Run, segment: RunSegment, record: RecordedAnswer, at: str | None, revise: bool
) -> dict[str, Any]:
    """What the console said, as the Inbox shows it, with what a Redo would cost."""
    return {
        "answer_id": record.answer_id,
        "answered_by": record.answered_by,
        "on_behalf_of": record.on_behalf_of,
        "answered_at": at,
        "via": record.via,
        "verdict": record.verdict,
        "findings": list(record.findings),
        "revise": revise,
        "redo_segment": _flow(run).segment(segment.name).title,
        "redo_cost_usd": float(segment.estimate_usd or 0),
        "seen_at": _now().isoformat(),
    }


def _unreadable(
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    wf: dict[str, Any],
    wait: dict[str, Any],
    record: RecordedAnswer,
) -> None:
    """The wait was answered, and Oracle cannot read the verdict (the form artifact is
    missing, too large or odd, or the record was refused): shown in the Inbox, where an
    approver may approve (the workflow did what an approval needs, whatever was recorded)
    or Redo the segment as a new workflow. Read again each minute meanwhile."""
    round_ = int(wait.get("round") or 1)
    entry = _plan_entry(wf, segment.seq) or {}
    at = record.answered_at.isoformat() if record.answered_at else None
    first = (wait.get("console") or {}).get("needs") != "unreadable"
    console = _console_record(run, segment, record, at, round_ <= len(entry.get("revises") or []))
    console.update(
        counted=None, reason="the recorded verdict could not be read", needs="unreadable"
    )
    wait["console"] = console
    _set_wait(cp, wait)
    log.warning("run %s: wait %s answered, verdict not readable", run.id, wait.get("step_id"))
    if first:
        artifact = wait.get("artifact") or workflow.review_artifact(round_)
        _note(
            segment,
            f"{cp.kind} (round {round_}) was answered in SwarmCloud"
            f"{f' by {record.answered_by}' if record.answered_by else ''}, but Oracle could not "
            f"read the recorded verdict ({artifact}); it reads it again each minute. In the "
            "Inbox an approver can approve (the workflow already did what an approval needs) "
            f"or choose Redo from '{console['redo_segment']}' as a new workflow.",
        )


def _unread_console(
    run: Run,
    segment: RunSegment,
    wf: dict[str, Any] | None,
    wait: dict[str, Any],
    why: str,
    *,
    by: str | None = None,
    at: str | None = None,
    via: str | None = None,
) -> dict[str, Any]:
    """What the Inbox shows of a wait answered in SwarmCloud that Oracle has not read
    yet (``needs: unread``)."""
    round_ = int(wait.get("round") or 1)
    entry = (_plan_entry(wf, segment.seq) or {}) if wf is not None else {}
    earlier = wait.get("console") or {}
    console = _console_record(
        run, segment, RecordedAnswer(), None, round_ <= len(entry.get("revises") or [])
    )
    console.update(
        answered_by=by or earlier.get("answered_by"),
        answered_at=at or earlier.get("answered_at"),
        via=via or earlier.get("via"),
        counted=None,
        reason=f"Oracle has not read the recorded answer yet: {why}",
        needs="unread",
        seen_at=earlier.get("seen_at") or console["seen_at"],
    )
    return console


def _unread(
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    wf: dict[str, Any],
    wait: dict[str, Any],
    why: str,
) -> None:
    """W5 (owner, 2026-10-19): the wait was answered (its step SUCCEEDED) and Oracle
    cannot read the answer yet (SwarmCloud errors, a 404, a lagging record): it counts as
    unconfirmed, so the run's token is read-only until the answer is read, and the Inbox
    shows the checkpoint waiting to read it. Read again on every tick; once read, the
    approver rule applies. An answer already shown (one that did not count, or could not
    be read) stays as it is."""
    needs = (wait.get("console") or {}).get("needs")
    if needs not in (None, "unread"):
        return
    wait["console"] = _unread_console(run, segment, wf, wait, why)
    _set_wait(cp, wait)
    if needs is None:
        round_ = int(wait.get("round") or 1)
        _note(
            segment,
            f"{cp.kind} (round {round_}) was answered in SwarmCloud, and Oracle cannot read "
            f"the answer yet ({_clip(why)}). Until it does, the run's agents may read Oracle "
            "but not write to it; Oracle reads it again on every tick, then applies the "
            "approver rule.",
        )


def _recorded(
    record: RecordedAnswer, by: str | None, at: str | None, via: str | None, ours: bool
) -> dict[str, Any]:
    return {
        "answer_id": record.answer_id,
        "answered_by": by,
        "on_behalf_of": record.on_behalf_of,
        "answered_at": at,
        "via": via,
        "verdict": record.verdict,
        "findings": list(record.findings),
        "outside_oracle": not ours,
    }


def _said(record: RecordedAnswer, at: str | None) -> str:
    """What was answered in SwarmCloud, for a note: the verdict, findings, via and when."""
    findings = f" ({_clip('; '.join(record.findings))})" if record.findings else ""
    return (
        f"{record.verdict or 'it'}{findings} in SwarmCloud"
        f"{f' via {record.via}' if record.via else ''}{f' at {at}' if at else ''}"
    )


def _outside_note(cp: Checkpoint, round_: int, record: RecordedAnswer, at: str | None) -> str:
    who = record.answered_by or "someone"
    if record.on_behalf_of:
        who += f" for {record.on_behalf_of}"
    return (
        f"{cp.kind} (round {round_}) was decided outside Oracle: {who} answered "
        f"{_said(record, at)}."
    )


async def _wait_ended(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    status: WorkflowStatus,
    segments: list[RunSegment],
) -> None:
    """The workflow ended while a checkpoint waited in it, unanswered (W2b: the wait
    expired, or it ended otherwise; :func:`_watch_wait` read the wait first, and an
    answered one is followed, its finished steps harvested, instead). The checkpoint
    stays open in the Inbox; deciding it continues the run as a new workflow."""
    cp = await _waiting_on(db, run, wf)
    step = status.step(((cp.payload or {}).get("wait") or {}).get("step_id", "")) if cp else None
    expired = status.error_code == "expired" or (
        status.state == "failed" and step is not None and step.state != "SUCCEEDED"
    )
    if expired:
        note = workflow.ADVICE["expired"]
    else:
        note = (
            f"The workflow waiting on this run's checkpoint ended {status.state} in SwarmCloud"
            f"{f' ({status.error})' if status.error else ''}. The checkpoint stays open in the "
            "Inbox; deciding it continues the run as a new workflow."
        )
    if cp is not None:
        wait = dict((cp.payload or {}).get("wait") or {})
        wait["ended"] = "expired" if expired else status.state
        wait["ended_at"] = _now().isoformat()
        _set_wait(cp, wait)
        seq = (cp.payload or {}).get("segment_seq")
        target = next((s for s in segments if s.seq == seq), segments[0])
        _note(target, note)
    await _detach(db, run, cancel=False, state="expired" if expired else "ended")


async def tick(db: AsyncSession, principal: Principal | None = None) -> TickOut:
    """Advance every active run of the session's tenant; one transaction per run."""
    stats = _TickStats()
    errors: list[str] = []
    # Runs with a live workflow are watched whatever their state: a wait may be answered
    # outside Oracle or expire, the workflow may end in SwarmCloud, and one Oracle is
    # cancelling (even for a run that ended) has its cost read until the cancel holds.
    live = Run.knobs["workflow"]["state"].astext == "live"
    # And runs looking for a submission given up on, ended ones too: if it landed, it
    # spends until Oracle finds and cancels it.
    searching = Run.knobs.has_key("searches")
    ids = list(
        await db.scalars(
            select(Run.id)
            .where(Run.status.in_(("running", "paused_overrun")) | live | searching)
            .order_by(Run.started_at, Run.id)
        )
    )
    for run_id in ids:
        run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
        if run is None or not (
            run.status in ("running", "paused_overrun")
            or _live(run) is not None
            or (run.knobs or {}).get("searches")
        ):
            await db.rollback()
            continue
        stats.checked += 1
        try:
            await _tick_run(db, run, stats)
            await db.commit()
        except RuntimeUnavailable as exc:
            await db.rollback()
            errors.append(f"run {run_id}: {exc}")
        except Exception as exc:  # one broken run must not stop the others
            log.exception("tick failed for run %s", run_id)
            await db.rollback()
            errors.append(f"run {run_id}: {type(exc).__name__}")
    errors += stats.errors
    return TickOut(
        runs_checked=stats.checked,
        segments_finished=stats.finished,
        runs_advanced=stats.advanced,
        runs_paused=stats.paused,
        errors=errors,
    )


# --------------------------------------------------------------------------- decisions


async def decide_checkpoint(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    decision: str,
    note: str | None,
) -> None:
    run = await _get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    if cp is None:
        raise NotFound(f"checkpoint {checkpoint_id} not found")
    if not has_role(principal.role, cp.approver_role):  # type: ignore[arg-type]
        raise Forbidden(f"Requires the {cp.approver_role} role")
    if cp.status != "pending" or run.status != "awaiting_checkpoint":
        raise RunError(f"checkpoint is {cp.status}; run is {run.status}")
    note = (note or "").strip() or None
    wait = (cp.payload or {}).get("wait") or {}
    redo = False
    if decision in ("confirm", "redo", "continue"):
        decision, note, redo = _console_choice(cp, wait, decision, note)
        if decision == "confirm":
            # A console change request where the workflow has no revision step: now
            # counted, it waits for Redo or Continue.
            console = {
                **wait["console"],
                "counted": True,
                "needs": "redo_or_continue",
                "confirmed_by": str(principal.id),
                "confirmed_at": _now().isoformat(),
            }
            cp.payload = {**(cp.payload or {}), "wait": {**wait, "console": console}}
            await audit.record(
                db,
                principal,
                "checkpoint.console_confirmed",
                "checkpoint",
                cp.id,
                {"run_id": str(run.id), "kind": cp.kind, "answered_by": console["answered_by"]},
            )
            await db.commit()
            return
    if decision == "changes_requested" and not note:
        raise Invalid("say what to change: a note is required to request changes")
    cp.status = decision
    cp.decided_by = principal.id
    cp.decided_at = _now()
    cp.note = note
    segments = await _segments(db, run.id)
    seq = (cp.payload or {}).get("segment_seq")
    segment = next(s for s in segments if s.seq == seq)
    await audit.record(
        db,
        principal,
        f"checkpoint.{decision}",
        "checkpoint",
        cp.id,
        {"run_id": str(run.id), "kind": cp.kind},
    )
    wf = _drivable(run)
    if redo:
        title = _flow(run).segment(segment.name).title
        _note(
            segment,
            f"An approver chose Redo from '{title}' at {cp.kind}: Oracle cancels the run's "
            "workflow and runs the segment again as a new workflow with the findings (one more "
            f"segment, about ${float(segment.estimate_usd or 0):g}).",
        )
        if wf is not None and not await _detach(db, run, cancel=True, state="redo"):
            raise _unconfirmed("redo the segment")
    elif wf is not None and wait.get("workflow_id") == wf["id"]:
        try:
            posted = await _decide_in_workflow(db, run, cp, segment, segments, wf, principal)
        except _PostNotFound as exc:
            await _count_post_404(db, run_id, cp.id, exc.cause)
            raise
        except _Unread as exc:
            await _hold_unread(db, run_id, cp.id, exc)
            raise
        if posted:
            if _cancel_pending(run):
                raise _unconfirmed("go on with the decision")
            await db.commit()
            return
    run.status = "running"
    if decision == "approved":
        await _next(db, run, segment, segments)
    else:
        segment.status = "pending"
        await _submit(db, run, segment, segments, change_request=note)
    if _cancel_pending(run):
        # Nothing was submitted after a workflow SwarmCloud may still be running.
        raise _unconfirmed("continue the run as a new workflow")
    await db.commit()


class _PostNotFound(Unavailable):
    """An answer post SwarmCloud answered with a 404 that proves nothing (not its
    not_found envelope): nothing recorded, "decide again", and counted."""

    def __init__(self, cause: RuntimeUnavailable) -> None:
        super().__init__(
            f"SwarmCloud did not confirm the decision ({cause}); decide again, it is safe to repeat"
        )
        self.cause = cause


class _Unread(Unavailable):
    """The wait was answered (409 already_answered, or the answer the Inbox showed) and
    Oracle cannot read the recorded answer: "decide again", nothing recorded, and the
    run's token is held read-only until it is read (W5; :func:`_hold_unread`)."""

    def __init__(
        self,
        message: str,
        *,
        needs: str,
        by: str | None = None,
        at: str | None = None,
        via: str | None = None,
    ) -> None:
        super().__init__(message)
        self.needs, self.by, self.at, self.via = needs, by, at, via


async def _hold_unread(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, exc: _Unread
) -> None:
    """W5 (owner, 2026-10-19): an answered checkpoint Oracle cannot read yet counts as
    unconfirmed. The decision itself rolls back; the hold is written on its own (the
    checkpoint shows in the Inbox waiting to read the answer, the tick reads it again),
    unless the checkpoint already shows what the console recorded."""
    await db.rollback()
    run = await _get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    wait = dict(((cp.payload or {}).get("wait") or {}) if cp is not None else {})
    if cp is None or cp.status != "pending" or not wait:
        return
    if ((wait.get("console") or {}).get("needs")) not in (None, "unread"):
        return
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == (cp.payload or {}).get("segment_seq")), None)
    if segment is None:
        return
    why = "SwarmCloud did not serve it" if exc.needs == "unread" else "its verdict is unreadable"
    console = _unread_console(
        run, segment, _live(run), wait, why, by=exc.by, at=exc.at, via=exc.via
    )
    if exc.needs == "unreadable":
        console.update(reason="the recorded verdict could not be read", needs="unreadable")
    wait["console"] = console
    _set_wait(cp, wait)
    _note(
        segment,
        f"{cp.kind} was already answered in SwarmCloud, and Oracle could not read the answer "
        f"({why}). Until it does, the run's agents may read Oracle but not write to it; "
        "Oracle reads it again on every tick, and an approver may decide again.",
    )
    await db.commit()


async def _count_post_404(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, cause: RuntimeUnavailable
) -> None:
    """Count a 404 on an answer post (the decision itself rolled back): past
    :data:`NOT_FOUND_TRIES` for the checkpoint, the run shows in the Inbox with Cancel."""
    await db.rollback()
    run = await _get_run(db, run_id, lock=True)
    post = (run.knobs or {}).get("post_404") or {}
    same = post.get("checkpoint_id") == str(checkpoint_id)
    tries = (int(post.get("tries") or 0) if same else 0) + 1
    _set_knob(
        run,
        "post_404",
        {
            "checkpoint_id": str(checkpoint_id),
            "tries": tries,
            "error": _shown(cause),
            "at": _now().isoformat(),
        },
    )
    await db.commit()
    if tries >= NOT_FOUND_TRIES:
        raise Unavailable(
            f"SwarmCloud did not confirm the decision: it answered HTTP 404 {tries} times "
            f"without saying the wait does not exist ({_shown(cause)}). Decide again later, "
            "or in the Inbox, Cancel ends the run."
        ) from None


def _console_choice(
    cp: Checkpoint, wait: dict[str, Any], choice: str, note: str | None
) -> tuple[str, str | None, bool]:
    """An Inbox choice about what SwarmCloud's console recorded (W5), as a decision:
    (decision, note, redo). ``confirm`` takes an answer that did not count as the decision
    (a change request where the workflow has no revision step comes back as ``confirm``:
    it then waits for Redo or Continue); ``redo`` re-runs the segment as a new workflow
    with the findings; ``continue`` follows the workflow, which went on regardless."""
    console = wait.get("console") or {}
    needs = console.get("needs")
    findings = "; ".join(_console_findings(console))
    with_note = "\n\n".join(x for x in (findings, note) if x) or None
    if choice == "confirm":
        if needs != "confirm" or console.get("verdict") not in (MERGE, NOT_YET):
            raise Invalid("nothing recorded in SwarmCloud's console waits to be confirmed here")
        if console["verdict"] == MERGE:
            return "approved", note, False
        if console.get("revise"):
            return "changes_requested", with_note, False
        return "confirm", None, False
    if needs not in ("redo_or_continue", "unreadable", "unread"):
        raise Invalid(
            f"{choice} answers a change request recorded in SwarmCloud's console that the "
            "workflow has no revision step for (or one Oracle could not read); there is none "
            "here"
        )
    if choice == "redo":
        if not with_note:
            raise Invalid("say what to change: a note is required to redo the segment")
        return "changes_requested", with_note, True
    return "approved", note, False


def _left(wf: dict[str, Any]) -> float:
    """Seconds left of the live workflow's run credential."""
    try:
        expires = datetime.fromisoformat(wf["expires_at"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    return (expires - _now()).total_seconds()


def _duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    return f"{hours} h {rest // 60} min" if hours else f"{rest // 60} min {rest % 60} s"


async def _email(db: AsyncSession, principal: Principal) -> str | None:
    """The deciding user's email, recorded by SwarmCloud as ``on_behalf_of``."""
    if principal.user_id is None:
        return None
    user = await db.get(User, principal.user_id)
    return user.email if user is not None else None


async def _decide_in_workflow(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    principal: Principal,
) -> bool:
    """Post an Inbox decision to the wait in the live workflow. Returns False when the
    run continues as a new workflow instead (the caller does that, carrying the decision):
    the workflow has no step for the decision, too little of the credential is left for
    the agent steps after the wait (the tail rule), the wait is closed, SwarmCloud refuses
    the answer, or it holds a different verdict (Oracle's decision is then a correction).
    In every such case the live workflow is cancelled first, so a segment never runs in
    two workflows. Raises Unavailable only when nothing was recorded and the same decision
    may simply be sent again."""
    settings = get_runtime_settings()
    wait = dict((cp.payload or {}).get("wait") or {})
    entry = _plan_entry(wf, segment.seq) or {}
    round_ = int(wait.get("round") or 1)
    approved = cp.status == "approved"
    answered = bool(wait.get("console")) and (approved or round_ <= len(entry.get("revises") or []))
    if answered:
        # Answered in SwarmCloud already (the Inbox shows it): nothing to post, and the
        # steps after the wait already have the credential they had; the recorded
        # answer is followed, or corrected.
        verdict = MERGE if approved else NOT_YET
        return await _already_answered(db, run, cp, segment, segments, wf, wait, verdict, None)
    if not approved and round_ > len(entry.get("revises") or []):
        # The workflow's next steps assume approval: re-run the segment on its own.
        _note(
            segment,
            f"Changes requested at {cp.kind} (round {round_}): the workflow had no revision "
            "step for it, so Oracle cancelled it and re-runs the segment as a new workflow.",
        )
        if not await _detach(db, run, cancel=True, state="cancelled"):
            raise _unconfirmed("re-run the segment")
        return False
    left = _left(wf)
    steps = workflow.agent_steps_after(wf.get("segments") or [], segment.seq, approved, round_)
    tail = workflow.tail_seconds(steps, settings)
    if left < tail:
        _note(
            segment,
            f"Decided at {cp.kind} with {_duration(left)} of the run's credential left, under "
            f"the {_duration(tail)} tail that the {steps} agent step(s) after the wait need: "
            "Oracle did not post the decision to SwarmCloud, cancelled the waiting workflow "
            "and continued as a new workflow with a fresh run token.",
        )
        if not await _detach(db, run, cancel=True, state="tail"):
            raise _unconfirmed("continue the run as a new workflow")
        return False
    payload: dict[str, Any] = (
        {"verdict": MERGE, "findings": []}
        if approved
        else {"verdict": NOT_YET, "findings": [cp.note] if cp.note else []}
    )
    on_behalf_of = await _email(db, principal)
    runtime = get_runtime()
    try:
        answer = await runtime.answer(
            wf["id"],
            wait["step_id"],
            answer_id=str(cp.id),
            payload=payload,
            on_behalf_of=on_behalf_of,
        )
    except RuntimeUnavailable as exc:
        if exc.code == "already_answered":
            return await _already_answered(
                db, run, cp, segment, segments, wf, wait, payload["verdict"], exc
            )
        if _not_found(exc):
            # Proves nothing, and is counted (decide_checkpoint): past NOT_FOUND_TRIES the
            # run shows in the Inbox with Cancel.
            raise _PostNotFound(exc) from None
        if exc.retryable:
            # Nothing was recorded: the same decision is safe to send again (same
            # answer_id, same body).
            raise Unavailable(
                f"SwarmCloud did not confirm the decision ({exc}); decide again, it is safe "
                "to repeat"
            ) from None
        # Refused (the wait is closed, a person is required, or another refusal): not
        # posted, so the run continues as a new workflow with the decision.
        fallback = (
            f"SwarmCloud refused Oracle's answer to {cp.kind} ({exc}), so the decision was not "
            "posted: Oracle cancelled the workflow and continued the run as a new workflow "
            "from the Inbox decision."
        )
        _note(segment, workflow.advice(exc.code, fallback))
        if not await _detach(db, run, cancel=True, state=_shown(exc.code) or "refused"):
            raise _unconfirmed("continue the run as a new workflow") from None
        return False
    _set_knob(run, "post_404", None)
    wait["answered"] = {
        "verdict": payload["verdict"],
        "at": _now().isoformat(),
        "replayed": answer.replayed,
        "answer_id": str(cp.id),
        "on_behalf_of": on_behalf_of,
        "via": "mcp",
    }
    _set_wait(cp, wait)
    if not await _follow(
        db, run, cp, segment, segments, wf, entry, round_, approved, note_by=on_behalf_of
    ):
        raise _unconfirmed("end the run")
    return True


async def _already_answered(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    wait: dict[str, Any],
    verdict: str,
    exc: RuntimeUnavailable | None,
) -> bool:
    """409 already_answered: Oracle's post was not recorded, but the wait was answered
    (someone in SwarmCloud's console, or an earlier, different post of Oracle's whose
    response was lost), and the workflow already goes on with that first answer.

    Oracle follows the workflow whenever it ran what the Inbox decision needs: the same
    verdict, or an approval over a recorded NOT_YET (at a checkpoint that is not the
    last, the next segment depends on the wait whatever its verdict, so the workflow went
    on into it; at the last, the approval ends the run on the draft it showed and stops
    the workflow's revision). Only a change request over a recorded MERGE needs work the
    workflow did not do: that is a correction, so the workflow is cancelled and the run
    continues as a new workflow carrying it. A verdict Oracle cannot read is never taken
    for either: it says "decide again", unless the decision is an approval, which needs
    nothing the workflow did not do whatever was recorded (or the approver chooses Redo).

    ``exc``: the 409 (None when the Inbox already showed the recorded answer)."""
    round_ = int(wait.get("round") or 1)
    artifact = wait.get("artifact") or workflow.review_artifact(round_)
    record = await _read_recorded(cp, wf, wait, artifact)
    detail = exc.detail if exc is not None else {}
    console = wait.get("console") or {}
    by = record.answered_by or _shown(detail.get("answered_by")) or console.get("answered_by")
    at = (
        record.answered_at.isoformat()
        if record.answered_at
        else _shown(detail.get("answered_at")) or console.get("answered_at")
    )
    via = record.via or _shown(detail.get("via")) or console.get("via")
    ours = record.answer_id == str(cp.id) and record.by_oracle
    approved = verdict == MERGE
    if record.verdict is None and not approved:
        title = _flow(run).segment(segment.name).title
        raise _Unread(
            f"SwarmCloud says {cp.kind} was already answered, but Oracle could not read the "
            f"recorded verdict ({artifact}); decide again, it is safe to repeat, or choose "
            f"Redo from '{title}' to run it again as a new workflow",
            needs="unreadable" if record.answered else "unread",
            by=by,
            at=at,
            via=via,
        )
    wait.pop("console", None)
    wait["recorded"] = _recorded(record, by, at, via, ours)
    if not ours:
        _note(segment, _outside_note(cp, round_, replace(record, answered_by=by, via=via), at))
    if record.verdict is None:
        _note(
            segment,
            f"Oracle could not read the verdict SwarmCloud recorded for {cp.kind} (round "
            f"{round_}); the Inbox approved, which needs no work the workflow did not do "
            "whatever was recorded, so the run follows the workflow.",
        )
    if record.verdict == verdict or approved:
        # What SwarmCloud recorded is what the revision (if any) applies; the Inbox
        # note, when it differs, is kept apart as not applied. No recorded findings
        # means none were applied, never the Inbox note.
        applied = "; ".join(record.findings) or None
        not_applied = cp.note if not approved and cp.note and cp.note != applied else None
        if record.verdict is None:
            pass
        elif record.verdict == verdict:
            _note(
                segment,
                f"SwarmCloud already held a {verdict} answer for {cp.kind} (round {round_}), "
                "the same verdict as the Inbox decision, so the run follows the workflow on "
                "it. SwarmCloud kept the earlier wording: its findings, notes and on_behalf_of "
                "stand, not this decision's.",
            )
        else:
            last = bool(wf.get("segments")) and wf["segments"][-1].get("seq") == segment.seq
            how = (
                "the run ends on the draft the checkpoint showed, and Oracle stops the "
                "workflow's revision"
                if last
                else "the next segment depends on this wait whatever its verdict, so the "
                "workflow went on into it, as the approval needs, and Oracle follows it"
            )
            _note(
                segment,
                f"SwarmCloud's console recorded NOT_YET for {cp.kind} (round {round_})"
                f" ({by or 'someone'}{f' via {via}' if via else ''}"
                f"{': ' + _clip(applied) if applied else ''}), but the Inbox approved. The "
                f"approval needs no work the workflow did not do: {how}.",
            )
        wait["answered"] = {
            "verdict": record.verdict,
            "decision": verdict,
            "at": at or _now().isoformat(),
            "replayed": False,
            "answer_id": record.answer_id,
            "answered_by": by,
            "on_behalf_of": record.on_behalf_of,
            "via": via,
            "kept_earlier": True,
            "not_applied": not_applied,
        }
        _set_wait(cp, wait)
        entry = _plan_entry(wf, segment.seq) or {}
        if not await _follow(
            db,
            run,
            cp,
            segment,
            segments,
            wf,
            entry,
            round_,
            approved,
            note=applied or "",
            note_by=by if applied else None,
            not_applied=not_applied,
            stop_rest=record.verdict != verdict,
        ):
            raise _unconfirmed("end the run")
        return True
    _note(
        segment,
        f"SwarmCloud held {record.verdict} for {cp.kind} (round {round_}), but the latest "
        f"Inbox decision is {verdict}, which needs a revision the workflow did not run: Oracle "
        "takes its decision as a correction, cancelled the workflow (which had gone on with "
        "the recorded answer) and continued as a new workflow carrying the decision.",
    )
    _set_wait(cp, wait)
    if not await _detach(db, run, cancel=True, state="corrected"):
        raise _unconfirmed("continue the run as a new workflow")
    return False


async def _read_recorded(
    cp: Checkpoint, wf: dict[str, Any], wait: dict[str, Any], artifact: str
) -> RecordedAnswer:
    """The answer the wait holds, read twice at most for its verdict; still unreadable,
    it comes back without one (never taken for a correction: the caller says "decide
    again", or follows an approval)."""
    record = RecordedAnswer()
    for _ in range(2):
        try:
            record = await get_runtime().answer_record(wf["id"], wait["step_id"], artifact)
        except RuntimeUnavailable as read:
            if read.retryable:
                # Answered, not read yet (W5): held until it is (decide_checkpoint).
                raise _Unread(
                    f"SwarmCloud says {cp.kind} was already answered but did not show the "
                    f"answer ({read}); decide again, it is safe to repeat",
                    needs="unread",
                ) from None
            record = RecordedAnswer()
        if record.verdict is not None:
            return record
    return record


async def _follow(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    entry: dict[str, Any],
    round_: int,
    approved: bool,
    *,
    note: str | None = None,
    note_by: str | None = None,
    not_applied: str | None = None,
    stop_rest: bool = False,
    strict: bool = True,
) -> bool:
    """The wait is answered with the run's verdict: keep following the workflow.

    ``note``/``note_by``: the findings the revision applies and whose they are; None for
    the Inbox note (Oracle's own answer was posted), "" for none (SwarmCloud recorded no
    findings: the Inbox note is not what was applied). ``stop_rest``: after an approval at the
    last checkpoint, the workflow's rest is work nobody uses (a recorded NOT_YET's
    revision). Returns False, when ``strict`` (the Inbox decision path), if stopping the
    rest was not confirmed: the caller says "decide again". Otherwise the run goes on and
    the tick cancels the workflow again."""
    run.status = "running"
    last = wf["segments"][-1].get("seq") == segment.seq if wf.get("segments") else True
    if approved:
        if last:
            # What follows a MERGE in the last round's shape is pass-through: stop it.
            more = round_ < len(entry.get("reviews") or []) or stop_rest
            if not await _detach(db, run, cancel=more, state="ended") and strict:
                return False
        await _next(db, run, segment, segments)
        return True
    # NOT_YET: the revision step runs in the workflow, then the next round's wait.
    entry["round"] = round_ + 1
    _set_knob(
        run,
        "workflow",
        {
            **wf,
            "segments": [entry if e.get("seq") == segment.seq else e for e in wf["segments"]],
        },
    )
    art = _art(segment)
    art["attempts"].append(
        {
            "attempt": len(art["attempts"]) + 1,
            "workflow_id": wf["id"],
            "submitted_at": _now().isoformat(),
            "cost_usd": 0,
            "note": cp.note if note is None else (note or None),
            "note_by": note_by,
            "not_applied": not_applied,
            "state": "running",
            "label": wf.get("label"),
            "mode": "workflow",
        }
    )
    _set_art(segment, art)
    segment.status = "running"
    segment.finished_at = None
    return True


def _attach_for_cancel(
    run: Run,
    segment: RunSegment,
    workflow_id: str | None,
    lookup: str | None = None,
    lookup_since: str | None = None,
    lookup_until: str | None = None,
) -> dict[str, Any]:
    """A workflow Oracle does not drive as the run's (one per segment, or a lost
    submission), attached so that cancelling the run cancels it the same way: retried by
    the tick, its cost counted, given up on SwarmCloud's 404. ``lookup``: the label to
    find it by while its id is unknown, and ``lookup_since`` when it was submitted (the
    search ends at an older task, and moves to the background past the lookup cap, until
    ``lookup_until``, its credential's end)."""
    last = (_art(segment)["attempts"] or [{}])[-1]
    wf = {
        "id": workflow_id,
        "label": lookup or last.get("label"),
        # When it was sent: a search for it is bounded from then (_credential_end).
        "submitted_at": lookup_since or (last.get("submitted_at") if workflow_id else None),
        "lookup": lookup,
        "lookup_since": lookup_since,
        "lookup_until": lookup_until,
        "state": "live",
        "start_seq": segment.seq,
        "mode": "segment",
        "segments": [],
    }
    _set_knob(run, "workflow", wf)
    return wf


def _may_manage(principal: Principal, run: Run) -> bool:
    return principal.role == "owner" or (
        has_role(principal.role, "approver") and principal.id == run.created_by
    )


def _cancel_stuck(run: Run) -> dict[str, Any] | None:
    """The live workflow whose cancel is past :data:`NOT_FOUND_TRIES` 404s that prove
    nothing (in the Inbox with Cancel), if any."""
    wf = _live(run)
    return wf if wf is not None and (wf.get("cancel_pending") or {}).get("stuck") else None


async def _stop_cancelling(db: AsyncSession, run: Run) -> bool:
    """Stop cancelling a workflow whose cancel is stuck on 404s (P3d, owner 2026-10-19):
    the cancel calls stop and the Inbox item clears, but the workflow is never detached
    from the run's spend. It goes on ``searches`` with its id, so its status and cost are
    still read (on every tick) until SwarmCloud says it ended, its cost counted in the
    run's spend against the ceiling. A run that has not ended ends (:func:`_end_stopped`):
    no second workflow starts for that segment."""
    wf = _cancel_stuck(run)
    if wf is None:
        return False
    pending = wf.get("cancel_pending") or {}
    stopped = (
        f"An approver stopped cancelling workflow {wf.get('id')}: SwarmCloud answered HTTP "
        f"404 {pending.get('not_found')} times without saying it does not exist "
        f"({pending.get('error')}). Oracle no longer cancels it, but keeps reading its status "
        "and cost on every tick until it ends, and counts its spend on the run. If it still "
        "runs, cancel it in SwarmCloud's console."
    )
    log.warning("run %s: %s", run.id, stopped)
    _search_for(
        run,
        label=wf.get("label") or wf["id"],
        seq=wf.get("start_seq"),
        submitted_at=wf.get("submitted_at") or pending.get("since"),
        until=_credential_end(wf),
        why="stopped",
        workflow_id=wf["id"],
        cancel=False,
    )
    segments = await _segments(db, run.id)
    target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if target is not None or segments:
        _note(target or segments[0], stopped)
    await _end_workflow(db, run, wf, pending.get("state") or "cancelled", stopped=True)
    if run.status not in FINAL:
        await _end_stopped(db, run, segments, wf)
    return True


async def _end_stopped(
    db: AsyncSession, run: Run, segments: list[RunSegment], wf: dict[str, Any]
) -> None:
    """P3d (owner, 2026-10-19): Stop cancelling on a run that has not ended ends the run
    (cancelled, the reason recorded). The stopped workflow stays on ``searches``; a lost
    submission of a pending segment is looked for in the background, as Cancel does."""
    for s in segments:
        if s.status not in ("running", "pending"):
            continue
        lost = _art(s).get("lost")
        if s.status == "pending" and isinstance(lost, dict) and lost.get("label"):
            _search_for(
                run,
                label=lost["label"],
                seq=s.seq,
                submitted_at=lost.get("submitted_at"),
                until=_credential_end(lost),
                why="cancel",
            )
        s.status = "cancelled"
        s.finished_at = s.finished_at or _now()
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run ended: an approver stopped cancelling its workflow."
            cp.decided_at = _now()
    _set_knob(run, "stuck_lookup", None)
    _set_knob(run, "post_404", None)
    run.status = "cancelled"
    run.finished_at = _now()
    run.error = (
        f"Stop cancelling ended the run: Oracle no longer cancels workflow {wf.get('id')}, "
        "and its spend still counts on the run until SwarmCloud stops it."
    )
    await revoke_run_tokens(db, run.id)


async def stop_cancelling(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Stop cancelling from the Inbox (a cancel stuck on 404s, whatever the run's state):
    see :func:`_stop_cancelling`."""
    run = await _get_run(db, run_id, lock=True)
    if not _may_manage(principal, run):
        raise Forbidden("Only an owner or the approver who created the run can stop this")
    ended = run.status not in FINAL
    if not await _stop_cancelling(db, run):
        raise RunError("nothing to stop: no cancel of this run waits on SwarmCloud's 404s")
    await audit.record(db, principal, "run.cancel_stopped", "run", run.id, {"ended_run": ended})
    await db.commit()


async def retry_lookup(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Retry lookup from the Inbox: a searched workflow whose cost is unknown (its status
    does not read) is read now, not at its next rest; read, it is followed as before."""
    run = await _get_run(db, run_id, lock=True)
    if not _may_manage(principal, run):
        raise Forbidden("Only an owner or the approver who created the run can retry this")
    if _cost_unknown(run) is None:
        raise RunError("nothing to look up: no workflow of this run has an unknown cost")
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    for e in entries:
        if e.get("id") and e.get("cost_unknown"):
            e.pop("read_at", None)
    _set_knob(run, "searches", entries)
    await _search_earlier(db, run, await _segments(db, run.id), _TickStats())
    await audit.record(db, principal, "run.lookup_retried", "run", run.id, {})
    await db.commit()


async def cancel(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Cancel the run: its workflows are cancelled (a lost submission looked up first, and
    cancelled if it landed), its checkpoints skipped. SwarmCloud is called without the
    run's row lock; the run is then read again under it and changed as it is now (what
    appeared meanwhile is called about under the lock, and a lookup is reused only for
    the very submission it was made for: its label and when it was sent). A cancel stuck
    on 404s is tried once more; still not confirmed, Oracle stops cancelling it and keeps
    reading its cost (:func:`_stop_cancelling`). On an ended run, Cancel is Stop
    cancelling."""
    run = await _get_run(db, run_id)
    if not _may_manage(principal, run):
        raise Forbidden("Only an owner or the approver who created the run can cancel it")
    if run.status in FINAL and _cancel_stuck(run) is None:
        raise RunError(f"run is already {run.status}")
    runtime = get_runtime()
    # What to ask SwarmCloud, read without the lock.
    wf = _live(run)
    ids: list[str] = []
    if wf is not None and wf.get("id") and run.status not in FINAL:
        ids.append(wf["id"])  # a stuck cancel too: one more try
    lookups: dict[tuple[str, str | None], str | None] = {}
    for s in await _segments(db, run.id):
        lost = _art(s).get("lost")
        if s.status == "running" and s.swarm_workflow_id:
            ids.append(s.swarm_workflow_id)
        elif s.status == "pending" and isinstance(lost, dict) and lost.get("label"):
            lookups[(lost["label"], lost.get("submitted_at"))] = lost.get("submitted_at")
    await db.rollback()
    found: dict[tuple[str, str | None], str | None | RuntimeUnavailable] = {}
    for key, since in lookups.items():
        try:
            found[key] = await runtime.find_by_label(key[0], since=_parse_at(since))
        except RuntimeUnavailable as exc:
            log.warning("run %s: looking up %s: %s", run_id, key[0], exc)
            found[key] = exc
        if isinstance(found[key], str):
            ids.append(found[key])  # type: ignore[arg-type]
    done = {i: await _cancel_call({"id": i}) for i in dict.fromkeys(ids)}

    # Under the lock, as the run is now.
    run = await _get_run(db, run_id, lock=True)
    if run.status in FINAL:
        if not await _stop_cancelling(db, run):
            raise RunError(f"run is already {run.status}")
        await audit.record(db, principal, "run.cancel_stopped", "run", run.id, {})
        await db.commit()
        return
    segments = await _segments(db, run.id)
    wf = _live(run)
    for s in segments:
        if s.status == "running" and wf is not None and s.swarm_workflow_id == wf["id"]:
            s.status = "cancelled"
            s.finished_at = _now()
        elif s.status == "running" and s.swarm_workflow_id:
            if wf is None:
                # One workflow per segment: cancelled like the run's workflow below, and
                # cancelled again by the tick (its cost read) until SwarmCloud confirms.
                wf = _attach_for_cancel(run, s, s.swarm_workflow_id)
            else:
                out = done.get(s.swarm_workflow_id) or await _cancel_call(
                    {"id": s.swarm_workflow_id}
                )
                if out.final is not None:
                    _cost_on(
                        run, segments, {"seq": s.seq, "id": s.swarm_workflow_id}, out.final.cost_usd
                    )
                attempt = _current_attempt(_art(s), s)
                label = attempt.get("label") or s.swarm_workflow_id
                if out.error is not None and not out.ended and not out.gone:
                    s.error = f"cancel not confirmed by the runtime: {_shown(out.error)}"
                    # Not attached (one workflow is): cancelled and costed in the
                    # background until SwarmCloud confirms.
                    _search_for(
                        run,
                        label=label,
                        seq=s.seq,
                        submitted_at=attempt.get("submitted_at"),
                        until=None,
                        why="cancel",
                        workflow_id=s.swarm_workflow_id,
                    )
                elif not out.gone and (out.final is None or not out.final.terminal):
                    # Confirmed, its status not read or not terminal yet (winding down):
                    # read in the background until it ends, its last cost counted.
                    _search_for(
                        run,
                        label=label,
                        seq=s.seq,
                        submitted_at=attempt.get("submitted_at"),
                        until=None,
                        why="cancel",
                        workflow_id=s.swarm_workflow_id,
                        cancelled=True,
                    )
            s.status = "cancelled"
            s.finished_at = _now()
        elif s.status == "pending":
            lost = _art(s).get("lost")
            if isinstance(lost, dict) and lost.get("label"):
                # A submission whose answer was lost may have landed: found, it is
                # cancelled; not looked up yet, the tick looks again and cancels it. Never
                # left behind: what cannot be attached is searched for in the background.
                label, since = lost["label"], lost.get("submitted_at")
                key = (label, since)
                if key in found:
                    result = found[key]
                else:
                    # Lost since Oracle looked (or sent again under the same label): the
                    # earlier lookup says nothing of it, so it is looked up now.
                    try:
                        result = await runtime.find_by_label(label, since=_parse_at(since))
                    except RuntimeUnavailable as exc:
                        result = exc
                until = _credential_end(lost)
                if isinstance(result, str):
                    if wf is None:
                        wf = _attach_for_cancel(run, s, result, label, since, until)
                        _adopt(segments, wf)
                    else:
                        _add_attempt(s, result, label, "cancelled", mode=lost.get("mode"))
                        _search_for(
                            run,
                            label=label,
                            seq=s.seq,
                            submitted_at=since,
                            until=until,
                            why="cancel",
                            workflow_id=result,
                        )
                elif result is not None:  # neither found nor ruled out
                    if wf is None:
                        wf = _attach_for_cancel(run, s, None, label, since, until)
                    else:
                        _search_for(
                            run,
                            label=label,
                            seq=s.seq,
                            submitted_at=since,
                            until=until,
                            why="cancel",
                        )
            s.status = "cancelled"
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run cancelled."
            cp.decided_at = _now()
    _set_knob(run, "stuck_lookup", None)
    # A cancel SwarmCloud does not confirm leaves the workflow attached: the tick cancels
    # it again and counts its cost. One stuck on 404s that this one more try did not
    # confirm either: Oracle stops cancelling it, and keeps reading its cost.
    await _finish(db, run, "cancelled", state="cancelled", done=done)
    await _stop_cancelling(db, run)
    if _cancel_pending(run) and segments:
        _note(
            segments[0],
            "Run cancelled; SwarmCloud did not confirm cancelling its workflow yet, so Oracle "
            "cancels it again on every tick and keeps counting its cost.",
        )
    await audit.record(db, principal, "run.cancelled", "run", run.id, {})
    await db.commit()


async def retry(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Retry from the Inbox: a lost submission Oracle could neither find nor rule out
    past the lookup cap. Looked up once more (without the run's row lock, then the run
    is read again under it: changed meanwhile, nothing is retried); found, it is the
    segment's workflow; else the segment is submitted again under a new key. The approver
    accepts that the lost one, if it landed, may run too (the web asks first: it can
    start a paid duplicate run): its run token is revoked, and Oracle keeps looking for
    it in the background (:func:`_search_earlier`) to cancel it and count its cost."""
    run = await _get_run(db, run_id)
    if not _may_manage(principal, run):
        raise Forbidden("Only an owner or the approver who created the run can retry it")
    stuck = (run.knobs or {}).get("stuck_lookup")
    if run.status != "running" or not isinstance(stuck, dict):
        raise RunError("nothing waits for a retry: no lost submission is past its lookup cap")
    segment = next((s for s in await _segments(db, run.id) if s.seq == stuck.get("seq")), None)
    lost = _art(segment).get("lost") if segment is not None else None
    if segment is None or segment.status != "pending" or not isinstance(lost, dict):
        # Resolved, as read without the lock: checked again under it before the marker
        # is cleared (the tick may have lost the submission again meanwhile).
        run = await _get_run(db, run_id, lock=True)
        now = (run.knobs or {}).get("stuck_lookup")
        segment = next(
            (s for s in await _segments(db, run.id, fresh=True) if s.seq == (now or {}).get("seq")),
            None,
        )
        lost = _art(segment).get("lost") if segment is not None else None
        if now == stuck and (
            segment is None or segment.status != "pending" or not isinstance(lost, dict)
        ):
            _set_knob(run, "stuck_lookup", None)
            await db.commit()
            raise RunError("nothing waits for a retry: the submission was resolved")
        await db.rollback()
        raise RunError(
            "nothing was retried: the run changed while Oracle read it; look at it again"
        )
    label, since = lost["label"], lost.get("submitted_at")
    await db.rollback()
    runtime = get_runtime()
    found: str | None = None
    try:
        found = await runtime.find_by_label(label, since=_parse_at(since))
    except RuntimeUnavailable as exc:
        log.warning("run %s: retry: %s still not resolved: %s", run_id, label, exc)

    # Under the lock, as the run is now.
    run = await _get_run(db, run_id, lock=True)
    stuck = (run.knobs or {}).get("stuck_lookup")
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == (stuck or {}).get("seq")), None)
    art = _art(segment) if segment is not None else {}
    lost = art.get("lost")
    if (
        run.status != "running"
        or not isinstance(stuck, dict)
        or stuck.get("label") != label
        or segment is None
        or segment.status != "pending"
        or not isinstance(lost, dict)
        or lost.get("label") != label
    ):
        raise RunError(
            f"nothing waits for a retry: the run changed while Oracle looked for {label} "
            f"(it is {run.status}); look at it again"
        )
    _set_knob(run, "stuck_lookup", None)
    if found:
        art.pop("lost", None)
        _accepted(run, segment, art, found, lost, art.pop("pending_note", None), runtime)
    else:
        art.pop("lost", None)
        art["abandoned"] = [*(art.get("abandoned") or []), label]
        _search_for(
            run,
            label=label,
            seq=segment.seq,
            submitted_at=since,
            until=_credential_end(lost),
            why="retry",
        )
        _note_art(
            art,
            f"Retried from the Inbox by an approver: submission {label} was neither found "
            "nor ruled out, so the segment was submitted again under a new key. If the lost "
            "one landed it runs without Oracle's data (its token is revoked) until Oracle "
            f"finds it: Oracle looks for it every {_duration(STUCK_LOOKUP_SECONDS)}, then "
            "cancels it and counts its cost.",
        )
        _set_art(segment, art)
        await revoke_run_tokens(db, run.id)
        await _submit(db, run, segment, segments)
    await audit.record(
        db, principal, "run.retried", "run", run.id, {"label": label, "found": found}
    )
    await db.commit()


async def resume(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "paused_overrun":
        raise RunError(f"run is {run.status}, not paused on overrun")
    # The owner accepts the spend so far plus another half of the estimate.
    allowance = (run.estimate_usd or Decimal(0)) * (flows.OVERRUN_FACTOR - 1)
    ceiling = ((run.spent_usd or Decimal(0)) + allowance).quantize(Decimal("0.0001"))
    _set_knob(run, "spend_ceiling_usd", str(ceiling))
    run.status = "running"
    await audit.record(db, principal, "run.resumed", "run", run.id, {"ceiling_usd": str(ceiling)})
    segments = await _segments(db, run.id)
    if any(c.status == "pending" for c in await _checkpoints(db, [run.id])):
        # Paused while it waited on a checkpoint: it waits on it again, in the Inbox.
        run.status = "awaiting_checkpoint"
    elif not any(s.status == "running" for s in segments):
        done = [s for s in segments if s.status == "succeeded"]
        if done:
            await _advance(db, run, done[-1], segments)
    await db.commit()


# --------------------------------------------------------------------------- inbox


async def inbox(db: AsyncSession, principal: Principal) -> InboxOut:
    pending = list(
        await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.status == "pending")
            .order_by(Checkpoint.created_at, Checkpoint.id)
        )
    )
    mine = [c for c in pending if has_role(principal.role, c.approver_role)]  # type: ignore[arg-type]
    run_ids = {c.run_id for c in mine}
    owner = principal.role == "owner"
    waiting_runs: list[Run] = []
    if owner:
        waiting_runs = list(
            await db.scalars(
                select(Run)
                .where(Run.status.in_(("awaiting_approval", "paused_overrun")))
                .order_by(Run.created_at)
            )
        )
    runs: dict[uuid.UUID, Run] = {}
    if run_ids:
        runs = {r.id: r for r in await db.scalars(select(Run).where(Run.id.in_(run_ids)))}
    refs = await _refs(db, [*runs.values(), *waiting_runs])

    checkpoints = []
    for c in mine:
        run = runs[c.run_id]
        seq = (c.payload or {}).get("segment_seq")
        sdef = _flow(run).segments[seq - 1] if seq else None
        checkpoints.append(
            InboxCheckpoint(
                **_checkpoint_out(c, principal).model_dump(),
                flow=run.flow,  # type: ignore[arg-type]
                flow_title=_flow(run).title,
                document_slug=refs.get(run.document_id),
                segment_title=sdef.title if sdef else None,
            )
        )

    feedback: list[InboxDocument] = []
    if has_role(principal.role, "approver"):
        items = list(
            await db.scalars(
                select(FeedbackItem)
                .where(FeedbackItem.status == "open")
                .order_by(FeedbackItem.created_at.desc(), FeedbackItem.id)
            )
        )
        by_doc: dict[uuid.UUID, list[FeedbackItem]] = {}
        for f in items:
            by_doc.setdefault(f.document_id, []).append(f)
        if by_doc:
            docs = {
                d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(by_doc)))
            }
            latest = dict(
                (
                    await db.execute(
                        select(DocumentVersion.document_id, func.max(DocumentVersion.number))
                        .where(DocumentVersion.document_id.in_(by_doc))
                        .group_by(DocumentVersion.document_id)
                    )
                ).all()
            )
            for doc_id, doc_items in by_doc.items():
                d = docs[doc_id]
                feedback.append(
                    InboxDocument(
                        document_id=d.id,
                        slug=d.slug,
                        title=d.title,
                        latest_version=latest.get(d.id),
                        open_count=len(doc_items),
                        items=[
                            InboxFeedbackItem(
                                id=f.id,
                                summary=f.summary,
                                section_key=f.section_key,
                                raised_on_version=f.raised_on_version,
                                created_at=f.created_at,
                            )
                            for f in doc_items[:5]
                        ],
                    )
                )
            feedback.sort(key=lambda d: d.items[0].created_at, reverse=True)

    approvals = [_summary(r, refs, None) for r in waiting_runs if r.status == "awaiting_approval"]
    overruns = [_summary(r, refs, None) for r in waiting_runs if r.status == "paused_overrun"]
    # Lost submissions past the lookup cap (Retry or Cancel), cancels past NOT_FOUND_TRIES
    # 404s (Stop cancelling), answer posts past them (Cancel), and searched workflows past
    # them (shown), by those who manage the run.
    live = Run.knobs["workflow"]["state"].astext == "live"
    stuck_runs = [
        r
        for r in await db.scalars(
            select(Run)
            .where(
                Run.knobs.has_key("stuck_lookup")
                | Run.knobs.has_key("post_404")
                | Run.knobs.has_key("searches")
                | live
            )
            .order_by(Run.created_at)
        )
        if _may_manage(principal, r) and _stuck(r)
    ]
    # Submissions given up on, still looked for (shown, nothing to do).
    searching_runs = [
        r
        for r in await db.scalars(
            select(Run).where(Run.knobs.has_key("searches")).order_by(Run.created_at)
        )
        if _may_manage(principal, r)
    ]
    stuck_refs = await _refs(db, [*stuck_runs, *searching_runs])
    lookups = [_summary(r, stuck_refs, None) for r in stuck_runs]
    searches = [_summary(r, stuck_refs, None) for r in searching_runs]
    return InboxOut(
        checkpoints=checkpoints,
        approvals=approvals,
        overruns=overruns,
        lookups=lookups,
        searches=searches,
        feedback=feedback,
        total=len(checkpoints) + len(approvals) + len(overruns) + len(lookups) + len(feedback),
    )
