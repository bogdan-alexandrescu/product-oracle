"""Runs: a run's draft: created, estimated, edited, and started or sent for approval."""

import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy, company_time, safe_yaml, webhooks
from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.baseline import fixes
from oracle.baseline.models import Entity
from oracle.docs import service as docs_service
from oracle.docs import written
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.parser import is_uuid
from oracle.errors import exception_text
from oracle.roadmap import company as roadmap_company
from oracle.runs import flows, reuse, service
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.schemas import EstimateOut, KnobsIn, RunCreate, RunPatch, SegmentEstimate
from oracle.runs.service import (
    ITEMS_FILE,
    OFF_NOTE,
    ORACLE_KNOBS,
    Forbidden,
    Invalid,
    RunError,
    _art,
    _decide_member_view,
    _flow,
    _knobs,
    _set_art,
    _set_knob,
    _skipped_off,
    _usd,
    log,
)
from oracle.sources.models import Snapshot
from oracle.templates import service as templates_service
from oracle.templates.builtins import (
    DEFAULT_TEMPLATE_FOR_KIND,
    DEFAULT_THEME_FOR_KIND,
    ensure_builtins,
)
from oracle.templates.models import Template, TemplateVersion, Theme
from oracle.tenant_settings_api import company_horizons


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
    if flow.document_kinds and document.kind not in flow.document_kinds:
        raise Invalid(
            f"document '{ref}' is a {flows.KIND_NAMES.get(document.kind, document.kind)}; "
            f"the {flow.title} flow drafts a "
            + " or a ".join(flows.KIND_NAMES[k] for k in flow.document_kinds)
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
    if number is None and not flow.source_approved:
        raise Invalid(f"name the version of the {name} to read")
    if number is not None:
        version = await db.scalar(stmt.where(DocumentVersion.number == number))
        if version is None:
            raise Invalid(f"version {number} of '{document.slug}' not found")
        if version.approved_at is None and flow.source_approved:
            target = flows.KIND_NAMES.get(flow.target_kind or "", "roadmap")
            raise Invalid(
                f"version {number} of '{document.slug}' is not approved: a {target} is built "
                f"from an approved {name} version"
            )
    else:
        version = await db.scalar(
            stmt.where(DocumentVersion.approved_at.is_not(None))
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
        if version is None:
            target = flows.KIND_NAMES.get(flow.target_kind or "", "roadmap")
            raise Invalid(
                f"'{document.slug}' has no approved version: approve a version of the {name} "
                f"before building its {target}"
            )
    # #254: nothing is built from a version that is still only its template's text.
    if await written.nothing_written(db, document, version):
        raise Invalid(f"version {version.number} of '{document.slug}': {written.NOTHING_WRITTEN}")
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


# Flows whose target kind takes a template and theme at the run: roadmaps (prd_to_roadmap)
# and, since C4 One New PRD door, PRDs (baseline_to_prd). The feedback loop refuses them.
TEMPLATED_KINDS = ("roadmap", "prd")


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
    if not flow.writes_document:
        named = (
            inputs.document,
            inputs.source,
            inputs.source_version,
            inputs.template,
            inputs.theme,
        )
        if any(v is not None for v in named):
            raise Invalid(f"the {flow.title} flow writes no document")
        return None, {}
    if flow.target_kind not in TEMPLATED_KINDS and (inputs.template or inputs.theme):
        raise Invalid(f"the {flow.title} flow takes no template or theme")
    source = await _resolve_source(db, flow, inputs.source, inputs.source_version)
    if flow.stores_draft_items:
        # E1: the run's document is its source PRD; it writes no document of its own.
        if inputs.document is not None:
            raise Invalid(f"the {flow.title} flow writes no document")
        assert source is not None
        return source[0].id, {"source_version_id": str(source[1].id)}
    default_slug = None
    if source is not None and source[0].id in await roadmap_company.replaced_prd_ids(db):
        # one-roadmap-many-prds: a replaced PRD is read-only and feeds no roadmap.
        raise Invalid(f"{source[0].title} is replaced: run its replacing PRDs instead")
    company_roadmap = await roadmap_company.active(db) if flow.target_kind == "roadmap" else None
    if source is not None and inputs.document is None and company_roadmap is not None:
        # one-roadmap-many-prds: every PRD's run writes the company roadmap's next version.
        default_slug = company_roadmap.slug
    elif source is not None and inputs.document is None:
        # "<prd>-roadmap": that roadmap's next version, or a new roadmap.
        base = f"{source[0].slug}-{flow.target_kind or 'roadmap'}"
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
    if flow.target_kind in TEMPLATED_KINDS:
        oracle.update(
            await _resolve_template(db, flow.target_kind, inputs.template, inputs.theme, document)
        )
    return (document.id if document else None), oracle


def _resolve_knobs(flow: flows.FlowDef, knobs: KnobsIn) -> flows.Knobs:
    try:
        return flows.resolve_knobs(flow, knobs.model_dump())
    except flows.KnobError as exc:
        raise Invalid(exception_text(exc)) from exc


async def _reset_segments(db: AsyncSession, run: Run, flow: flows.FlowDef) -> None:
    for s in await service._segments(db, run.id):
        await db.delete(s)
    await db.flush()
    for i, sdef in enumerate(flow.segments, start=1):
        db.add(RunSegment(run_id=run.id, seq=i, name=sdef.name, status="pending"))
    run.estimate_usd = None


# A baseline build in these states is under way: another is refused (B1), as two would
# race on the same (type, key) items and double the proposals.
BUILD_UNDER_WAY = ("awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun")


async def _one_build_at_a_time(db: AsyncSession, flow: flows.FlowDef) -> None:
    """Refuse a second Build the baseline run while one is under way (409)."""
    if flow.key != "baseline":
        return
    under_way = await db.scalar(
        select(Run.id)
        .where(Run.flow == flow.key, Run.status.in_(BUILD_UNDER_WAY))
        .order_by(Run.created_at)
        .limit(1)
    )
    if under_way is not None:
        raise RunError(f"A Ground Truth build is already under way (run {under_way})")


class NotReusable(RunError):
    """409 ``baseline_not_reusable``: the current baseline may not be reused (C4)."""

    def __init__(self, reason: str | None) -> None:
        super().__init__(f"the current Ground Truth is not reusable ({reason})")
        self.detail = {"code": "baseline_not_reusable", "reason": reason}


async def _reuse_knob(db: AsyncSession, flow: flows.FlowDef) -> dict[str, Any]:
    """The ``reuse_baseline`` knob for a run asking to reuse the current baseline: the
    review it reuses. 422 off Baseline to PRD; 409 when not reusable."""
    if flow.key != "baseline_to_prd":
        raise Invalid(f"the {flow.title} flow does not reuse the Ground Truth")
    st = await reuse.review_status(db)
    if not st.reusable:
        raise NotReusable(st.reason)
    return st.knob()


async def _recheck_reuse(db: AsyncSession, run: Run) -> None:
    """A run reusing the baseline: still reusable (else 409, nothing changed); the knob
    follows the current review."""
    if not (run.knobs or {}).get("reuse_baseline"):
        return
    _set_knob(run, "reuse_baseline", await _reuse_knob(db, _flow(run)))


async def create_run(
    db: AsyncSession,
    principal: Principal | str,
    body: RunCreate,
    *,
    entry_knobs: dict[str, Any] | None = None,
    oracle_knobs: dict[str, Any] | None = None,
    commit: bool = True,
    created_by: uuid.UUID | None = None,
) -> uuid.UUID:
    """A draft run. A flow with an ``entry`` route is created only through it, which
    passes ``entry_knobs`` (what the run builds, e.g. its spec request) and commits.
    ``oracle_knobs``: knobs Oracle sets (``ORACLE_KNOBS``), e.g. the intake a run starts
    from; ``commit=False`` leaves the commit to the caller. ``principal`` an actor string
    (``audit.ORACLE``): a run Oracle starts on its own (the daily request triage), created
    for the member ``created_by`` it acts as (its run token acts for them)."""
    flow = flows.FLOWS[body.flow]
    if flow.entry and entry_knobs is None:
        raise Invalid(f"start a {flow.title} run from {flow.entry}")
    if flow.key == "launch_kit" and not (oracle_knobs or {}).get("launch_id"):
        raise Invalid(
            "the Launch kit flow starts from a launch: open it on Roadmap › Launches and "
            "choose Draft with Oracle"
        )
    if flow.key == "update_draft" and not has_role(principal.role, "owner"):
        # H8: the CEO decides what is said to the board and investors.
        raise Forbidden("Only an owner can draft an update")
    if flow.key == "pricing_memo" and await autonomy.level(db, "pricing_input") == "observe":
        # H9 / H11: at Observe Oracle keeps the evidence and writes no memo.
        raise RunError("Oracle writes no pricing memo at Observe")
    knobs = _resolve_knobs(flow, body.knobs)
    await _one_build_at_a_time(db, flow)
    document_id, oracle = await _resolve_inputs(
        db,
        flow,
        _Inputs(body.document, body.source, body.source_version, body.template, body.theme),
    )
    if document_id is not None:
        # H11: at Observe Oracle drafts no strategy, vision, nor update for people outside.
        from oracle import autonomy_drafts

        kind = await db.scalar(select(Document.kind).where(Document.id == document_id))
        if refusal := await autonomy_drafts.run_refusal(db, flow.key, kind):
            raise RunError(refusal)
    if flow.key == "update_draft" and "depth" not in body.knobs.model_fields_set:
        # H8: an investor update is quick by default ($4.50); a board update standard.
        template = (
            await db.scalar(select(Document.template).where(Document.id == document_id))
            if document_id is not None
            else None
        )
        depth = "standard" if template == "board-product" else "quick"
        knobs = _resolve_knobs(flow, body.knobs.model_copy(update={"depth": depth}))
    extra = {k: v for k, v in (oracle_knobs or {}).items() if k in ORACLE_KNOBS}
    extra.pop("reuse_baseline", None)
    if body.knobs.reuse_baseline:
        extra["reuse_baseline"] = await _reuse_knob(db, flow)
    extra.pop("target_goals", None)
    if goals := await _target_goals(db, flow, body.knobs.goals):
        extra["target_goals"] = goals
    extra.pop("target_features", None)
    if features := await _target_features(db, flow, body.knobs.features):
        extra["target_features"] = features
    extra.pop("reuse_draft_items", None)
    extra.pop("draft_items_reused", None)
    if body.knobs.reuse_draft_items is False and flow.key == REUSES_DRAFT_ITEMS:
        extra["reuse_draft_items"] = False
    if body.strategy_brief is not None:
        if flow.key != "strategy_draft":
            raise Invalid("only a Vision or strategy draft run takes a brief")
        from oracle.strategy import brief as strategy_brief

        try:
            extra["strategy_brief"] = await strategy_brief.resolve(
                db, document_id, body.strategy_brief
            )
        except ValueError as exc:
            raise Invalid(exception_text(exc)) from exc
    run = Run(
        flow=flow.key,
        status="draft",
        knobs={**knobs.as_json(), **oracle, **extra, **(entry_knobs or {})},
        document_id=document_id,
        created_by=principal.id if isinstance(principal, Principal) else created_by,
    )
    db.add(run)
    await db.flush()
    await _reset_segments(db, run, flow)
    details: dict[str, Any] = {"flow": flow.key}
    if oracle.get("source_version_id"):
        details["source_version_id"] = oracle["source_version_id"]
    if extra.get("intake_id"):
        details["intake_id"] = extra["intake_id"]
    await audit.record(db, principal, "run.created", "run", run.id, details)
    if commit:
        await db.commit()
    return run.id


async def _target_goals(
    db: AsyncSession, flow: flows.FlowDef, refs: list[str] | None
) -> list[dict[str, str]]:
    """The ``target_goals`` knob (#260): each named goal (key or id), confirmed, once, in
    the order named. Only a Baseline to PRD run names goals."""
    if not refs:
        return []
    if flow.key != "baseline_to_prd":
        raise Invalid("only a Ground Truth to PRD run names the goals it serves")
    refs = list(dict.fromkeys(r.strip() for r in refs))
    ids = [uuid.UUID(r) for r in refs if is_uuid(r)]
    rows = (
        await db.scalars(
            select(Entity).where(
                Entity.type == "goal",
                Entity.status == "confirmed",
                or_(Entity.key.in_(refs), Entity.id.in_(ids)),
            )
        )
    ).all()
    found = {e.key: e for e in rows} | {str(e.id): e for e in rows}
    missing = [r for r in refs if r not in found]
    if missing:
        raise Invalid(f"not a confirmed goal: {', '.join(missing)}")
    goals = list({found[r].id: found[r] for r in refs}.values())
    return [{"id": str(g.id), "key": g.key, "title": g.title} for g in goals]


async def _target_features(
    db: AsyncSession, flow: flows.FlowDef, refs: list[str] | None
) -> list[dict[str, str]]:
    """The ``target_features`` knob ("Add it to a PRD"): each named Ground Truth feature
    (key or id, not rejected), once, in the order named. Only a Baseline to PRD run adds
    features to its PRD."""
    if not refs:
        return []
    if flow.key != "baseline_to_prd":
        raise Invalid("only a Ground Truth to PRD run adds features to its PRD")
    refs = list(dict.fromkeys(r.strip() for r in refs))
    ids = [uuid.UUID(r) for r in refs if is_uuid(r)]
    rows = (
        await db.scalars(
            select(Entity).where(
                Entity.type == "feature",
                Entity.status != "rejected",
                or_(Entity.key.in_(refs), Entity.id.in_(ids)),
            )
        )
    ).all()
    found = {e.key: e for e in rows} | {str(e.id): e for e in rows}
    if any(r not in found for r in refs):
        # A key a feature had before it joined (its code is its key now) still names it.
        aliases = {k: v for k, v in (await fixes.former_keys(db, live=True)).items()
                   if k in refs and k not in found}  # fmt: skip
        for key, fid in aliases.items():
            feature = await db.get(Entity, fid)
            if feature is not None and feature.type == "feature" and feature.status != "rejected":
                found[key] = feature
    missing = [r for r in refs if r not in found]
    if missing:
        raise Invalid(f"not a Ground Truth feature: {', '.join(missing)}")
    features = list({found[r].id: found[r] for r in refs}.values())
    return [{"id": str(f.id), "key": f.key, "title": f.title} for f in features]


async def _current_inputs(db: AsyncSession, run: Run) -> _Inputs:
    knobs = run.knobs or {}
    source = number = None
    source_id = service._source_id(run)
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
    run = await service._get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError("only a draft run can be changed")
    flow = _flow(run)
    oracle = {k: run.knobs[k] for k in ORACLE_KNOBS if k in (run.knobs or {})}
    stored = {k: v for k, v in run.knobs.items() if k not in ORACLE_KNOBS}
    if body.knobs is not None:
        stored = _resolve_knobs(flow, body.knobs).as_json()
    changed = body.model_fields_set & {"document", "source", "source_version", "template", "theme"}
    if flow.entry and any(getattr(body, k) is not None for k in changed):
        raise Invalid(f"a {flow.title} run's document and source come from {flow.entry}")
    if any(getattr(body, k) is not None for k in changed):
        current = await _current_inputs(db, run)
        if body.source is not None:
            # Another PRD: its latest approved version unless one is named.
            current.source, current.source_version = body.source, None
        for k in ("document", "source_version", "template", "theme"):
            if getattr(body, k) is not None:
                setattr(current, k, getattr(body, k))
        intake = {
            k: v
            for k, v in oracle.items()
            if k.startswith("intake_")
            or k in ("reuse_baseline", "target_goals", "target_features", "reuse_draft_items")
        }
        run.document_id, oracle = await _resolve_inputs(db, flow, current)
        oracle.update(intake)
    if body.knobs is not None and body.knobs.reuse_baseline is not None:
        oracle.pop("reuse_baseline", None)
        if body.knobs.reuse_baseline:
            oracle["reuse_baseline"] = await _reuse_knob(db, flow)
    if body.knobs is not None and body.knobs.goals is not None:
        oracle.pop("target_goals", None)
        if goals := await _target_goals(db, flow, body.knobs.goals):
            oracle["target_goals"] = goals
    if body.knobs is not None and body.knobs.features is not None:
        oracle.pop("target_features", None)
        if features := await _target_features(db, flow, body.knobs.features):
            oracle["target_features"] = features
    # E1 part B: what the run reuses is decided again by its next estimate.
    oracle.pop("draft_items_reused", None)
    if body.knobs is not None and body.knobs.reuse_draft_items is not None:
        oracle.pop("reuse_draft_items", None)
        if body.knobs.reuse_draft_items is False and flow.key == REUSES_DRAFT_ITEMS:
            oracle["reuse_draft_items"] = False
    run.knobs = {**stored, **oracle}
    await _reset_segments(db, run, flow)
    await audit.record(db, principal, "run.updated", "run", run.id, {})
    await db.commit()


async def estimate(db: AsyncSession, principal: Principal | str, run_id: uuid.UUID) -> EstimateOut:
    run = await service._get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError("only a draft run can be estimated")
    await _recheck_reuse(db, run)
    flow, knobs = _flow(run), _knobs(run)
    reused = (run.knobs or {}).get("reuse_baseline")
    items_reused = await _draft_items_to_reuse(db, run)
    _set_knob(run, "draft_items_reused", items_reused)
    zone = (
        await company_time.company_time_zone(db)
        if reused or items_reused
        else company_time.DEFAULT_ZONE
    )
    segments = {s.name: s for s in await service._segments(db, run.id)}
    rows = []
    for i, sdef in enumerate(flow.segments, start=1):
        amount = flows.segment_estimate(sdef, knobs)
        skip = bool(reused) and sdef.name == "baseline"
        off = _skipped_off(sdef, knobs)
        skip_items = items_reused is not None and sdef.name == "roadmap_items"
        if skip or off or skip_items:
            amount = Decimal("0.00")
        segments[sdef.name].estimate_usd = amount
        note = None
        if skip:
            note = f"Current Ground Truth, approved {reuse.short_date(reused['approved_at'], zone)}"
        elif items_reused is not None and skip_items:
            note = _items_reused_note(items_reused, zone)
        elif off:
            note = OFF_NOTE
        rows.append(
            SegmentEstimate(
                seq=i,
                name=sdef.name,
                title=sdef.title,
                roles=knobs.roles[sdef.name],
                estimate_usd=float(amount),
                reused=skip or skip_items,
                reused_from_version=items_reused["version"]
                if items_reused is not None and skip_items
                else None,
                note=note,
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


async def start(db: AsyncSession, principal: Principal | str, run_id: uuid.UUID) -> None:
    run = await service._get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError(f"run is {run.status}, not a draft")
    if run.estimate_usd is None:
        raise RunError("estimate the run first: press Estimate, then Start run")
    await _recheck_reuse(db, run)
    await _recheck_draft_items(db, run)
    await _one_build_at_a_time(db, _flow(run))
    knobs = _knobs(run)
    source_id = service._source_id(run)
    if source_id is not None and await db.get(DocumentVersion, source_id) is None:
        raise Invalid("the PRD version this roadmap is built from no longer exists")
    # A run started from an intake (C5): a draft waits at the draft gate, and it reads
    # the intake's answers given before now, whichever segment asks.
    from oracle.intake import drafting

    pinned = await drafting.on_start(db, run, principal)
    if knobs.budget_usd is not None and run.estimate_usd > knobs.budget_usd:
        raise Invalid(
            f"the estimate (${run.estimate_usd:.2f}) is over the budget "
            f"(${knobs.budget_usd:.2f}): lower the depth or roles, or raise the budget"
        )
    # The sources the run reads are pinned now, for the user who created it; a run
    # started from an intake reads the snapshot the intake pinned (S4).
    snapshot = await _intake_snapshot(db, run)
    if snapshot is None:
        snapshot = Snapshot(
            label=f"Run {str(run.id)[:8]} ({_flow(run).title})",
            as_of=service._now(),
            created_by=run.created_by,
        )
        db.add(snapshot)
        await db.flush()
    run.snapshot_id = snapshot.id
    for key, value in (pinned or {}).items():
        _set_knob(run, key, value)
    # #541 part 5: a draft run of a company-wide document reads as a member.
    await _decide_member_view(db, run)
    if any(flows.BRIEFS_FILE in s.outputs for s in _flow(run).segments):
        # F5-2: the shared code maps the run's briefs cite, recorded now (S6: a map made
        # private later stops new uses; this run keeps what it read).
        from oracle.engineering import codemaps

        used = await codemaps.for_run(db)
        if used:
            _set_knob(run, "code_maps", used)
    if source_id is not None:
        # Every segment, attempt and change request of the run reads these (A1).
        _set_knob(run, "planning_horizons", await company_horizons(db))
    if run.estimate_usd > flows.APPROVAL_THRESHOLD_USD:
        run.status = "awaiting_approval"
        await audit.record(
            db, principal, "run.awaiting_approval", "run", run.id, {"usd": str(run.estimate_usd)}
        )
        await webhooks.capture(db, "run.awaiting_approval", principal, run_id=run.id)
        await db.commit()
        return
    await audit.record(db, principal, "run.started", "run", run.id, {})
    await webhooks.capture(db, "run.started", principal, run_id=run.id)
    await _launch(db, run, principal)
    await db.commit()  # the router submits it (submit_queued), outside the gate


async def _intake_snapshot(db: AsyncSession, run: Run) -> Snapshot | None:
    raw = (run.knobs or {}).get("intake_snapshot_id")
    if not raw:
        return None
    try:
        return await db.get(Snapshot, uuid.UUID(str(raw)))
    except ValueError:
        return None


async def approve(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    run = await service._get_run(db, run_id, lock=True)
    if run.status != "awaiting_approval":
        raise RunError(f"run is {run.status}, not awaiting approval")
    # A run reusing the baseline: still reusable now (else 409, nothing changed, C4).
    await _recheck_reuse(db, run)
    await _recheck_draft_items(db, run)
    run.approved_by = principal.id
    run.approved_at = service._now()
    await audit.record(db, principal, "run.approved", "run", run.id, {"usd": str(run.estimate_usd)})
    await webhooks.capture(db, "run.started", principal, run_id=run.id)
    await _launch(db, run, principal)
    await db.commit()  # the router submits it (submit_queued), outside the gate


async def _launch(db: AsyncSession, run: Run, principal: Principal | str | None = None) -> None:
    run.status = "running"
    run.started_at = service._now()
    items_reused = (run.knobs or {}).get("draft_items_reused")
    base = run.estimate_usd
    if items_reused:
        # E1 part B: the ceiling counts the reused items step at its nominal cost, so a
        # send-back that derives the items again (a paid step) does not pause the run.
        base += flows.segment_estimate(_flow(run).segment("roadmap_items"), _knobs(run))
    ceiling = (base * flows.OVERRUN_FACTOR).quantize(Decimal("0.0001"))
    _set_knob(run, "spend_ceiling_usd", str(ceiling))
    segments = await service._segments(db, run.id)
    knobs = _knobs(run)
    for s in segments:
        if _skipped_off(_flow(run).segment(s.name), knobs):
            _skip_off(s)
    first = segments[0]
    reused = (run.knobs or {}).get("reuse_baseline")
    if reused and first.name == "baseline" and len(segments) > 1:
        await _skip_reused_baseline(db, run, first, reused, principal)
        first = segments[1]
    if items_reused and first.name == "roadmap_items":
        try:
            if await _reuse_draft_items(db, run, first, segments, items_reused, principal):
                return
        except safe_yaml.ParseBusy:
            # No free worker for the items check: the segment stays succeeded with its
            # advance "opening", and the next tick advances it again (_resume_advance).
            log.warning("run %s: the reused items wait for a parse worker", run.id)
            return
    # Workflow mode covers the segments from ``first`` on: no baseline step is submitted.
    await service._submit(db, run, first, segments)


def _skip_off(segment: RunSegment) -> None:
    """F4: the segment's stop is off, so nothing of it runs (recorded skipped at no cost)."""
    art = _art(segment)
    art["note"] = OFF_NOTE
    _set_art(segment, art)
    segment.status = "skipped"
    segment.estimate_usd = Decimal("0.00")
    segment.cost_usd = Decimal("0")
    segment.finished_at = service._now()
    segment.error = None


# E1 part B (decided 2026-10-21, "Reuse items"): the flow whose items step reuses the
# approved source version's draft items.
REUSES_DRAFT_ITEMS = "prd_to_roadmap"


async def _draft_items_to_reuse(db: AsyncSession, run: Run) -> dict[str, Any] | None:
    """The ``draft_items_reused`` knob of a Build roadmap run: the source version's draft
    items when they may be reused and the run does not derive them again; else None."""
    if run.flow != REUSES_DRAFT_ITEMS or (run.knobs or {}).get("reuse_draft_items") is False:
        return None
    source_id = service._source_id(run)
    if source_id is None:
        return None
    from oracle.roadmap import draft_items

    found = await draft_items.reusable(db, source_id)
    version = await db.get(DocumentVersion, source_id)
    if found is None or version is None:
        return None
    row = found[0]
    return {
        "draft_roadmap_id": str(row.id),
        "version": version.number,
        "ready_at": row.ready_at.isoformat() if row.ready_at else None,
    }


def _items_reused_note(knob: dict[str, Any], zone: str) -> str:
    """'Reused: the roadmap items of v3, derived 20 Oct', the Company time zone's day."""
    note = f"Reused: the roadmap items of v{knob['version']}"
    if knob.get("ready_at"):
        note += f", derived {company_time.day_first_in_words(knob['ready_at'], zone)}"
    return note


async def _recheck_draft_items(db: AsyncSession, run: Run) -> None:
    """A run estimated with reused draft items: still the same items (else 409, nothing
    changed): a Derive again or a new derivation since makes the estimate stale."""
    knob = (run.knobs or {}).get("draft_items_reused")
    if knob and await _draft_items_to_reuse(db, run) != knob:
        raise RunError(
            "the PRD version's draft roadmap items changed since the estimate: "
            "estimate the run again"
        )


async def _reuse_draft_items(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    knob: dict[str, Any],
    principal: Principal | str | None,
) -> bool:
    """E1 part B: the run's roadmap_items segment reuses the source version's draft items.
    Their roadmap_items.yaml is written from the stored rows, the segment succeeds at no
    cost with nothing submitted, and it is advanced: its stop opens on those items (or,
    with the stop off, the roadmap draft is queued). False when they are gone."""
    from oracle.roadmap import draft_items

    source_id = service._source_id(run)
    found = await draft_items.reusable(db, source_id) if source_id else None
    version = await db.get(DocumentVersion, source_id) if source_id else None
    prd = await db.get(Document, version.document_id) if version is not None else None
    if found is None or version is None or prd is None:
        return False
    row, rows = found
    now = service._now()
    note = _items_reused_note(knob, await company_time.company_time_zone(db))
    art = _art(segment)
    art["files"] = {ITEMS_FILE: draft_items.items_yaml(prd.slug, version.number, rows)}
    art["attempts"].append(
        {
            "attempt": len(art["attempts"]) + 1,
            "workflow_id": None,
            "submitted_at": now.isoformat(),
            "cost_usd": 0,
            "note": None,
            "state": "succeeded",
        }
    )
    art["reused_items"] = knob
    art["note"] = note
    # Until it is advanced: a busy parse pool stops the advance, and the tick resumes it.
    art["attempts"][-1]["advanced"] = "opening"
    _set_art(segment, art)
    segment.status = "succeeded"
    segment.estimate_usd = Decimal("0.00")
    segment.cost_usd = Decimal("0")
    segment.started_at = segment.started_at or now
    segment.finished_at = now
    segment.error = None
    await audit.record(
        db,
        principal if principal is not None else audit.ORACLE,
        "run.items_reused",
        "run",
        run.id,
        {"draft_roadmap_id": str(row.id), "version": version.number, "items": len(rows)},
    )
    await service._advance(db, run, segment, segments)
    return True


async def _skip_reused_baseline(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    reused: dict[str, Any],
    principal: Principal | str | None,
) -> None:
    """C4: the run uses the current baseline. Its baseline segment is recorded skipped at
    no cost and its Confirm the baseline stop skipped; nothing runs for them."""
    zone = await company_time.company_time_zone(db)
    note = f"Reused the Ground Truth approved {reuse.short_date(reused['approved_at'], zone)}"
    now = service._now()
    art = _art(segment)
    art["reused"] = reused
    art["note"] = note
    _set_art(segment, art)
    segment.status = "skipped"
    segment.estimate_usd = Decimal("0.00")
    segment.cost_usd = Decimal("0")
    segment.finished_at = now
    segment.error = None
    db.add(
        Checkpoint(
            run_id=run.id,
            kind="baseline_confirm",
            status="skipped",
            approver_role=_flow(run).segment(segment.name).approver_role,
            note=note,
            payload={
                "segment_seq": segment.seq,
                "segment": segment.name,
                "reused_checkpoint_id": reused.get("checkpoint_id"),
            },
            decided_at=now,
        )
    )
    await audit.record(
        db,
        principal if principal is not None else audit.ORACLE,
        "run.baseline_reused",
        "run",
        run.id,
        {"checkpoint_id": reused.get("checkpoint_id"), "approved_at": reused.get("approved_at")},
    )
