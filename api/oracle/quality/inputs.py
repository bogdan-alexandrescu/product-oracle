"""Everything the quality criteria read about one document version, loaded once.

``readiness.evaluate`` calls each check with the same :class:`ReadinessContext`; the
first check loads :class:`QualityInputs` and the others reuse it (keyed on that context
object, so a new evaluation always reads fresh data). Read only: nothing here writes.

The document's scope in the baseline is what its sections link to (``document_section_links``),
the entities its gaps name, and the blockers whose impacted entities it links. A legacy
document with no links is judged from its text, citations and gaps alone.
"""

import uuid
import weakref
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import confidence
from oracle.baseline import scoring as baseline_scoring
from oracle.baseline import trace
from oracle.baseline.models import Conflict, Edge, Entity, Evidence
from oracle.baseline.schemas import TraceReport
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.priorities import service as priorities_service
from oracle.priorities.scoring import rank
from oracle.quality.text import SectionText, classify
from oracle.readiness import ReadinessContext
from oracle.review.models import Comment, SectionReview
from oracle.v2 import models as m
from oracle.v2.schemas import BlockerAttrs

OPEN_GAP = ("unknown", "under_investigation", "asked", "deferred")


@dataclass
class Blocker:
    entity: Entity
    attrs: BlockerAttrs
    options: list[m.BlockerOption] = field(default_factory=list)
    experiments: list[m.FeasibilityExperiment] = field(default_factory=list)
    section_keys: list[str] = field(default_factory=list)


@dataclass
class QualityInputs:
    document: Document | None
    version: DocumentVersion | None
    sections: list[SectionText] = field(default_factory=list)
    front_matter: dict[str, Any] = field(default_factory=dict)
    composition_revision: int | None = None
    module_keys: list[str] = field(default_factory=list)
    links: list[m.DocumentSectionLink] = field(default_factory=list)
    # The document's baseline scope: id -> entity, and entity id -> sections linking it.
    entities: dict[uuid.UUID, Entity] = field(default_factory=dict)
    sections_of: dict[uuid.UUID, list[str]] = field(default_factory=dict)
    edges: list[Edge] = field(default_factory=list)
    evidence: list[Evidence] = field(default_factory=list)
    conflicts: list[Conflict] = field(default_factory=list)
    gaps: list[m.KnowledgeGap] = field(default_factory=list)
    decisions: list[m.AssumptionDecision] = field(default_factory=list)
    blockers: list[Blocker] = field(default_factory=list)
    experiments: list[m.FeasibilityExperiment] = field(default_factory=list)
    dependencies: list[tuple[m.ArtifactDependency, str | None]] = field(default_factory=list)
    # Roadmap versions built from an older version of this PRD: (number, from number).
    derived_versions: list[tuple[str, int, int]] = field(default_factory=list)
    reviews: int = 0
    comments: int = 0
    confirmed_goals: int = 0
    trace: TraceReport | None = None
    # Feature key -> its row in the goal-weighted ranking (rank, score, serves_goal, flags).
    ranking: dict[str, dict[str, Any]] = field(default_factory=dict)
    ranked: int = 0
    low: float = 0.4
    now: datetime = field(default_factory=lambda: datetime.now(UTC))

    @property
    def author_id(self) -> uuid.UUID | None:
        if self.version is None:
            return None
        return self.version.approved_by or self.version.imported_by

    def of_type(self, *types: str) -> list[Entity]:
        return [e for e in self.entities.values() if e.type in types]

    def open_gaps(self, *categories: str, importance: tuple[str, ...] = ()) -> list:
        return [
            g
            for g in self.gaps
            if g.status in OPEN_GAP
            and (not categories or g.category in categories)
            and (not importance or g.importance in importance)
        ]

    def closed_gaps(self, *categories: str) -> list:
        return [
            g
            for g in self.gaps
            if g.status not in OPEN_GAP and (not categories or g.category in categories)
        ]


_cache: dict[int, tuple[weakref.ref, QualityInputs]] = {}


