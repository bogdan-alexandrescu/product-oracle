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
up, recorded, on a 404), and nothing is submitted after it until the cancel holds; an
Inbox decision that would need it says "decide again". A confirmed cancel reads the
workflow's final cost, and the spend is checked against the ceiling before every
submission and before anything follows an answer.

Segment ``artifacts`` (jsonb) hold ``files`` (name -> text), ``attempts`` (one entry
per submission or in-workflow round: workflow id, label, cost, the reviewer's note),
``notes``, ``import``, ``baseline_import``, ``items_check`` and ``lost`` (a submission
whose answer was lost, looked up by its label before resubmitting).
Run ``knobs`` hold the resolved knobs plus values Oracle sets: ``document_slug`` (a
document the run will create), ``spend_ceiling_usd``, and for prd_to_roadmap
``source_version_id`` (the approved PRD version), ``template``, ``template_version`` and
``theme`` (the roadmap's), and ``workflow``: the live v2 workflow's id, label, credential
expiry and plan (oracle.runs.workflow).
"""

import copy
import logging
import uuid
from dataclasses import dataclass, replace
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
    )


def _stuck(run: Run) -> str | None:
    """What the Inbox says of a run whose lost submission is past the lookup cap."""
    stuck = (run.knobs or {}).get("stuck_lookup")
    if run.status != "running" or not isinstance(stuck, dict):
        return None
    return f"Submission {stuck.get('label')} was lost and is still not found. {_STUCK}."


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
        token_read_only=any(_holds_token(c) for c in checkpoints),
    )


def _holds_token(cp: Checkpoint) -> bool:
    """W5 (owner, 2026-10-19): a console answer that did not count, waiting for an
    approver to confirm it or decide, makes the run's token read-only."""
    console = ((cp.payload or {}).get("wait") or {}).get("console") or {}
    return cp.status == "pending" and console.get("needs") == "confirm"


async def token_hold(db: AsyncSession, run_id: uuid.UUID) -> str | None:
    """Why the run's token is read-only now (W5), or None: its agents may read Oracle,
    and their writes (drafts, proposals) are refused until an approver confirms the
    console's answer or decides the checkpoint (confirming restores the token)."""
    held = await db.scalar(
        select(Checkpoint.kind)
        .where(
            Checkpoint.run_id == run_id,
            Checkpoint.status == "pending",
            Checkpoint.payload["wait"]["console"]["needs"].astext == "confirm",
        )
        .limit(1)
    )
    if held is None:
        return None
    return (
        f"waiting for approval: {held} was answered in SwarmCloud's console by someone whose "
        "answer does not count until an Oracle approver confirms it; until then this run's "
        "token may read Oracle but not write to it"
    )


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
    "segment again (if the lost one landed, it may run too, without Oracle's data) or "
    "Cancel ends the run"
)


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


async def _detach(db: AsyncSession, run: Run, *, cancel: bool, state: str) -> bool:
    """Stop driving the run's live workflow (cancelling it when asked) and revoke its
    run token: what comes next is a new workflow with a fresh token, or the end.

    Returns False when SwarmCloud did not confirm the cancel (and the workflow has not
    ended): it may still run, so it stays attached with a ``cancel_pending`` marker. Its
    cost is still read into the run's spend, the tick cancels it again, and nothing is
    submitted after it until the cancel is confirmed: no segment runs in two workflows.
    A workflow already being cancelled stays so; only ``cancel`` tries again."""
    wf = _live(run)
    if wf is None:
        return True
    pending = wf.get("cancel_pending")
    if pending and not cancel:
        return False
    if cancel:
        runtime = get_runtime()
        error: RuntimeUnavailable | None = None
        if not wf.get("id"):
            # A lost submission not found yet: the tick looks it up, then cancels it.
            error = RuntimeUnavailable(f"submission {wf.get('lookup')} not looked up yet")
        else:
            try:
                await runtime.cancel(wf["id"])
            except RuntimeUnavailable as exc:
                error = exc
        if error is not None:
            if error.gone:
                await _give_up(db, run, wf, state)
                return True
            # Not confirmed; the workflow may have ended anyway (a refusal to cancel an
            # ended workflow, or a cancel whose answer was lost).
            ended = False
            if wf.get("id"):
                try:
                    ended = (await runtime.status(wf["id"])).terminal
                except RuntimeUnavailable as read:
                    if read.gone:
                        await _give_up(db, run, wf, state)
                        return True
            if not ended:
                log.warning("run %s: cancel of %s not confirmed: %s", run.id, wf.get("id"), error)
                tries = int((pending or {}).get("tries") or 0) + 1
                marker = {
                    "state": state,
                    "since": (pending or {}).get("since") or _now().isoformat(),
                    "tries": tries,
                    "error": _shown(error),
                }
                _set_knob(run, "workflow", {**wf, "cancel_pending": marker})
                # Nothing Oracle drives runs in it any more: its agents lose Oracle's data
                # now, not when SwarmCloud confirms.
                await revoke_run_tokens(db, run.id)
                return False
        if wf.get("id") and not await _final_cost(db, run, wf):
            # Cancelled, its last cost unread: attached for one more read (the tick's),
            # so that nothing is submitted after it before its spend is counted.
            marker = {
                "state": state,
                "since": (pending or {}).get("since") or _now().isoformat(),
                "tries": int((pending or {}).get("tries") or 0),
                "confirmed": True,
                "error": "its last cost was not read",
            }
            _set_knob(run, "workflow", {**wf, "cancel_pending": marker})
            await revoke_run_tokens(db, run.id)
            return False
    await _end_workflow(db, run, wf, state)
    return True


async def _final_cost(db: AsyncSession, run: Run, wf: dict[str, Any]) -> bool:
    """A cancelled workflow's cost as it ended: into the run's spend before anything is
    submitted after it (it spent since the tick last read it). False when it was not
    read."""
    try:
        status = await get_runtime().status(wf["id"])
    except RuntimeUnavailable as exc:
        if exc.gone:
            return True  # nothing more to read: its cost is what Oracle last read
        log.warning("run %s: final cost of %s not read: %s", run.id, wf["id"], exc)
        return False
    _take_cost(run, wf, status, await _segments(db, run.id))
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
    db: AsyncSession, run: Run, wf: dict[str, Any], state: str, *, gone: str | None = None
) -> None:
    rest = {k: v for k, v in wf.items() if k != "cancel_pending"}
    if gone:
        rest["gone"] = gone
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
            "attempt": len(art["attempts"]) + 1,
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
    db: AsyncSession, run: Run, status: str, error: str | None = None, *, state: str = "ended"
) -> None:
    run.status = status
    run.finished_at = _now()
    if error:
        run.error = error
    # A run that ends early stops its workflow; a finished one's ends on its own. A cancel
    # SwarmCloud does not confirm leaves the workflow attached: the tick cancels it again
    # and keeps reading its cost.
    await _detach(db, run, cancel=status != "succeeded", state=state)
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


