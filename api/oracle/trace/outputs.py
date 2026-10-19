"""Describing downstream outputs (artifact versions and document versions such as
roadmaps) and the dependencies that tie them to their upstream."""

import uuid
from collections import defaultdict

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.trace.schemas import (
    CATEGORY_OF_KIND,
    TraceDependency,
    TraceEntityRef,
    TraceOutput,
    TraceUpstream,
)
from oracle.v2.models import ArtifactDependency, ArtifactRequest, ArtifactVersion

# Worst first: an output is as fresh as its stalest dependency.
FRESHNESS_ORDER = {"fresh": 0, "reconciled": 1, "under_review": 2, "potentially_stale": 3}


def worst(values) -> str:
    return max(values, key=lambda v: FRESHNESS_ORDER[v], default="fresh")


def entity_ref(e: Entity) -> TraceEntityRef:
    return TraceEntityRef(
        id=e.id,
        type=e.type,
        key=e.key,
        title=e.title,
        status=e.status,
        locked=e.locked,
        confidence=None if e.confidence is None else float(e.confidence),
    )


def downstream_key(dep: ArtifactDependency) -> tuple[str, uuid.UUID]:
    if dep.artifact_version_id is not None:
        return "artifact_version", dep.artifact_version_id
    return "document_version", dep.document_version_id  # type: ignore[return-value]


def version_status(version: DocumentVersion, document: Document, latest: int) -> str:
    if version.approved_at is not None:
        return "approved"
    if version.number < latest:
        return "superseded"
    return document.status


