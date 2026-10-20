"""The two trace views: a baseline node's and a document version's (§7).

Both only read. Locked and confirmed items stay as they are, evidence keeps its ranking
(confidence, B3), and a feature keeps the F3b flags and its prioritization rationale
from :mod:`oracle.baseline.trace` and :mod:`oracle.priorities`.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.baseline import trace as baseline_trace
from oracle.baseline.models import Entity, Evidence
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.priorities import service as priorities
from oracle.trace import evidence as evidence_mod
from oracle.trace import graph as graph_mod
from oracle.trace import staleness
from oracle.trace.impact import subject_kind_of
from oracle.trace.outputs import describe, entity_ref
from oracle.trace.schemas import (
    EntityTrace,
    SectionTrace,
    TraceAlternativeRef,
    TraceAssumptionDecisionRef,
    TraceChainStep,
    TraceDependency,
    TraceEvidenceRef,
    TraceExperimentRef,
    TraceOutput,
    TraceRelated,
    TraceSectionRef,
    VersionAnchors,
    VersionTrace,
)
from oracle.v2.models import (
    ArtifactDependency,
    AssumptionDecision,
    BlockerOption,
    CompositionRevision,
    DocumentComposition,
    DocumentSectionLink,
    FeasibilityExperiment,
)

# Types that should trace up to a confirmed goal (F3b).
GOAL_TRACED = ("feature", "requirement", "outcome", "acceptance_criterion")
RELATED_BY_TYPE = {
    "assumption": "assumptions",
    "constraint": "blockers",
    "decision": "decisions",
    "risk": "risks",
}


def _steps(g: graph_mod.Graph, steps: list[graph_mod.Step]) -> list[TraceChainStep]:
    return [
        TraceChainStep(
            entity=entity_ref(g.entities[s.entity_id]),
            edge_id=s.edge_id,
            edge_type=s.edge_type,
            edge_status=s.edge_status,
            via=s.via,
            depth=s.depth,
        )  # fmt: skip
        for s in steps
    ]


async def _related(db: AsyncSession, g: graph_mod.Graph, entity: Entity) -> TraceRelated:
    rel = TraceRelated()
    for edge, other, direction in g.related(entity.id):
        ref = entity_ref(other)
        if edge.type == "owned_by" and direction == "out":
            rel.owners.append(ref)
        elif edge.type == "depends_on" and direction == "out":
            rel.depends_on.append(ref)
        elif direction == "in" and edge.type in ("affects", "blocks", "mitigates"):
            bucket = RELATED_BY_TYPE.get(other.type)
            if bucket and ref not in getattr(rel, bucket):
                getattr(rel, bucket).append(ref)
    for bucket in ("assumptions", "blockers", "decisions", "risks", "owners", "depends_on"):
        getattr(rel, bucket).sort(key=lambda r: r.key)
    blocker_ids = [b.id for b in rel.blockers] + (
        [entity.id] if entity.type == "constraint" else []
    )
    if blocker_ids:
        options = (
            await db.scalars(
                select(BlockerOption)
                .where(BlockerOption.blocker_id.in_(blocker_ids))
                .order_by(BlockerOption.created_at)
            )
        ).all()
        rel.alternatives = [
            TraceAlternativeRef(
                id=o.id,
                blocker_id=o.blocker_id,
                title=o.title,
                approach=o.approach,
                status=o.status,
                compliance=o.compliance,
            )  # fmt: skip
            for o in options
        ]
        experiments = (
            await db.scalars(
                select(FeasibilityExperiment)
                .where(FeasibilityExperiment.blocker_id.in_(blocker_ids))
                .order_by(FeasibilityExperiment.created_at)
            )
        ).all()
        rel.experiments = [
            TraceExperimentRef(
                id=x.id,
                blocker_id=x.blocker_id,
                option_id=x.option_id,
                hypothesis=x.hypothesis,
                status=x.status,
            )  # fmt: skip
            for x in experiments
        ]
    decided = [entity.id] + [a.id for a in rel.assumptions]
    rows = (
        await db.scalars(
            select(AssumptionDecision)
            .where(AssumptionDecision.entity_id.in_(decided))
            .order_by(AssumptionDecision.decided_at)
        )
    ).all()
    rel.assumption_decisions = [
        TraceAssumptionDecisionRef(
            id=d.id,
            entity_id=d.entity_id,
            statement=d.statement,
            decision=d.decision,
            rationale=d.rationale,
            decided_at=d.decided_at,
        )  # fmt: skip
        for d in rows
    ]
    return rel


async def _evidence(db: AsyncSession, entity_id: uuid.UUID) -> list[TraceEvidenceRef]:
    rows = (await db.scalars(select(Evidence).where(Evidence.entity_id == entity_id))).all()
    ranked = sorted(
        rows, key=lambda e: (e.confidence is None, -(float(e.confidence or 0)), e.created_at)
    )
    return [
        TraceEvidenceRef(
            id=e.id,
            ref=e.ref,
            url=e.url,
            excerpt=e.excerpt,
            kind=e.kind,
            rank=i + 1,
            confidence=None if e.confidence is None else float(e.confidence),
        )  # fmt: skip
        for i, e in enumerate(ranked)
    ]


async def _sections_linking(db: AsyncSession, entity_ids: list[uuid.UUID]) -> list[TraceSectionRef]:
    rows = await db.execute(
        select(DocumentSectionLink, Document, DocumentVersion)
        .join(Document, Document.id == DocumentSectionLink.document_id)
        .outerjoin(DocumentVersion, DocumentVersion.id == DocumentSectionLink.version_id)
        .where(DocumentSectionLink.entity_id.in_(entity_ids))
        .order_by(Document.slug, DocumentVersion.number, DocumentSectionLink.section_key)
    )
    return [
        TraceSectionRef(
            document_id=doc.id,
            document_slug=doc.slug,
            document_kind=doc.kind,
            version_id=v.id if v else None,
            version_number=v.number if v else None,
            section_key=link.section_key,
            link_id=link.id,
            link_kind=link.kind,
            entity_id=link.entity_id,
        )  # fmt: skip
        for link, doc, v in rows.all()
    ]


async def entity_trace(
    db: AsyncSession, entity: Entity, principal: Principal | None = None
) -> EntityTrace:
    # Rejected items are not part of the trace: a rejected node shows no chain.
    active = entity.status != "rejected"
    g = (
        await graph_mod.load_around(db, [entity.id], up=True, down=True, related=True)
        if active
        else graph_mod.Graph(entities={entity.id: entity})
    )
    goals = g.confirmed_goals(entity.id)
    flags: list[str] = []
    priority = None
    if entity.type == "feature":
        report = await baseline_trace.report(db, principal)
        flags = next((f.flags for f in report.features if f.id == entity.id), [])
        ranking = await priorities.compute(db, "goal_weighted", principal)
        priority = next((f for f in ranking.features if f.entity_id == str(entity.id)), None)
    elif entity.type in GOAL_TRACED and not goals and active:
        flags = ["serves_no_goal"]
    down = g.chain_down(entity.id)
    up = g.upstream(entity.id)
    found = await staleness.affected(db, staleness.Subject(subject_kind_of(entity), entity.id))
    return EntityTrace(
        entity=entity_ref(entity),
        flags=flags,
        goals=[entity_ref(x) for x in goals],
        upstream=_steps(g, up),
        downstream=_steps(g, down),
        related=await _related(db, g, entity),
        evidence=await _evidence(db, entity.id),
        sections=await _sections_linking(db, [entity.id] + [s.entity_id for s in down]),
        outputs=await describe(db, list(found.deps.values())),
        priority=priority,
        truncated=g.truncated or found.truncated,
    )


def _for_section(views: list[TraceOutput], key: str | None) -> list[TraceOutput]:
    """The outputs among ``views`` that depend on section ``key`` (None: on the whole
    version), each with only those dependencies."""
    out = []
    for view in views:
        deps = [d for d in view.dependencies if d.upstream.section_key == key]
        if deps:
            out.append(view.model_copy(update={"dependencies": deps}))
    return out


async def _anchors(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> VersionAnchors:
    comp = await db.scalar(
        select(DocumentComposition).where(DocumentComposition.document_id == document.id)
    )
    revision = None
    if comp is not None:
        revision = await db.scalar(
            select(CompositionRevision).where(
                CompositionRevision.composition_id == comp.id,
                CompositionRevision.document_version_id == version.id,
            )
        )
        if revision is None and comp.current_revision is not None:
            revision = await db.scalar(
                select(CompositionRevision).where(
                    CompositionRevision.composition_id == comp.id,
                    CompositionRevision.number == comp.current_revision,
                )
            )
    inputs = (revision.inputs or {}) if revision is not None else {}
    return VersionAnchors(
        document_id=document.id,
        document_slug=document.slug,
        document_kind=document.kind,
        version_id=version.id,
        number=version.number,
        content_hash=version.content_hash,
        template=(comp.template if comp else None) or document.template,
        template_version=(comp.template_version if comp else None) or document.template_version,
        composition_revision=revision.number if revision else None,
        composition_status=revision.status if revision else None,
        baseline_snapshot_id=inputs.get("baseline_snapshot_id"),
        source_snapshot_ids=inputs.get("source_snapshot_ids") or [],
        snapshot=version.snapshot,
        approved_at=version.approved_at,
        source_version_id=version.source_version_id,
    )


async def version_trace(
    db: AsyncSession, principal: Principal, document: Document, version: DocumentVersion
) -> VersionTrace:
    sections = list(
        (
            await db.scalars(
                select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
            )
        ).all()
    )
    hashes = {s.section_key: s.content_hash for s in sections}
    views = await evidence_mod.link_views(
        db, await evidence_mod.version_links(db, version), hashes, principal
    )
    linked = [
        link.target.id
        for section_links in views.values()
        for link in section_links
        if link.target.type == "entity"
    ]
    g = await graph_mod.load_around(db, linked, up=True, down=False)
    on_version = list(
        (
            await db.scalars(
                select(ArtifactDependency)
                .where(ArtifactDependency.upstream_version_id == version.id)
                .order_by(ArtifactDependency.created_at)
            )
        ).all()
    )
    # One description for every output built on this version, split by section below.
    downstream = await describe(db, on_version)
    out = []
    for s in sections:
        entities = []
        goals: dict[uuid.UUID, Entity] = {}
        for link in views.get(s.section_key, []):
            e = g.entities.get(link.target.id) if link.target.type == "entity" else None
            if e is None or e.status == "rejected":
                continue
            if all(x.id != e.id for x in entities):
                entities.append(entity_ref(e))
            for goal in g.confirmed_goals(e.id) + ([e] if e.type == "goal" else []):
                goals[goal.id] = goal
        out.append(
            SectionTrace(
                section_key=s.section_key,
                heading=s.heading,
                level=s.level,
                layer=s.layer,
                section_hash=s.content_hash,
                links=views.get(s.section_key, []),
                entities=entities,
                goals=[entity_ref(x) for x in sorted(goals.values(), key=lambda x: x.key)],
                downstream=_for_section(downstream, s.section_key),
            )
        )
    upstream_deps = list(
        (
            await db.scalars(
                select(ArtifactDependency)
                .where(ArtifactDependency.document_version_id == version.id)
                .order_by(ArtifactDependency.created_at)
            )
        ).all()
    )
    upstream: list[TraceDependency] = [
        d for view in await describe(db, upstream_deps) for d in view.dependencies
    ]
    return VersionTrace(
        anchors=await _anchors(db, document, version),
        sections=out,
        whole_version_downstream=_for_section(downstream, None),
        upstream=upstream,
        truncated=g.truncated,
    )
