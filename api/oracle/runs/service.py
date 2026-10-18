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
into the baseline (through its YAML import: locked items get proposals), imports
``prd.md`` as the document's next version, and opens the segment's checkpoint (or skips
a disabled one).

Segment ``artifacts`` (jsonb) hold ``files`` (name -> text), ``attempts`` (one entry
per submission: workflow id, cost, the reviewer's note), ``notes``, ``import`` and
``baseline_import``.
Run ``knobs`` hold the resolved knobs plus two values Oracle sets: ``document_slug``
(a document the run will create) and ``spend_ceiling_usd``.
"""

import copy
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, confidence
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.baseline import yaml_io
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.parser import DraftError, is_uuid
from oracle.review.models import FeedbackItem
from oracle.review.service import locked_section_keys
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.schemas import (
    AgentRoleOut,
    CheckpointOut,
    DraftImport,
    EstimateOut,
    FlowCatalog,
    FlowOut,
    FlowSegmentOut,
    InboxCheckpoint,
    InboxDocument,
    InboxFeedbackItem,
    InboxOut,
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
    RuntimeUnavailable,
    StepSpec,
    WorkflowSpec,
    get_runtime,
)
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import current_tenant, tenant_session
from oracle.tenant_settings import TenantSetting

log = logging.getLogger(__name__)

FINAL = ("succeeded", "failed", "cancelled")
ACTIVE = ("running", "awaiting_checkpoint", "paused_overrun")


class RunError(Exception):
    status = 409


class NotFound(RunError):
    status = 404


class Invalid(RunError):
    status = 422


class Forbidden(RunError):
    status = 403


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
                segments=[
                    FlowSegmentOut(
                        name=s.name,
                        title=s.title,
                        roles=list(s.roles),
                        scopes=list(s.scopes),
                        outputs=list(s.outputs),
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
        stmt = stmt.with_for_update()
    run = await db.scalar(stmt)
    if run is None:
        raise NotFound(f"run {run_id} not found")
    return run


async def _segments(db: AsyncSession, run_id: uuid.UUID) -> list[RunSegment]:
    rows = await db.scalars(
        select(RunSegment).where(RunSegment.run_id == run_id).order_by(RunSegment.seq)
    )
    return list(rows)


async def _checkpoints(db: AsyncSession, run_ids: list[uuid.UUID]) -> list[Checkpoint]:
    if not run_ids:
        return []
    rows = await db.scalars(
        select(Checkpoint)
        .where(Checkpoint.run_id.in_(run_ids))
        .order_by(Checkpoint.created_at, Checkpoint.id)
    )
    return list(rows)


async def _slugs(db: AsyncSession, runs: list[Run]) -> dict[uuid.UUID, str]:
    ids = {r.document_id for r in runs if r.document_id}
    if not ids:
        return {}
    rows = await db.execute(select(Document.id, Document.slug).where(Document.id.in_(ids)))
    return dict(rows.all())


def _summary(run: Run, slugs: dict[uuid.UUID, str], waiting: Checkpoint | None) -> RunSummary:
    return RunSummary(
        id=run.id,
        flow=run.flow,  # type: ignore[arg-type]
        flow_title=_flow(run).title,
        status=run.status,  # type: ignore[arg-type]
        document_id=run.document_id,
        document_slug=slugs.get(run.document_id)
        if run.document_id
        else run.knobs.get("document_slug"),
        estimate_usd=_usd(run.estimate_usd),
        spent_usd=float(run.spent_usd or 0),
        created_by=run.created_by,
        created_at=run.created_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        waiting_on=waiting.kind if waiting else None,  # type: ignore[arg-type]
        error=run.error,
    )


def _checkpoint_out(cp: Checkpoint, principal: Principal | None) -> CheckpointOut:
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
        can_decide=cp.status == "pending"
        and principal is not None
        and has_role(principal.role, cp.approver_role),  # type: ignore[arg-type]
    )


def _segment_out(run: Run, segment: RunSegment, knobs: flows.Knobs) -> SegmentOut:
    sdef = _flow(run).segment(segment.name)
    art = segment.artifacts or {}
    imp = art.get("import")
    return SegmentOut(
        id=segment.id,
        seq=segment.seq,
        name=segment.name,
        title=sdef.title,
        status=segment.status,  # type: ignore[arg-type]
        roles=knobs.roles.get(segment.name, list(sdef.roles)),
        scopes=list(sdef.scopes),
        checkpoint=sdef.checkpoint,  # type: ignore[arg-type]
        checkpoint_on=knobs.checkpoints.get(sdef.checkpoint, True),
        estimate_usd=_usd(segment.estimate_usd),
        cost_usd=float(segment.cost_usd or 0),
        workflow_id=segment.swarm_workflow_id,
        artifacts=sorted((art.get("files") or {}).keys()),
        attempts=[SegmentAttempt(**a) for a in art.get("attempts") or []],
        draft_import=DraftImport(**imp) if imp else None,
        started_at=segment.started_at,
        finished_at=segment.finished_at,
        error=segment.error,
    )


async def read_run(db: AsyncSession, run_id: uuid.UUID, principal: Principal | None) -> RunOut:
    run = await _get_run(db, run_id)
    segments = await _segments(db, run.id)
    checkpoints = await _checkpoints(db, [run.id])
    slugs = await _slugs(db, [run])
    knobs = _knobs(run)
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
        **_summary(run, slugs, waiting).model_dump(),
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
        segments=[_segment_out(run, s, knobs) for s in segments],
        checkpoints=[_checkpoint_out(c, principal) for c in checkpoints],
    )


async def list_runs(db: AsyncSession, status: str | None = None) -> list[RunSummary]:
    stmt = select(Run).order_by(Run.created_at.desc(), Run.id)
    if status:
        stmt = stmt.where(Run.status == status)
    runs = list(await db.scalars(stmt))
    slugs = await _slugs(db, runs)
    pending = {
        c.run_id: c for c in await _checkpoints(db, [r.id for r in runs]) if c.status == "pending"
    }
    return [_summary(r, slugs, pending.get(r.id)) for r in runs]


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
    db: AsyncSession, flow: flows.FlowDef, ref: str | None
) -> tuple[uuid.UUID | None, str | None]:
    """(document_id, new slug) for a run's target PRD."""
    if ref is None:
        if flow.requires_document:
            raise Invalid(f"the {flow.title} flow needs the document to work on")
        raise Invalid("name the PRD: an existing document, or a new slug to create")
    document = await docs_service.find_document(db, ref)
    if document is None:
        if flow.requires_document or is_uuid(ref):
            raise Invalid(f"document '{ref}' not found")
        return None, ref
    if flow.requires_document:
        latest = await db.scalar(
            select(func.max(DocumentVersion.number)).where(
                DocumentVersion.document_id == document.id
            )
        )
        if latest is None:
            raise Invalid(f"document '{ref}' has no version to give feedback on")
    return document.id, None


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
    document_id, new_slug = await _resolve_document(db, flow, body.document)
    stored = knobs.as_json()
    if new_slug:
        stored["document_slug"] = new_slug
    run = Run(
        flow=flow.key,
        status="draft",
        knobs=stored,
        document_id=document_id,
        created_by=principal.id,
    )
    db.add(run)
    await db.flush()
    await _reset_segments(db, run, flow)
    await audit.record(db, principal, "run.created", "run", run.id, {"flow": flow.key})
    await db.commit()
    return run.id


async def update_run(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, body: RunPatch
) -> None:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError("only a draft run can be changed")
    flow = _flow(run)
    stored = dict(run.knobs)
    if body.knobs is not None:
        stored = {**_resolve_knobs(flow, body.knobs).as_json()}
        if run.knobs.get("document_slug"):
            stored["document_slug"] = run.knobs["document_slug"]
    if body.document is not None:
        document_id, new_slug = await _resolve_document(db, flow, body.document)
        run.document_id = document_id
        stored.pop("document_slug", None)
        if new_slug:
            stored["document_slug"] = new_slug
    run.knobs = stored
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
) -> flows.PromptContext:
    knobs = _knobs(run)
    snapshot = await db.get(Snapshot, run.snapshot_id) if run.snapshot_id else None
    document = None
    if run.document_id:
        doc = await db.get(Document, run.document_id)
        document = doc.slug if doc else None
    document = document or run.knobs.get("document_slug")
    prior: dict[str, str] = {}
    for s in segments:
        if s.seq < segment.seq:
            for name, content in ((s.artifacts or {}).get("files") or {}).items():
                prior[name] = content
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
        mcp_reachable=runtime.can_reach_oracle,
    )