async def _tick_run(db: AsyncSession, run: Run, stats: _TickStats) -> None:
    runtime = get_runtime()
    segments = await _segments(db, run.id)
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


def _take_cost(
    run: Run, wf: dict[str, Any], status: WorkflowStatus, segments: list[RunSegment]
) -> RunSegment | None:
    """The live workflow's cost, on the attempt of the segment it was submitted for, and
    the run's spend from it. Returns that segment.

    The whole workflow's cost goes on its first attempt there: a revision inside the
    workflow is another attempt on the same workflow, and counts nothing again."""
    start = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if start is not None:
        art = _art(start)
        first = True
        for a in art["attempts"]:
            if a.get("workflow_id") == wf["id"]:
                a["cost_usd"] = float(status.cost_usd) if first else 0
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
    does not know (404) is given up, and recorded."""
    runtime = get_runtime()
    pending = wf.get("cancel_pending") or {}
    state = pending.get("state") or "ended"
    if not wf.get("id"):
        label = wf.get("lookup") or ""
        try:
            found = await runtime.find_by_label(label, since=_parse_at(wf.get("lookup_since")))
        except RuntimeUnavailable as exc:
            log.warning("run %s: looking up %s to cancel it: %s", run.id, label, exc)
            if _lookup_exhausted({"submitted_at": wf.get("lookup_since") or pending.get("since")}):
                # Never found, never ruled out: stop looking rather than look forever.
                await _stop_looking(db, run, wf, segments, state, exc)
                return True
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
        if pending.get("confirmed"):
            # Its cancel was confirmed and this was the one more read of its last cost.
            note = (
                f"SwarmCloud confirmed cancelling workflow {wf['id']}, but its last cost could "
                f"not be read ({_shown(exc)}); the run's spend is what Oracle last read."
            )
            target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
            _note(target or segments[0], note)
            await _end_workflow(db, run, wf, state)
            return True
        raise
    _take_cost(run, wf, status, segments)
    if status.terminal:
        await _end_workflow(db, run, wf, state)
        return True
    if await _detach(db, run, cancel=True, state=state):
        return True
    if run.status == "running" and (ceiling := _overrun(run)) is not None:
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
    answer either way: Oracle stops looking. Its token is revoked, so if it landed it
    runs on without Oracle's data."""
    gone = (
        f"Oracle stopped looking for submission {wf.get('lookup')} to cancel it: after "
        f"{_duration(LOST_LOOKUP_SECONDS)} SwarmCloud's task listing still neither shows it "
        f"nor rules it out ({_shown(exc)}). Its run token is revoked; if it landed, cancel "
        "it in SwarmCloud's console, and its cost is not counted here."
    )
    log.warning("run %s: %s", run.id, gone)
    target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if target is not None or segments:
        _note(target or segments[0], gone)
    await _end_workflow(db, run, wf, state, gone=gone)