async def for_context(ctx: ReadinessContext) -> QualityInputs:
    """The inputs of this evaluation, loaded on first use."""
    hit = _cache.get(id(ctx))
    if hit is not None and hit[0]() is ctx:
        return hit[1]
    for key in [k for k, (ref, _) in _cache.items() if ref() is None]:
        _cache.pop(key, None)
    inputs = await load(ctx.db, ctx.document_id, ctx.version_id, ctx.composition_revision)
    _cache[id(ctx)] = (weakref.ref(ctx), inputs)
    return inputs


async def _version(
    db: AsyncSession, document_id: uuid.UUID, version_id: uuid.UUID | None
) -> DocumentVersion | None:
    if version_id is not None:
        version = await db.get(DocumentVersion, version_id)
        return version if version is not None and version.document_id == document_id else None
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def load(
    db: AsyncSession,
    document_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    composition_revision: int | None = None,
) -> QualityInputs:
    document = await db.get(Document, document_id)
    version = await _version(db, document_id, version_id) if document else None
    q = QualityInputs(document=document, version=version)
    if document is None or version is None:
        return q
    q.front_matter = dict(version.front_matter or {})
    q.low = float(confidence.merged(await baseline_scoring.company_weights(db))["low"])
    rows = await db.scalars(
        select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
    )
    q.sections = classify(
        [
            SectionText(
                key=s.section_key,
                heading=s.heading,
                body=s.body_text or s.body_md or "",
                md=s.body_md or "",
                layer=s.layer,
                citation_keys=list(s.citation_keys or []),
            )  # fmt: skip
            for s in rows
        ]
    )
    await _composition(db, q, composition_revision)

    q.links = list(
        await db.scalars(
            select(m.DocumentSectionLink).where(
                m.DocumentSectionLink.document_id == document.id,
                or_(
                    m.DocumentSectionLink.version_id == version.id,
                    m.DocumentSectionLink.version_id.is_(None),
                ),
            )
        )
    )
    q.gaps = list(
        await db.scalars(
            select(m.KnowledgeGap).where(
                or_(
                    m.KnowledgeGap.document_id == document.id,
                    m.KnowledgeGap.intake_id.in_(
                        select(m.ProductIntake.id).where(m.ProductIntake.document_id == document.id)
                    ),
                )
            )
        )
    )
    q.decisions = list(
        await db.scalars(
            select(m.AssumptionDecision).where(m.AssumptionDecision.document_id == document.id)
        )
    )
    await _scope(db, q)
    await _blockers(db, q)
    await _downstream(db, q)
    q.reviews = len(
        list(
            await db.scalars(select(SectionReview.id).where(SectionReview.version_id == version.id))
        )
    )
    q.comments = len(
        list(await db.scalars(select(Comment.id).where(Comment.version_id == version.id)))
    )
    q.confirmed_goals = len(
        list(
            await db.scalars(
                select(Entity.id).where(Entity.type == "goal", Entity.status == "confirmed")
            )
        )
    )
    await _goal_trace(db, q)
    return q


async def _composition(db: AsyncSession, q: QualityInputs, number: int | None) -> None:
    composition = await db.scalar(
        select(m.DocumentComposition).where(m.DocumentComposition.document_id == q.document.id)
    )
    if composition is None:
        return
    number = number or composition.current_revision
    if number is None:
        return
    revision = await db.scalar(
        select(m.CompositionRevision).where(
            m.CompositionRevision.composition_id == composition.id,
            m.CompositionRevision.number == number,
        )
    )
    if revision is None:
        return
    q.composition_revision = revision.number
    q.module_keys = [
        str(mod.get("key")) for mod in revision.modules or [] if mod.get("included", True)
    ]


