"""Blocker strategy schemas (CR-04, build prompt §6).

A blocker is a baseline ``constraint`` entity. Its statement is the entity's title, its
detail the body, its evidence and confidence the entity's evidence; the strategy lives
in ``attrs["blocker"]`` (:class:`BlockerSpec`, the foundation's
:class:`~oracle.v2.schemas.BlockerAttrs` plus the fields below). Options, experiments and
resolution events are the foundation's tables.
"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from oracle.baseline.schemas import EvidenceOut
from oracle.blockers.policy import BlockerCompliantPath, BlockerPolicyFlag, LimitKind
from oracle.v2.schemas import (
    AssumptionDecisionOut,
    BlockerApproach,
    BlockerAttrs,
    BlockerOptionDetails,
    BlockerOptionOut,
    BlockerResolutionEventOut,
    BlockerStatus,
    Compliance,
    ExperimentStatus,
    Feasibility,
    FeasibilityExperimentOut,
    Importance,
)

BlockerType = Literal["hard", "soft", "unknown", "temporary"]
GateStatus = Literal["pass", "warning", "critical", "not_applicable"]
# Statuses the status route sets; accepted_risk and feasibility_only have their own routes.
PlainStatus = Literal["open", "mitigating", "resolved"]

KEY_PATTERN = r"^[a-z0-9][a-z0-9-]*$"
Text200 = str


class BlockerScaling(BaseModel):
    """Scaling characteristics, when they apply (§6)."""

    model_config = ConfigDict(extra="forbid")

    tenants: str | None = Field(None, max_length=2000)
    agents: str | None = Field(None, max_length=2000)
    channels: str | None = Field(None, max_length=2000)
    quotas: str | None = Field(None, max_length=2000)
    cost: str | None = Field(None, max_length=2000)
    blast_radius: str | None = Field(None, max_length=2000)


class BlockerSpec(BlockerAttrs):
    """``attrs["blocker"]``: the foundation's fields plus the strategy's."""

    # Optimistic concurrency for PATCH: bumped on every strategy write.
    revision: int = 1
    # The third party that sets the limit, if any (then limit_kind must classify it).
    third_party: str | None = None
    # Impacted users or segments, in words (impacted outcomes and requirements are
    # impacted_entity_ids).
    impacted_users: list[str] = []
    # Documents (PRDs) this blocker gates; section links count too.
    document_ids: list[uuid.UUID] = []
    scaling: BlockerScaling = BlockerScaling()
    selected_option_id: uuid.UUID | None = None


# --- requests ---------------------------------------------------------------------------


class _BlockerFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: str | None = Field(None, max_length=20000)
    limit_kind: LimitKind | None = None
    third_party: str | None = Field(None, max_length=200)
    severity: Importance | None = None
    timing: str | None = Field(None, max_length=2000)
    threshold: str | None = Field(None, max_length=2000)
    impacted_entity_ids: list[uuid.UUID] | None = Field(None, max_length=200)
    impacted_users: list[str] | None = Field(None, max_length=50)
    owner_id: uuid.UUID | None = None
    review_at: datetime | None = None
    document_ids: list[uuid.UUID] | None = Field(None, max_length=100)
    scaling: BlockerScaling | None = None


class BlockerCreate(_BlockerFields):
    """A new blocker: either an existing constraint entity (``entity_id``) or a new one
    (``key`` and ``statement``)."""

    entity_id: uuid.UUID | None = None
    key: str | None = Field(None, pattern=KEY_PATTERN, max_length=100)
    statement: str | None = Field(None, min_length=1, max_length=500)
    type: BlockerType
    status: Literal["open", "mitigating"] = "open"
    reason: str | None = Field(None, max_length=2000)


class BlockerPatch(_BlockerFields):
    # The revision the client last saw: a stale one is a 409.
    revision: int
    statement: str | None = Field(None, min_length=1, max_length=500)
    type: BlockerType | None = None
    reason: str | None = Field(None, max_length=2000)


class BlockerStatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: PlainStatus
    reason: str | None = Field(None, max_length=2000)


class BlockerRiskAcceptanceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=4000)
    # An accepted risk is not forever: when to look again (required, in the future).
    review_at: datetime


class FeasibilityScopeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    experiment_id: uuid.UUID
    reason: str = Field(min_length=1, max_length=4000)


class BlockerOptionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    approach: BlockerApproach
    description: str | None = Field(None, max_length=10000)
    technical_feasibility: Feasibility = "unknown"
    policy_feasibility: Feasibility = "unknown"
    details: BlockerOptionDetails = BlockerOptionDetails()
    evidence_ids: list[uuid.UUID] = Field([], max_length=100)
    owner_id: uuid.UUID | None = None


class BlockerOptionPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_version: int
    title: str | None = Field(None, min_length=1, max_length=300)
    approach: BlockerApproach | None = None
    description: str | None = Field(None, max_length=10000)
    technical_feasibility: Feasibility | None = None
    policy_feasibility: Feasibility | None = None
    # The policy review: approvers set it; flagged text can never be compliant.
    compliance: Compliance | None = None
    details: BlockerOptionDetails | None = None
    evidence_ids: list[uuid.UUID] | None = Field(None, max_length=100)
    owner_id: uuid.UUID | None = None
    reason: str | None = Field(None, max_length=2000)


class BlockerOptionDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_version: int
    reason: str = Field(min_length=1, max_length=4000)


class BlockerOptionFallback(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_version: int
    reason: str | None = Field(None, max_length=4000)


class FeasibilityExperimentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hypothesis: str = Field(min_length=1, max_length=4000)
    option_id: uuid.UUID | None = None
    method: str | None = Field(None, max_length=4000)
    success_threshold: str | None = Field(None, max_length=2000)
    owner_id: uuid.UUID | None = None
    decision_gate_at: datetime | None = None
    evidence_ids: list[uuid.UUID] = Field([], max_length=100)


class FeasibilityExperimentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_version: int
    hypothesis: str | None = Field(None, min_length=1, max_length=4000)
    method: str | None = Field(None, max_length=4000)
    success_threshold: str | None = Field(None, max_length=2000)
    owner_id: uuid.UUID | None = None
    decision_gate_at: datetime | None = None
    status: ExperimentStatus | None = None
    result: str | None = Field(None, max_length=4000)
    evidence_ids: list[uuid.UUID] | None = Field(None, max_length=100)


# --- responses --------------------------------------------------------------------------


class BlockerGate(BaseModel):
    """This blocker's effect on readiness (the ``critical_blockers`` hard check)."""

    status: GateStatus
    rationale: str