async def _submit(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    change_request: str | None = None,
) -> None:
    """Mint the segment's run token and submit its workflow (the caller commits)."""
    runtime = get_runtime()
    settings = get_runtime_settings()
    flow, knobs = _flow(run), _knobs(run)
    sdef = flow.segment(segment.name)
    art = _art(segment)
    attempt = len(art["attempts"]) + 1
    # A retry after the runtime refused a re-run keeps the reviewer's note.
    change_request = change_request or art.pop("pending_note", None)
    if segment.estimate_usd is None:
        segment.estimate_usd = flows.segment_estimate(sdef, knobs)

    # One segment runs at a time: earlier tokens of the run die before a new one exists.
    await revoke_run_tokens(db, run.id)
    token = await mint_run_token(db, run.id, sdef.scopes, settings.run_token_ttl_seconds)
    ctx = await _prompt_context(db, run, segment, segments, attempt, change_request, runtime)
    spec = WorkflowSpec(
        name=f"oracle-{run.flow}-{segment.name}",
        steps=tuple(
            StepSpec(
                key=key,
                role=role,
                profile=settings.swarmcloud_profile,
                prompt=prompt,
                depends_on=deps,
                input_from=inputs,
            )
            for key, role, prompt, deps, inputs in flows.build_steps(flow, sdef, knobs, ctx)
        ),
        outputs=sdef.outputs,
        mcp=McpAccess(
            url=settings.public_url.rstrip("/") + "/mcp", token=token, scopes=sdef.scopes
        ),
        budget_usd=knobs.budget_usd,
        labels={
            "run_id": str(run.id),
            "segment": segment.name,
            "attempt": str(attempt),
            "estimate_usd": str(segment.estimate_usd),
        },
    )
    entry: dict[str, Any] = {
        "attempt": attempt,
        "workflow_id": None,
        "submitted_at": _now().isoformat(),
        "cost_usd": 0,
        "note": change_request,
        "state": None,
    }
    try:
        workflow_id = await runtime.submit(spec)
    except RuntimeUnavailable as exc:
        # Left pending: the next tick submits it again.
        segment.status = "pending"
        segment.error = str(exc)
        if change_request:
            art["pending_note"] = change_request
        _set_art(segment, art)
        await revoke_run_tokens(db, run.id)
        log.warning("run %s segment %s: submit failed: %s", run.id, segment.name, exc)
        return
    entry["workflow_id"] = workflow_id
    entry["state"] = "running"
    art["attempts"].append(entry)
    for note in runtime.notes() if not runtime.can_reach_oracle else []:
        if note not in art["notes"]:
            art["notes"].append(note)
    _set_art(segment, art)
    segment.status = "running"
    segment.swarm_workflow_id = workflow_id
    segment.error = None
    segment.finished_at = None
    segment.started_at = segment.started_at or _now()
    run.status = "running"


