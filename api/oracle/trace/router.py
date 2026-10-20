"""Trace, impact, staleness and evidence-inspector routes (CR-05, §7, §11.5).

Reachable from a document version (``/v1/documents/{doc}/versions/{n}/...``) and from a
baseline node (``/v1/baseline/entities/{entity_id}/...``). Everyone reads (viewer+);
approvers record section links and dependencies and settle staleness. Every write is
audited; the tenant-scoped session keeps each company to its own rows (another
company's id is a 404).

Importing this module registers the ``trace.mark_stale`` change handler.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import case, func, or_, select

from oracle import audit, changes
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.baseline.evidence import run_versions, withheld_from
from oracle.baseline.models import Entity, Evidence
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.sources.models import Source, SourceItem
from oracle.trace import evidence, impact, staleness, views
from oracle.trace.outputs import FRESHNESS_ORDER, describe, recorded_reasons
from oracle.trace.schemas import (
    DependenciesCreate,
    EntityTrace,
    EvidenceInspector,
    ImpactReport,
    SectionLinksCreate,
    StalenessAction,
    StaleOutputsPage,
    TraceOutput,
    VersionTrace,
)
from oracle.v2.models import (
    ArtifactDependency,
    ChangeEvent,
    DocumentComposition,
    DocumentSectionLink,
)
from oracle.v2.schemas import ArtifactDependencyOut, DocumentSectionLinkOut, Freshness

changes.register_handler(staleness.HANDLER, staleness.mark_stale, subjects=staleness.SUBJECTS)

router = APIRouter(prefix="/v1", tags=["trace"])

Reader = Annotated[Principal, Depends(require_role("viewer"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]


def _404(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail)


async def _version(db, doc: str, n: int) -> tuple[Document, DocumentVersion]:
    try:
        document = await docs_service.get_document_or_404(db, doc)
        version = await docs_service.get_version_row(db, document, n)
    except docs_service.NotFoundError as exc:
        raise _404(str(exc)) from exc
    return document, version


async def _entity(db, entity_id: uuid.UUID) -> Entity:
    entity = await db.get(Entity, entity_id)
    if entity is None:
        raise _404("Entity not found")
    return entity


# --- from a document version ---------------------------------------------------------------


@router.get("/documents/{doc}/versions/{n}/trace", response_model=VersionTrace)
async def get_version_trace(doc: str, n: int, principal: Reader, db: TenantDB) -> VersionTrace:
    """A version's trace: its anchors (template, composition revision, snapshots), each
    section's links to the baseline and the goals they serve, and the outputs that
    depend on each section (artifacts, roadmap items) with their freshness."""
    document, version = await _version(db, doc, n)
    return await views.version_trace(db, principal, document, version)


@router.get("/documents/{doc}/versions/{n}/evidence", response_model=EvidenceInspector)
async def get_version_evidence(
    doc: str,
    n: int,
    principal: Reader,
    db: TenantDB,
    section: Annotated[str | None, Query(max_length=200)] = None,
) -> EvidenceInspector:
    """The evidence inspector: each section's claim-to-source links (strongest source
    first) and the draft's own per-claim citations. Rendered bodies carry none of these
    (O1c); exports list them in the Sources and data points appendix."""
    document, version = await _version(db, doc, n)
    return await evidence.inspector(db, principal, document, version, section)


@router.get("/documents/{doc}/versions/{n}/impact", response_model=ImpactReport)
async def get_version_impact(doc: str, n: int, principal: Reader, db: TenantDB) -> ImpactReport:
    """What this version changes for outputs built on earlier versions, why, and a
    targeted regeneration plan (proposals only), with the changes recorded for it."""
    document, version = await _version(db, doc, n)
    return await impact.for_version(db, document, version)


async def _check_target(db, principal: Principal, link) -> None:
    if link.entity_id is not None and await db.get(Entity, link.entity_id) is None:
        raise HTTPException(422, f"unknown baseline entity {link.entity_id}")
    if link.evidence_id is not None and await db.get(Evidence, link.evidence_id) is None:
        raise HTTPException(422, f"unknown evidence {link.evidence_id}")
    if link.source_item_id is not None:
        row = (
            await db.execute(
                select(Source.owner_user_id, SourceItem.deleted_at)
                .join(SourceItem, SourceItem.source_id == Source.id)
                .where(SourceItem.id == link.source_item_id)
            )
        ).first()
        # Only a source's owner reads its items (AUD-9): to others it does not exist.
        missing = row is None or row[0] != principal.user_id
        if not missing and principal.is_run:
            # Nor to a run, an item it may not read (S6): withheld by its user's
            # intakes, deleted upstream, or ever frozen with no release readable now.
            frozen = await run_versions(db, principal, {link.source_item_id})
            missing = (
                row[1] is not None
                or link.source_item_id in await withheld_from(db, principal)
                or (link.source_item_id in frozen and frozen[link.source_item_id] is None)
            )
        if missing:
            raise HTTPException(422, f"unknown source item {link.source_item_id}")


@router.post(
    "/documents/{doc}/versions/{n}/section-links",
    response_model=list[DocumentSectionLinkOut],
    status_code=status.HTTP_201_CREATED,
)
async def create_section_links(
    doc: str, n: int, body: SectionLinksCreate, principal: Approver, db: TenantDB
) -> list[DocumentSectionLinkOut]:
    """Link sections of a version to baseline items, evidence or source items (the
    internal per-claim links behind O1c). Pinned to the section's current hash. An
    approved version's links are pinned with it (409)."""
    document, version = await _version(db, doc, n)
    if version.approved_at is not None:
        raise HTTPException(409, "an approved version's evidence links are pinned")
    hashes = dict(
        (
            await db.execute(
                select(Section.section_key, Section.content_hash).where(
                    Section.version_id == version.id
                )
            )
        ).all()
    )
    comp = await db.scalar(
        select(DocumentComposition).where(DocumentComposition.document_id == document.id)
    )
    rows = []
    for link in body.links:
        if link.section_key not in hashes:
            raise HTTPException(422, f"version {n} has no section {link.section_key!r}")
        await _check_target(db, principal, link)
        row = DocumentSectionLink(
            document_id=document.id,
            version_id=version.id,
            section_key=link.section_key,
            section_hash=hashes[link.section_key],
            composition_revision=comp.current_revision if comp else None,
            module_key=link.module_key,
            kind=link.kind,
            entity_id=link.entity_id,
            evidence_id=link.evidence_id,
            source_item_id=link.source_item_id,
            precision=link.precision,
            claim=link.claim,
            created_by=principal.id,
        )
        db.add(row)
        rows.append(row)
    await db.flush()
    await audit.record(
        db, principal, "trace.section_links.created", "document_version", version.id,
        {"links": [str(r.id) for r in rows],
         "sections": sorted({r.section_key for r in rows})},
    )  # fmt: skip
    await db.commit()
    for r in rows:
        await db.refresh(r)
    return [DocumentSectionLinkOut.model_validate(r) for r in rows]