def _adopt(segments: list[RunSegment], wf: dict[str, Any]) -> None:
    """A lost submission found while cancelling: an attempt of its segment, so that its
    cost is counted in the run's spend."""
    segment = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if segment is None:
        return
    art = _art(segment)
    if not any(a.get("workflow_id") == wf["id"] for a in art["attempts"]):
        art["attempts"].append(
            {
                "attempt": len(art["attempts"]) + 1,
                "workflow_id": wf["id"],
                "submitted_at": _now().isoformat(),
                "cost_usd": 0,
                "note": None,
                "state": "cancelled",
                "label": wf.get("label"),
                "mode": wf.get("mode"),
            }
        )
    _set_art(segment, art)


async def _harvest(run: Run, segment: RunSegment, workflow_id: str, steps: tuple[str, ...]) -> None:
    """A segment's files from the steps that wrote them (read by task id), in step order:
    a later step's file of the same name wins."""
    files = await get_runtime().artifacts(workflow_id, steps)
    art = _art(segment)
    art["files"] = {**art["files"], **files}
    if art["attempts"]:
        art["attempts"][-1]["state"] = "succeeded"
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
                art["attempts"][-1]["state"] = "cancelled"
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
            cp.payload = {
                **(cp.payload or {}),
                "wait": {**wait, "ended": "paused", "ended_at": _now().isoformat()},
            }
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
    try:
        record = await get_runtime().answer_record(
            wf["id"], wait["step_id"], wait.get("artifact") or workflow.review_artifact(round_)
        )
    except RuntimeUnavailable as exc:
        if exc.retryable:
            log.warning(
                "run %s: wait %s not read, again next tick: %s", run.id, wait["step_id"], exc
            )
            return
        log.warning("run %s: cannot read wait %s: %s", run.id, wait.get("step_id"), exc)
        record = RecordedAnswer(state="answered") if answered_step else RecordedAnswer()
    wait["checked_at"] = _now().isoformat()
    _set_wait(cp, wait)
    seq = (cp.payload or {}).get("segment_seq")
    segment = next(s for s in segments if s.seq == seq)
    if record.answered:
        if record.verdict is None:
            # Never guessed: shown in the Inbox, and read again next time.
            _unreadable(run, cp, segment, wf, wait, record)
            return
        await _take_answer(db, run, cp, segment, segments, wf, wait, record)
        return
    if answered_step:
        return  # the record lags the step: read again next time
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
    ids = list(
        await db.scalars(
            select(Run.id)
            .where(Run.status.in_(("running", "paused_overrun")) | live)
            .order_by(Run.started_at, Run.id)
        )
    )
    for run_id in ids:
        run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
        if run is None or not (
            run.status in ("running", "paused_overrun") or _live(run) is not None
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
        if await _decide_in_workflow(db, run, cp, segment, segments, wf, principal):
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
    if needs not in ("redo_or_continue", "unreadable"):
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
        raise Unavailable(
            f"SwarmCloud says {cp.kind} was already answered, but Oracle could not read the "
            f"recorded verdict ({artifact}); decide again, it is safe to repeat, or choose "
            f"Redo from '{title}' to run it again as a new workflow"
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
                raise Unavailable(
                    f"SwarmCloud says {cp.kind} was already answered but did not show the "
                    f"answer ({read}); decide again, it is safe to repeat"
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
) -> dict[str, Any]:
    """A workflow Oracle does not drive as the run's (one per segment, or a lost
    submission), attached so that cancelling the run cancels it the same way: retried by
    the tick, its cost counted, given up on SwarmCloud's 404. ``lookup``: the label to
    find it by while its id is unknown, and ``lookup_since`` when it was submitted (the
    search ends at an older task, and stops past the lookup cap)."""
    wf = {
        "id": workflow_id,
        "label": lookup or (_art(segment)["attempts"] or [{}])[-1].get("label"),
        "lookup": lookup,
        "lookup_since": lookup_since,
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


async def cancel(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    run = await _get_run(db, run_id, lock=True)
    if not _may_manage(principal, run):
        raise Forbidden("Only an owner or the approver who created the run can cancel it")
    if run.status in FINAL:
        raise RunError(f"run is already {run.status}")
    runtime = get_runtime()
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
                try:
                    await runtime.cancel(s.swarm_workflow_id)
                except RuntimeUnavailable as exc:
                    s.error = f"cancel not confirmed by the runtime: {_shown(exc)}"
            s.status = "cancelled"
            s.finished_at = _now()
        elif s.status == "pending":
            lost = _art(s).get("lost")
            if wf is None and isinstance(lost, dict) and lost.get("label"):
                # A submission whose answer was lost may have landed: found, it is
                # cancelled; not looked up yet, the tick looks again and cancels it.
                since = lost.get("submitted_at")
                try:
                    found = await runtime.find_by_label(lost["label"], since=_parse_at(since))
                except RuntimeUnavailable as exc:
                    log.warning("run %s: looking up %s: %s", run.id, lost["label"], exc)
                    wf = _attach_for_cancel(run, s, None, lost["label"], since)
                else:
                    if found:
                        wf = _attach_for_cancel(run, s, found, lost["label"], since)
                        _adopt(segments, wf)
            s.status = "cancelled"
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run cancelled."
            cp.decided_at = _now()
    _set_knob(run, "stuck_lookup", None)
    # A cancel SwarmCloud does not confirm leaves the workflow attached: the tick cancels
    # it again and counts its cost.
    await _finish(db, run, "cancelled", state="cancelled")
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
    past the lookup cap. Looked up once more; found, it is the segment's workflow; else
    the segment is submitted again under a new key (the approver accepts that the lost
    one, if it landed, may run too: its run token is revoked, so without Oracle's data)."""
    run = await _get_run(db, run_id, lock=True)
    if not _may_manage(principal, run):
        raise Forbidden("Only an owner or the approver who created the run can retry it")
    stuck = (run.knobs or {}).get("stuck_lookup")
    if run.status != "running" or not isinstance(stuck, dict):
        raise RunError("nothing waits for a retry: no lost submission is past its lookup cap")
    runtime = get_runtime()
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == stuck.get("seq")), None)
    art = _art(segment) if segment is not None else {}
    lost = art.get("lost")
    if segment is None or segment.status != "pending" or not isinstance(lost, dict):
        _set_knob(run, "stuck_lookup", None)
        await db.commit()
        raise RunError("nothing waits for a retry: the submission was resolved")
    found: str | None = None
    try:
        found = await runtime.find_by_label(
            lost["label"], since=_parse_at(lost.get("submitted_at"))
        )
    except RuntimeUnavailable as exc:
        log.warning("run %s: retry: %s still not resolved: %s", run.id, lost["label"], exc)
    _set_knob(run, "stuck_lookup", None)
    if found:
        art.pop("lost", None)
        _accepted(run, segment, art, found, lost, art.pop("pending_note", None), runtime)
    else:
        art.pop("lost", None)
        art["abandoned"] = [*(art.get("abandoned") or []), lost["label"]]
        _note_art(
            art,
            f"Retried from the Inbox by an approver: submission {lost['label']} was neither "
            "found nor ruled out, so the segment was submitted again under a new key; if the "
            "lost one landed it runs without Oracle's data (its token is revoked) and its "
            "cost is not counted here.",
        )
        _set_art(segment, art)
        await revoke_run_tokens(db, run.id)
        await _submit(db, run, segment, segments)
    await audit.record(
        db, principal, "run.retried", "run", run.id, {"label": lost["label"], "found": found}
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
    # Lost submissions past the lookup cap: Retry or Cancel, by those who manage the run.
    stuck_runs = [
        r
        for r in await db.scalars(
            select(Run)
            .where(Run.status == "running", Run.knobs.has_key("stuck_lookup"))
            .order_by(Run.created_at)
        )
        if _may_manage(principal, r)
    ]
    stuck_refs = await _refs(db, stuck_runs)
    lookups = [_summary(r, stuck_refs, None) for r in stuck_runs]
    return InboxOut(
        checkpoints=checkpoints,
        approvals=approvals,
        overruns=overruns,
        lookups=lookups,
        feedback=feedback,
        total=len(checkpoints) + len(approvals) + len(overruns) + len(lookups) + len(feedback),
    )