async def _scope(db: AsyncSession, q: QualityInputs) -> None:
    ids: set[uuid.UUID] = set()
    for link in q.links:
        if link.entity_id is not None:
            ids.add(link.entity_id)
            q.sections_of.setdefault(link.entity_id, [])
            if link.section_key not in q.sections_of[link.entity_id]:
                q.sections_of[link.entity_id].append(link.section_key)
    for gap in q.gaps:
        ids |= set(gap.entity_ids or [])
    if ids:
        for e in await db.scalars(
            select(Entity).where(Entity.id.in_(ids), Entity.status != "rejected")
        ):
            q.entities[e.id] = e
    # Blockers impacting what the document links, though not linked themselves.
    linked = set(q.entities)
    if linked:
        for e in await db.scalars(
            select(Entity).where(
                Entity.type == "constraint", Entity.status != "rejected", Entity.id.not_in(linked)
            )
        ):
            raw = (e.attrs or {}).get("blocker") or {}
            impacted = {str(x) for x in raw.get("impacted_entity_ids") or []}
            if impacted & {str(x) for x in linked}:
                q.entities[e.id] = e
    ids = set(q.entities)
    if not ids:
        return
    q.edges = list(
        await db.scalars(
            select(Edge).where(
                Edge.status != "rejected", or_(Edge.src_id.in_(ids), Edge.dst_id.in_(ids))
            )
        )
    )
    wanted = [Evidence.entity_id.in_(ids)]
    if evidence_ids := {link.evidence_id for link in q.links if link.evidence_id}:
        wanted.append(Evidence.id.in_(evidence_ids))
    q.evidence = list(await db.scalars(select(Evidence).where(or_(*wanted))))
    q.conflicts = list(await db.scalars(select(Conflict).where(Conflict.entity_id.in_(ids))))


async def _blockers(db: AsyncSession, q: QualityInputs) -> None:
    constraints = [e for e in q.entities.values() if e.type == "constraint"]
    for e in constraints:
        raw = (e.attrs or {}).get("blocker")
        if not isinstance(raw, dict):
            continue
        try:
            attrs = BlockerAttrs.model_validate(raw)
        except ValueError:
            continue
        q.blockers.append(Blocker(entity=e, attrs=attrs, section_keys=q.sections_of.get(e.id, [])))
    ids = [b.entity.id for b in q.blockers]
    if not ids:
        return
    by_id = {b.entity.id: b for b in q.blockers}
    for o in await db.scalars(
        select(m.BlockerOption)
        .where(m.BlockerOption.blocker_id.in_(ids))
        .order_by(m.BlockerOption.created_at)
    ):
        by_id[o.blocker_id].options.append(o)
    for x in await db.scalars(
        select(m.FeasibilityExperiment).where(m.FeasibilityExperiment.blocker_id.in_(ids))
    ):
        by_id[x.blocker_id].experiments.append(x)
        q.experiments.append(x)


async def _downstream(db: AsyncSession, q: QualityInputs) -> None:
    versions = dict(
        (
            await db.execute(
                select(DocumentVersion.id, DocumentVersion.number).where(
                    DocumentVersion.document_id == q.document.id
                )
            )
        ).all()
    )
    rows = (
        await db.execute(
            select(m.ArtifactDependency, m.ArtifactRequest.title)
            .outerjoin(
                m.ArtifactVersion, m.ArtifactVersion.id == m.ArtifactDependency.artifact_version_id
            )
            .outerjoin(m.ArtifactRequest, m.ArtifactRequest.id == m.ArtifactVersion.request_id)
            .where(m.ArtifactDependency.upstream_version_id.in_(list(versions)))
        )
    ).all()
    q.dependencies = [(dep, title) for dep, title in rows]
    # Roadmaps (documents) whose latest version was built from an older version of this
    # PRD (O4b provenance).
    rows = (
        await db.execute(
            select(Document.slug, DocumentVersion.number, DocumentVersion.source_version_id)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(DocumentVersion.source_version_id.in_(list(versions)))
            .order_by(Document.slug, DocumentVersion.number)
        )
    ).all()
    latest = {slug: (number, versions[src]) for slug, number, src in rows}
    q.derived_versions = [
        (slug, number, src) for slug, (number, src) in latest.items() if src < q.version.number
    ]


async def _goal_trace(db: AsyncSession, q: QualityInputs) -> None:
    """The baseline's goal traceability and the goal-weighted priority of its features."""
    if not q.of_type("feature"):
        return
    q.trace = await trace.report(db)
    features = await priorities_service.load_features(db, rescore=False)
    result = rank(features, "goal_weighted")
    q.ranked = len(result["features"])
    q.ranking = {row["key"]: row for row in result["features"]}
