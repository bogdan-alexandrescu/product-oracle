"""Request and response schemas of the trace, impact, staleness and evidence routes."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from oracle.priorities.schemas import RankedFeature
from oracle.v2.schemas import (
    ArtifactKind,
    ChangeEventOut,
    Freshness,
    LinkPrecision,
    SectionLinkKind,
)

# How the impact explorer groups downstream outputs (§7): engineering specs, wireframes
# (flows and design included), roadmaps, prototypes and acceptance tests.
Category = Literal[
    "engineering_spec", "wireframe", "prototype", "acceptance_tests", "roadmap", "document"
]
CATEGORY_OF_KIND: dict[str, Category] = {
    "tech_brief": "engineering_spec",
    "engineering_spec": "engineering_spec",
    "user_flow": "wireframe",
    "wireframe": "wireframe",
    "figma_design": "wireframe",
    "prototype": "prototype",
    "acceptance_tests": "acceptance_tests",
}
DownstreamKind = Literal["artifact_version", "document_version"]
StalenessActionKind = Literal["review", "accept_regeneration", "reconcile"]
ProposalAction = Literal["regenerate", "review"]


class TraceEntityRef(BaseModel):
    id: uuid.UUID
    type: str
    key: str
    title: str
    status: str
    locked: bool
    confidence: float | None = None


class TraceChainStep(BaseModel):
    entity: TraceEntityRef
    edge_id: uuid.UUID
    edge_type: str
    edge_status: str
    # The entity the step was reached from.
    via: uuid.UUID
    depth: int


class TraceEvidenceRef(BaseModel):
    id: uuid.UUID
    ref: str | None = None
    url: str | None = None
    excerpt: str | None = None
    confidence: float | None = None
    kind: str | None = None
    # 1 = strongest: ordered by confidence, unscored last (B3 source ranking).
    rank: int


class TraceUpstream(BaseModel):
    """What a dependency points at (its version anchor)."""

    document_id: uuid.UUID | None = None
    document_slug: str | None = None
    document_kind: str | None = None
    version_id: uuid.UUID | None = None
    version_number: int | None = None
    section_key: str | None = None
    section_hash: str | None = None
    composition_revision: int | None = None
    entity: TraceEntityRef | None = None
    # The upstream entity was deleted: ``entity`` is what it was when it went.
    deleted: bool = False
    deleted_at: datetime | None = None


class TraceDependency(BaseModel):
    id: uuid.UUID
    freshness: Freshness
    upstream: TraceUpstream
    caused_by_change_id: uuid.UUID | None = None
    stale_since: datetime | None = None
    reconciled_by: uuid.UUID | None = None
    reconciled_at: datetime | None = None
    note: str | None = None
    # Why it is (or would be) potentially stale.
    reasons: list[str] = []


class TraceOutput(BaseModel):
    """A derived output: an artifact version or a document version (a roadmap)."""

    kind: DownstreamKind
    category: Category
    artifact_kind: ArtifactKind | None = None
    document_kind: str | None = None
    artifact_version_id: uuid.UUID | None = None
    request_id: uuid.UUID | None = None
    document_version_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    document_slug: str | None = None
    number: int
    title: str
    # Artifact: draft, in_review, approved, rejected, superseded. Document version:
    # approved, superseded or the document's status.
    status: str
    approved: bool
    freshness: Freshness
    dependencies: list[TraceDependency] = []
    reasons: list[str] = []


class RegenerationProposal(BaseModel):
    """A targeted regeneration proposal (§11.5). Nothing runs until a person accepts it,
    and an approved output is never overwritten: regenerating makes a new version."""

    kind: DownstreamKind
    category: Category
    artifact_version_id: uuid.UUID | None = None
    document_version_id: uuid.UUID | None = None
    title: str
    action: ProposalAction
    # The upstream sections and baseline items to regenerate from: only these.
    section_keys: list[str] = []
    entity_ids: list[uuid.UUID] = []
    reasons: list[str] = []
    approved: bool
    keeps_approved_version: bool = True
    how: str


class ImpactSubject(BaseModel):
    kind: str
    id: uuid.UUID | None = None
    ref: str | None = None
    title: str | None = None
    document_id: uuid.UUID | None = None


class ImpactReport(BaseModel):
    subject: ImpactSubject
    # The recorded change; null for a preview.
    change: ChangeEventOut | None = None
    # Changes recorded against the subject (a document version's imports).
    changes: list[ChangeEventOut] = []
    # True: computed for a change not (or not yet) recorded; nothing was marked.
    preview: bool
    affected: list[TraceOutput]
    # Baseline items downstream of the change (acceptance criteria included).
    affected_entities: list[TraceEntityRef] = []
    plan: list[RegenerationProposal]
    counts: dict[str, int]
    # The graph walk stopped at its bound: more may be affected than listed.
    truncated: bool = False


class StaleOutputsPage(BaseModel):
    """A page of outputs that are not fresh, stalest first."""

    items: list[TraceOutput]
    total: int
    limit: int
    offset: int
    # The offset of the next page; null on the last one.
    next_offset: int | None = None


class StalenessAction(BaseModel):
    """A person's decision on a downstream output's staleness.

    ``review``: someone is checking it (under_review). ``accept_regeneration``: the
    regeneration proposal is accepted (under_review until the new version arrives).
    ``reconcile``: confirmed still valid against the current upstream, with a reason.
    """

    action: StalenessActionKind
    artifact_version_id: uuid.UUID | None = None
    document_version_id: uuid.UUID | None = None
    # Only these dependencies; default: all of the output's non-fresh ones.
    dependency_ids: list[uuid.UUID] = Field(default=[], max_length=200)
    reason: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _one_output(self):
        if (self.artifact_version_id is None) == (self.document_version_id is None):
            raise ValueError("give exactly one of artifact_version_id and document_version_id")
        if self.action == "reconcile" and not (self.reason or "").strip():
            raise ValueError("reconciling needs a reason")
        return self


class TraceUpstreamRef(BaseModel):
    """A dependency's upstream: a document version (a section of it, or all of it), or a
    baseline entity."""

    version_id: uuid.UUID | None = None
    section_key: str | None = Field(default=None, max_length=200)
    entity_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _one_target(self):
        if (self.version_id is None) == (self.entity_id is None):
            raise ValueError("give exactly one of version_id and entity_id")
        if self.section_key is not None and self.version_id is None:
            raise ValueError("section_key needs version_id")
        return self


class DependenciesCreate(BaseModel):
    artifact_version_id: uuid.UUID | None = None
    document_version_id: uuid.UUID | None = None
    upstream: list[TraceUpstreamRef] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _one_output(self):
        if (self.artifact_version_id is None) == (self.document_version_id is None):
            raise ValueError("give exactly one of artifact_version_id and document_version_id")
        return self


# --- evidence inspector -------------------------------------------------------------------


class SectionLinkTarget(BaseModel):
    type: Literal["entity", "evidence", "source_item"]
    id: uuid.UUID
    title: str | None = None
    entity_type: str | None = None
    status: str | None = None
    locked: bool | None = None
    confidence: float | None = None
    url: str | None = None
    ref: str | None = None
    excerpt: str | None = None
    source_kind: str | None = None
    # A source item the caller cannot read (per-user sources, AUD-9): only its kind shows.
    restricted: bool = False


class SectionLinkView(BaseModel):
    id: uuid.UUID
    kind: SectionLinkKind
    precision: LinkPrecision
    claim: str | None = None
    module_key: str | None = None
    composition_revision: int | None = None
    # The link was made on this exact section revision.
    current: bool
    target: SectionLinkTarget
    created_by: uuid.UUID | None = None
    created_at: datetime


class EvidenceCitation(BaseModel):
    """A ``[c:id]`` marker the stored draft carries in this section (its per-claim link)."""

    cite_key: str
    source: str
    ref: str
    title: str | None = None
    excerpt: str | None = None
    retrieved_at: datetime | None = None


class SectionEvidence(BaseModel):
    section_key: str
    heading: str
    level: int
    layer: str
    section_hash: str
    links: list[SectionLinkView]
    citations: list[EvidenceCitation]


class EvidenceInspector(BaseModel):
    document_id: uuid.UUID
    document_slug: str
    version_id: uuid.UUID
    number: int
    approved: bool
    snapshot: str | None = None
    sections: list[SectionEvidence]


class SectionLinkCreate(BaseModel):
    section_key: str = Field(min_length=1, max_length=200)
    kind: SectionLinkKind
    precision: LinkPrecision = "section"
    claim: str | None = Field(default=None, max_length=2000)
    module_key: str | None = Field(default=None, max_length=200)
    entity_id: uuid.UUID | None = None
    evidence_id: uuid.UUID | None = None
    source_item_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _target(self):
        if self.entity_id is None and self.evidence_id is None and self.source_item_id is None:
            raise ValueError("a link needs an entity_id, evidence_id or source_item_id")
        if self.precision == "claim" and not (self.claim or "").strip():
            raise ValueError("a claim link needs the claim")
        return self


class SectionLinksCreate(BaseModel):
    links: list[SectionLinkCreate] = Field(min_length=1, max_length=100)


# --- traces -------------------------------------------------------------------------------


class TraceAlternativeRef(BaseModel):
    id: uuid.UUID
    blocker_id: uuid.UUID
    title: str
    approach: str
    status: str
    compliance: str


class TraceExperimentRef(BaseModel):
    id: uuid.UUID
    blocker_id: uuid.UUID
    option_id: uuid.UUID | None = None
    hypothesis: str
    status: str


class TraceAssumptionDecisionRef(BaseModel):
    id: uuid.UUID
    entity_id: uuid.UUID | None = None
    statement: str
    decision: str
    rationale: str
    decided_at: datetime


class TraceRelated(BaseModel):
    """What §7 links to a requirement besides the chain itself."""

    assumptions: list[TraceEntityRef] = []
    blockers: list[TraceEntityRef] = []
    alternatives: list[TraceAlternativeRef] = []
    experiments: list[TraceExperimentRef] = []
    decisions: list[TraceEntityRef] = []
    owners: list[TraceEntityRef] = []
    risks: list[TraceEntityRef] = []
    depends_on: list[TraceEntityRef] = []
    assumption_decisions: list[TraceAssumptionDecisionRef] = []


class TraceSectionRef(BaseModel):
    document_id: uuid.UUID
    document_slug: str
    document_kind: str
    version_id: uuid.UUID | None = None
    version_number: int | None = None
    section_key: str
    link_id: uuid.UUID
    link_kind: str
    # The entity the link points at (this one, or one below it in the chain).
    entity_id: uuid.UUID | None = None


class EntityTrace(BaseModel):
    entity: TraceEntityRef
    # serves_no_goal, no_evidence, low_confidence (the F3b report's flags).
    flags: list[str]
    goals: list[TraceEntityRef]
    upstream: list[TraceChainStep]
    downstream: list[TraceChainStep]
    related: TraceRelated
    evidence: list[TraceEvidenceRef]
    sections: list[TraceSectionRef]
    outputs: list[TraceOutput]
    # A feature's place in the goal-weighted ranking, with its explanation.
    priority: RankedFeature | None = None
    # A graph walk stopped at its bound: the chain or the outputs may be longer.
    truncated: bool = False


class VersionAnchors(BaseModel):
    """The version anchors of §7 for one document version."""

    document_id: uuid.UUID
    document_slug: str
    document_kind: str
    version_id: uuid.UUID
    number: int
    content_hash: str
    template: str | None = None
    template_version: str | None = None
    composition_revision: int | None = None
    composition_status: str | None = None
    baseline_snapshot_id: uuid.UUID | None = None
    source_snapshot_ids: list[uuid.UUID] = []
    # The draft's front-matter "snapshot" (the as-of of its sources).
    snapshot: str | None = None
    approved_at: datetime | None = None
    # A roadmap's PRD version (O4b).
    source_version_id: uuid.UUID | None = None


class SectionTrace(BaseModel):
    section_key: str
    heading: str
    level: int
    layer: str
    section_hash: str
    links: list[SectionLinkView]
    entities: list[TraceEntityRef]
    goals: list[TraceEntityRef]
    downstream: list[TraceOutput]


class VersionTrace(BaseModel):
    anchors: VersionAnchors
    sections: list[SectionTrace]
    # Outputs that depend on the whole version rather than one section.
    whole_version_downstream: list[TraceOutput]
    # For a roadmap or other derived version: what it depends on.
    upstream: list[TraceDependency] = []
    # The walk to the sections' goals stopped at its bound.
    truncated: bool = False