def _recompute_spend(run: Run, segments: list[RunSegment]) -> None:
    run.spent_usd = sum((s.cost_usd or Decimal(0) for s in segments), Decimal(0))


async def _finish(db: AsyncSession, run: Run, status: str, error: str | None = None) -> None:
    run.status = status
    run.finished_at = _now()
    if error:
        run.error = error
    await revoke_run_tokens(db, run.id)


async def _next(
    db: AsyncSession, run: Run, segment: RunSegment, segments: list[RunSegment]
) -> None:
    later = [s for s in segments if s.seq > segment.seq]
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


async def _import_prd(db: AsyncSession, run: Run, markdown: str) -> dict[str, Any]:
    """Import prd.md as the next version of the run's document, in its own transaction."""
    tenant_id = current_tenant(db)
    ref = str(run.document_id) if run.document_id else run.knobs.get("document_slug")
    if not ref:
        return {"error": "the run names no document"}
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        principal = _creator(tenant_id, user, token)
    except LookupError as exc:
        return {"error": str(exc)}
    async with tenant_session(tenant_id) as s:
        try:
            result = await docs_service.import_draft(s, ref, markdown, principal)
        except DraftError as exc:
            problems = "; ".join(f"[{p.code}] {p.message}" for p in exc.problems)
            return {"error": f"prd.md was rejected: {problems}"}
        except (docs_service.NotFoundError, docs_service.ImportConflictError) as exc:
            return {"error": f"prd.md was not imported: {exc}"}
        document = await s.get(Document, result.version.document_id)
    return {
        "document_id": str(result.version.document_id),
        "slug": document.slug if document else None,
        "version": result.version.number,
        "created": result.created,
        "warnings": [w.code for w in result.version.warnings],
    }


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