class BlockerImpactRef(BaseModel):
    id: uuid.UUID
    type: str
    key: str
    title: str


class BlockerDocumentRef(BaseModel):
    id: uuid.UUID
    slug: str
    title: str


class BlockerOut(BaseModel):
    id: uuid.UUID
    key: str
    statement: str
    detail: str | None = None
    # The baseline entity's own status (proposed / confirmed / rejected) and lock.
    entity_status: str
    locked: bool
    confidence: float | None = None
    evidence_count: int = 0
    type: BlockerType
    limit_kind: LimitKind
    limit_kind_label: str
    third_party: str | None = None
    severity: Importance
    status: BlockerStatus
    timing: str | None = None
    threshold: str | None = None
    impacted_entity_ids: list[uuid.UUID]
    impacted: list[BlockerImpactRef] = []
    impacted_users: list[str]
    owner_id: uuid.UUID | None = None
    review_at: datetime | None = None
    document_ids: list[uuid.UUID]
    scaling: BlockerScaling
    selected_option_id: uuid.UUID | None = None
    revision: int
    gate: BlockerGate
    created_at: datetime
    updated_at: datetime


class BlockerOptionView(BlockerOptionOut):
    """An option as the strategy view compares it."""

    policy_flags: list[BlockerPolicyFlag] = []
    recommended: bool = False


class BlockerStrategy(BaseModel):
    """Everything the blocker strategy view shows for one blocker."""

    blocker: BlockerOut
    gate: BlockerGate
    evidence: list[EvidenceOut]
    options: list[BlockerOptionView]
    # The best compliant, reviewed, non-rejected option (advisory); never a flagged one.
    recommended_option_id: uuid.UUID | None = None
    compliant_paths: list[BlockerCompliantPath]
    prohibited: str
    experiments: list[FeasibilityExperimentOut]
    events: list[BlockerResolutionEventOut]
    risk_acceptance: AssumptionDecisionOut | None = None
    documents: list[BlockerDocumentRef]


class DocumentBlockerStrategy(BaseModel):
    document: BlockerDocumentRef
    # The critical_blockers readiness outcome for this document.
    readiness: BlockerGate
    blockers: list[BlockerStrategy]


class BlockerCitation(BaseModel):
    """A front matter ``citations`` entry (docs/mvp-app.md, Draft import format)."""

    id: str
    source: str
    ref: str
    title: str | None = None
    excerpt: str | None = None
    retrieved_at: datetime | None = None


class BlockerModuleRender(BaseModel):
    """The ``constraints.solutions`` module rendered in the draft format.

    ``brief_markdown`` is one brief section, ``full_markdown`` the full-layer section with
    one sub-section per blocker. Neither carries a citation: ``citations`` go in the
    front matter, and ``evidence_by_section``, ``data_points`` and ``appendix_markdown``
    in Sources and data points (O1c).
    """

    module_key: str
    brief_section_id: str
    full_section_id: str
    section_ids: list[str]
    brief_markdown: str
    full_markdown: str
    citations: list[BlockerCitation]
    evidence_by_section: dict[str, list[str]]
    data_points: list[str]
    appendix_markdown: str

    @field_validator("brief_markdown", "full_markdown")
    @classmethod
    def _no_inline_citations(cls, v: str) -> str:
        from oracle.docs.parser import CITATION_RE

        if CITATION_RE.search(v):
            raise ValueError("a rendered body never carries citation markers (O1c)")
        return v


class BlockerSummary(BaseModel):
    """One row of ``GET /v1/blockers``."""

    id: uuid.UUID
    key: str
    statement: str
    type: BlockerType
    limit_kind: LimitKind
    third_party: str | None = None
    severity: Importance
    status: BlockerStatus
    selected_option_id: uuid.UUID | None = None
    document_ids: list[uuid.UUID]
    gate: BlockerGate
    updated_at: datetime


def dump(spec: BlockerSpec) -> dict[str, Any]:
    """``attrs["blocker"]`` as stored (JSON)."""
    return spec.model_dump(mode="json")