@router.delete("/section-links/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_section_link(item_id: uuid.UUID, principal: Approver, db: TenantDB) -> Response:
    """Remove a section link. An approved version's links are pinned (409)."""
    link = await db.get(DocumentSectionLink, item_id)
    if link is None:
        raise _404("Section link not found")
    if link.version_id is not None:
        version = await db.get(DocumentVersion, link.version_id)
        if version is not None and version.approved_at is not None:
            raise HTTPException(409, "an approved version's evidence links are pinned")
    await audit.record(
        db, principal, "trace.section_link.deleted", "document_section_link", link.id,
        {"document_id": str(link.document_id), "section_key": link.section_key},
    )  # fmt: skip
    await db.delete(link)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- from a baseline node --------------------------------------------------------------------


@router.get("/baseline/entities/{entity_id}/trace", response_model=EntityTrace)
async def get_entity_trace(entity_id: uuid.UUID, principal: Reader, db: TenantDB) -> EntityTrace:
    """A baseline node's trace: up to the goals it serves, down to requirements and
    acceptance criteria, the sections linking it and the outputs built on it; for a
    requirement, its assumptions, blockers, alternatives, experiments, decisions, owners
    and risks. A feature serving no confirmed goal is flagged, with its priority."""
    return await views.entity_trace(db, await _entity(db, entity_id))


@router.get("/baseline/entities/{entity_id}/impact", response_model=ImpactReport)
async def get_entity_impact(entity_id: uuid.UUID, principal: Reader, db: TenantDB) -> ImpactReport:
    """What a change to this node would make potentially stale, why, and a targeted
    regeneration plan. A preview: nothing is marked."""
    return await impact.for_entity(db, await _entity(db, entity_id))


# --- changes and staleness ---------------------------------------------------------------------


@router.get("/trace/changes/{change_id}/impact", response_model=ImpactReport)
async def get_change_impact(change_id: uuid.UUID, principal: Reader, db: TenantDB) -> ImpactReport:
    """A recorded change: the outputs it marked potentially stale, why, and a targeted
    regeneration plan (proposals only)."""
    event = await db.get(ChangeEvent, change_id)
    if event is None:
        raise _404("Change event not found")
    return await impact.for_change(db, event)


@router.get("/trace/staleness", response_model=StaleOutputsPage)
async def list_stale_outputs(
    principal: Reader,
    db: TenantDB,
    document_id: uuid.UUID | None = None,
    freshness: Freshness | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> StaleOutputsPage:
    """Outputs that are not fresh (potentially stale or under review by default), a page
    at a time, stalest first, with the dependencies that make them so and why (from the
    change that marked each); ``document_id`` filters by upstream document."""
    states = [freshness] if freshness else ["potentially_stale", "under_review"]
    conditions = [ArtifactDependency.freshness.in_(states)]
    if document_id is not None:
        conditions.append(
            ArtifactDependency.upstream_version_id.in_(
                select(DocumentVersion.id).where(DocumentVersion.document_id == document_id)
            )
        )
    rank = case({k: v for k, v in FRESHNESS_ORDER.items()}, value=ArtifactDependency.freshness)
    output = (ArtifactDependency.artifact_version_id, ArtifactDependency.document_version_id)
    grouped = select(*output).where(*conditions).group_by(*output)
    total = await db.scalar(select(func.count()).select_from(grouped.subquery()))
    page = (
        await db.execute(
            grouped.order_by(
                func.max(rank).desc(),
                func.min(ArtifactDependency.created_at),
                func.coalesce(*output),
            )
            .limit(limit)
            .offset(offset)
        )
    ).all()
    keys = [("artifact_version", a) if a else ("document_version", d) for a, d in page]
    items: list[TraceOutput] = []
    if keys:
        av_ids = [i for k, i in keys if k == "artifact_version"]
        dv_ids = [i for k, i in keys if k == "document_version"]
        deps = list(
            (
                await db.scalars(
                    select(ArtifactDependency)
                    .where(
                        *conditions,
                        or_(
                            ArtifactDependency.artifact_version_id.in_(av_ids),
                            ArtifactDependency.document_version_id.in_(dv_ids),
                        ),
                    )
                    .order_by(ArtifactDependency.created_at, ArtifactDependency.id)
                )
            ).all()
        )
        views = {
            (v.kind, v.artifact_version_id or v.document_version_id): v
            for v in await describe(db, deps, await recorded_reasons(db, deps))
        }
        items = [views[k] for k in keys if k in views]
    nxt = offset + limit
    return StaleOutputsPage(
        items=items, total=total or 0, limit=limit, offset=offset,
        next_offset=nxt if nxt < (total or 0) else None,
    )  # fmt: skip


async def _downstream_view(db, body) -> TraceOutput:
    flt = (
        ArtifactDependency.artifact_version_id == body.artifact_version_id
        if body.artifact_version_id
        else ArtifactDependency.document_version_id == body.document_version_id
    )
    deps = list((await db.scalars(select(ArtifactDependency).where(flt))).all())
    described = await describe(db, deps, await recorded_reasons(db, deps))
    if not described:
        raise _404("Output not found")
    return described[0]


@router.post("/trace/staleness/actions", response_model=TraceOutput)
async def act_on_staleness(body: StalenessAction, principal: Approver, db: TenantDB) -> TraceOutput:
    """Settle a stale output: ``review`` (someone is checking it), ``accept_regeneration``
    (its regeneration proposal is accepted) or ``reconcile`` (confirmed still valid
    against the current upstream, with a reason). Recorded and audited; the output's
    content and approval are never changed."""
    try:
        await staleness.act(
            db, principal, body.action, artifact_version_id=body.artifact_version_id,
            document_version_id=body.document_version_id,
            dependency_ids=body.dependency_ids, reason=body.reason,
        )  # fmt: skip
    except staleness.NotFound as exc:
        raise _404(str(exc)) from exc
    except staleness.Invalid as exc:
        raise HTTPException(422, str(exc)) from exc
    except staleness.Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    await db.commit()
    return await _downstream_view(db, body)


@router.post(
    "/trace/dependencies",
    response_model=list[ArtifactDependencyOut],
    status_code=status.HTTP_201_CREATED,
)
async def create_artifact_dependencies(
    body: DependenciesCreate, principal: Approver, db: TenantDB
) -> list[ArtifactDependencyOut]:
    """Record what an artifact version (or a derived document version) was made from:
    document sections, whole document versions or baseline items, anchored at their
    current hash. Idempotent per anchor."""
    try:
        rows = await staleness.add_dependencies(
            db, principal, artifact_version_id=body.artifact_version_id,
            document_version_id=body.document_version_id, upstream=body.upstream,
        )  # fmt: skip
    except staleness.NotFound as exc:
        raise _404(str(exc)) from exc
    except staleness.Invalid as exc:
        raise HTTPException(422, str(exc)) from exc
    await db.commit()
    for r in rows:
        await db.refresh(r)
    return [ArtifactDependencyOut.model_validate(r) for r in rows]