async def _advance(
    db: AsyncSession, run: Run, segment: RunSegment, segments: list[RunSegment]
) -> bool:
    """After a segment succeeded: import its draft, then open or skip its checkpoint.

    Returns False when this attempt of the segment was already advanced.
    """
    flow, knobs = _flow(run), _knobs(run)
    sdef = flow.segment(segment.name)
    art = _art(segment)
    attempt = art["attempts"][-1] if art["attempts"] else {}
    if attempt.get("advanced"):
        return False
    attempt["advanced"] = True
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
    if sdef.imports_prd:
        markdown = art["files"].get("prd.md")
        if markdown is None:
            imported = {"error": "the segment left no prd.md"}
        else:
            # Committed first: the import runs in its own transaction.
            _set_art(segment, art)
            await db.commit()
            imported = await _import_prd(db, run, markdown)
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
    if knobs.checkpoints.get(sdef.checkpoint, True):
        db.add(
            Checkpoint(
                run_id=run.id,
                kind=sdef.checkpoint,
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
            kind=sdef.checkpoint,
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
    await _next(db, run, segment, segments)
    return True


# --------------------------------------------------------------------------- tick


@dataclass
class _TickStats:
    checked: int = 0
    finished: int = 0
    advanced: int = 0
    paused: int = 0


async def _tick_run(db: AsyncSession, run: Run, stats: _TickStats) -> None:
    runtime = get_runtime()
    segments = await _segments(db, run.id)
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
    if art["attempts"]:
        art["attempts"][-1]["cost_usd"] = float(status.cost_usd)
        art["attempts"][-1]["state"] = status.state
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


async def tick(db: AsyncSession, principal: Principal | None = None) -> TickOut:
    """Advance every active run of the session's tenant; one transaction per run."""
    stats = _TickStats()
    errors: list[str] = []
    ids = list(
        await db.scalars(
            select(Run.id)
            .where(Run.status.in_(("running", "paused_overrun")))
            .order_by(Run.started_at, Run.id)
        )
    )
    for run_id in ids:
        run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
        if run is None or run.status not in ("running", "paused_overrun"):
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
    run.status = "running"
    if decision == "approved":
        await _next(db, run, segment, segments)
    else:
        segment.status = "pending"
        await _submit(db, run, segment, segments, change_request=note)
    await db.commit()


def _may_manage(principal: Principal, run: Run) -> bool:
    return principal.role == "owner" or (
        has_role(principal.role, "approver") and principal.id == run.created_by
    )


async def cancel(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    run = await _get_run(db, run_id, lock=True)
    if not _may_manage(principal, run):
        raise Forbidden("Only an owner or the approver who created the run can cancel it")
    if run.status in FINAL:
        raise RunError(f"run is already {run.status}")
    runtime = get_runtime()
    segments = await _segments(db, run.id)
    for s in segments:
        if s.status == "running" and s.swarm_workflow_id:
            try:
                await runtime.cancel(s.swarm_workflow_id)
            except RuntimeUnavailable as exc:
                s.error = f"cancel not confirmed by the runtime: {exc}"
            s.status = "cancelled"
            s.finished_at = _now()
        elif s.status == "pending":
            s.status = "cancelled"
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run cancelled."
            cp.decided_at = _now()
    await _finish(db, run, "cancelled")
    await audit.record(db, principal, "run.cancelled", "run", run.id, {})
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
    if not any(s.status == "running" for s in segments):
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
    slugs = await _slugs(db, [*runs.values(), *waiting_runs])

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
                document_slug=slugs.get(run.document_id) if run.document_id else None,
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

    approvals = [_summary(r, slugs, None) for r in waiting_runs if r.status == "awaiting_approval"]
    overruns = [_summary(r, slugs, None) for r in waiting_runs if r.status == "paused_overrun"]
    return InboxOut(
        checkpoints=checkpoints,
        approvals=approvals,
        overruns=overruns,
        feedback=feedback,
        total=len(checkpoints) + len(approvals) + len(overruns) + len(feedback),
    )