async def latest_numbers(db: AsyncSession, document_ids: set[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not document_ids:
        return {}
    rows = await db.execute(
        select(DocumentVersion.document_id, func.max(DocumentVersion.number))
        .where(DocumentVersion.document_id.in_(document_ids))
        .group_by(DocumentVersion.document_id)
    )
    return dict(rows.all())  # type: ignore[arg-type]


async def refresh_aggregates(db: AsyncSession, artifact_version_ids: set[uuid.UUID]) -> None:
    """``artifact_versions.freshness`` is the worst of its dependencies' (kept for
    listing). A version whose dependencies are all gone keeps what it had."""
    if not artifact_version_ids:
        return
    rows = await db.execute(
        select(ArtifactDependency.artifact_version_id, ArtifactDependency.freshness).where(
            ArtifactDependency.artifact_version_id.in_(artifact_version_ids)
        )
    )
    by_version: dict[uuid.UUID, list[str]] = defaultdict(list)
    for av_id, freshness in rows.all():
        by_version[av_id].append(freshness)
    for av_id, values in by_version.items():
        av = await db.get(ArtifactVersion, av_id)
        if av is not None and av.freshness != worst(values):
            av.freshness = worst(values)
    await db.flush()


async def describe(
    db: AsyncSession,
    deps: list[ArtifactDependency],
    reasons: dict[uuid.UUID, list[str]] | None = None,
) -> list[TraceOutput]:
    """One view per downstream output of ``deps``, with those dependencies (and their
    reasons) under it. Ordered: stalest first, then by title."""
    reasons = reasons or {}
    if not deps:
        return []
    av_ids = {d.artifact_version_id for d in deps if d.artifact_version_id}
    dv_ids = {d.document_version_id for d in deps if d.document_version_id}
    up_ids = {d.upstream_version_id for d in deps if d.upstream_version_id}
    ent_ids = {d.upstream_entity_id for d in deps if d.upstream_entity_id}

    artifacts: dict[uuid.UUID, tuple[ArtifactVersion, ArtifactRequest]] = {}
    if av_ids:
        rows = await db.execute(
            select(ArtifactVersion, ArtifactRequest)
            .join(ArtifactRequest, ArtifactRequest.id == ArtifactVersion.request_id)
            .where(ArtifactVersion.id.in_(av_ids))
        )
        artifacts = {av.id: (av, req) for av, req in rows.all()}
    versions: dict[uuid.UUID, tuple[DocumentVersion, Document]] = {}
    if dv_ids | up_ids:
        rows = await db.execute(
            select(DocumentVersion, Document)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(DocumentVersion.id.in_(dv_ids | up_ids))
        )
        versions = {v.id: (v, d) for v, d in rows.all()}
    entities = {}
    if ent_ids:
        entities = {
            e.id: e for e in (await db.scalars(select(Entity).where(Entity.id.in_(ent_ids)))).all()
        }
    latest = await latest_numbers(db, {versions[i][1].id for i in dv_ids if i in versions})
    # A document version's freshness is the worst of all its dependencies.
    doc_freshness: dict[uuid.UUID, str] = {}
    if dv_ids:
        rows = await db.execute(
            select(ArtifactDependency.document_version_id, ArtifactDependency.freshness).where(
                ArtifactDependency.document_version_id.in_(dv_ids)
            )
        )
        grouped: dict[uuid.UUID, list[str]] = defaultdict(list)
        for dv_id, freshness in rows.all():
            grouped[dv_id].append(freshness)
        doc_freshness = {k: worst(v) for k, v in grouped.items()}

    views: dict[tuple[str, uuid.UUID], TraceOutput] = {}
    for dep in deps:
        key = downstream_key(dep)
        view = views.get(key)
        if view is None:
            view = _view(key, artifacts, versions, latest, doc_freshness)
            if view is None:
                continue
            views[key] = view
        up = TraceUpstream(
            section_key=dep.upstream_section_key,
            section_hash=dep.upstream_section_hash,
            composition_revision=dep.composition_revision,
        )
        if dep.upstream_version_id in versions:
            uv, ud = versions[dep.upstream_version_id]
            up.document_id, up.document_slug, up.document_kind = ud.id, ud.slug, ud.kind
            up.version_id, up.version_number = uv.id, uv.number
        if dep.upstream_entity_id in entities:
            up.entity = entity_ref(entities[dep.upstream_entity_id])
        why = reasons.get(dep.id, [])
        view.dependencies.append(
            TraceDependency(
                id=dep.id,
                freshness=dep.freshness,  # type: ignore[arg-type]
                upstream=up,
                caused_by_change_id=dep.caused_by_change_id,
                stale_since=dep.stale_since,
                reconciled_by=dep.reconciled_by,
                reconciled_at=dep.reconciled_at,
                note=dep.note,
                reasons=why,
            )
        )
        for r in why:
            if r not in view.reasons:
                view.reasons.append(r)
    return sorted(views.values(), key=lambda v: (-FRESHNESS_ORDER[v.freshness], v.title, v.number))


def _view(key, artifacts, versions, latest, doc_freshness) -> TraceOutput | None:
    kind, ident = key
    if kind == "artifact_version":
        if ident not in artifacts:
            return None
        av, req = artifacts[ident]
        return TraceOutput(
            kind="artifact_version",
            category=CATEGORY_OF_KIND.get(req.kind, "engineering_spec"),
            artifact_kind=req.kind,
            artifact_version_id=av.id,
            request_id=req.id,
            document_id=req.source_document_id,
            number=av.number,
            title=req.title,
            status=av.status,
            approved=av.status == "approved" or av.approved_at is not None,
            freshness=av.freshness,
        )
    if ident not in versions:
        return None
    dv, doc = versions[ident]
    return TraceOutput(
        kind="document_version",
        category="roadmap" if doc.kind == "roadmap" else "document",
        document_kind=doc.kind,
        document_version_id=dv.id,
        document_id=doc.id,
        document_slug=doc.slug,
        number=dv.number,
        title=doc.title,
        status=version_status(dv, doc, latest.get(doc.id, dv.number)),
        approved=dv.approved_at is not None,
        freshness=doc_freshness.get(dv.id, "fresh"),
    )
