"""Pydantic schemas for the v2 tables (oracle.v2.models) and their typed JSON columns.

``*Out`` models are what the thin read routes return; lanes reuse them in their write
routes. The value sets mirror the check constraints in :mod:`oracle.v2.models`.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.v2.contract import ModulePolicy, OutputKind

ModuleOrigin = Literal["builtin", "company"]
CompositionRevisionStatus = Literal["working", "confirmed", "published", "superseded"]
IntakeStatus = Literal["draft", "analyzing", "awaiting_answers", "ready", "converted", "archived"]
GapStatus = Literal[
    "unknown",
    "under_investigation",
    "asked",
    "answered",
    "answered_pending_review",
    "validated",
    "deferred",
    "accepted_risk",
]
GapCategory = Literal[
    "customer_user",
    "pain_evidence",
    "goal_alignment",
    "success_metric",
    "differentiation",
    "alternatives",
    "constraints",
    "blockers",
    "economic_benefit",
    "effort_cost",
    "security_privacy",
    "ownership",
    "non_goals",
    "release_rollout",
    "evaluation_criteria",
    "third_party_policy",
    "configurability_scaling",
]
ImpactArea = Literal["goals", "feasibility", "scope", "economics", "risks", "module_selection"]
Importance = Literal["critical", "high", "medium", "low"]
KnowledgeState = Literal["verified_fact", "user_decision", "ai_inference", "hypothesis", "unknown"]
QuestionStatus = Literal[
    "draft", "asked", "answered", "deferred", "delegated", "researching", "withdrawn"
]
AnswerKind = Literal["answer", "dont_know", "defer", "delegate", "research"]
AssumptionDecisionKind = Literal["accept_assumption", "accept_risk", "validate", "reject"]
BlockerApproach = Literal[
    "direct_remedy",
    "alternative_workflow",
    "architecture",
    "partnership",
    "operations",
    "distribution",
]
Feasibility = Literal["high", "medium", "low", "unknown"]
Compliance = Literal["compliant", "needs_review", "non_compliant"]
BlockerOptionStatus = Literal["proposed", "evaluating", "selected", "fallback", "rejected"]
ExperimentStatus = Literal["planned", "running", "succeeded", "failed", "inconclusive", "cancelled"]
BlockerStatus = Literal["open", "mitigating", "resolved", "accepted_risk", "feasibility_only"]
BlockerEventKind = Literal[
    "status_changed",
    "option_selected",
    "experiment_started",
    "experiment_concluded",
    "risk_accepted",
    "feasibility_scope_approved",
    "reopened",
]
Freshness = Literal["fresh", "potentially_stale", "under_review", "reconciled"]
SectionLinkKind = Literal["implements", "evidences", "claims", "tests", "mentions"]
LinkPrecision = Literal["section", "paragraph", "claim"]
ChangeSubject = Literal[
    "document_section",
    "requirement",
    "decision",
    "source_permission",
    "blocker_status",
    "composition_revision",
    "document_version",
    "entity",
    "artifact_version",
]
FindingStatus = Literal["pass", "warning", "critical", "not_applicable"]
Evaluator = Literal["rules", "llm_job", "agent", "human"]
ReportStatus = Literal["pending", "complete", "failed"]
ArtifactKind = Literal[
    "tech_brief",
    "engineering_spec",
    "user_flow",
    "wireframe",
    "prototype",
    "acceptance_tests",
    "figma_design",
]
ArtifactRequestStatus = Literal[
    "requested", "queued", "running", "succeeded", "partial", "failed", "blocked", "cancelled"
]
ArtifactVersionStatus = Literal["draft", "in_review", "approved", "rejected", "superseded"]
ArtifactReviewKind = Literal[
    "comment", "approved", "changes_requested", "rejected", "marked_stale", "reconciled"
]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- typed JSON column values -----------------------------------------------------------


class CompositionModule(BaseModel):
    """One module in a composition revision (``composition_revisions.modules``)."""

    key: str
    version: str
    policy: ModulePolicy
    included: bool
    # Why it is in or out: policy, a condition that held, a person's choice.
    reason: str
    order: int
    section_ids: list[str] = []
    # Inputs or assumptions that drove the choice (gap, evidence or entity ids).
    driven_by: list[uuid.UUID] = []
    # Advisory signal (§4.3 step 3); never decides on its own.
    score: float | None = None
    # Set when a person overrode the recommendation.
    overridden_by: uuid.UUID | None = None


class CompositionInputs(BaseModel):
    """What a composition was computed from (§4.3 step 1). Conditions read these roots."""

    template: dict[str, Any] = {}
    brief: dict[str, Any] = {}
    category: str | None = None
    scope: dict[str, Any] = {}
    signals: dict[str, Any] = {}
    baseline: dict[str, Any] = {}
    sources: dict[str, Any] = {}
    stakeholders: dict[str, Any] = {}
    outputs: list[OutputKind] = []
    blockers: dict[str, Any] = {}
    policy: dict[str, Any] = {}
    intake_id: uuid.UUID | None = None
    baseline_snapshot_id: uuid.UUID | None = None
    source_snapshot_ids: list[uuid.UUID] = []


class IntakeAnalysis(BaseModel):
    """What Oracle extracted from a brief (§5 step 1), each item with its knowledge state."""

    users: list[dict[str, Any]] = []
    problem: dict[str, Any] | None = None
    outcomes: list[dict[str, Any]] = []
    goal_ids: list[uuid.UUID] = []
    scope: list[str] = []
    non_goals: list[str] = []
    dependencies: list[str] = []
    blockers: list[dict[str, Any]] = []
    category: str | None = None
    conflicts: list[dict[str, Any]] = []


class BlockerAttrs(BaseModel):
    """``attrs["blocker"]`` of a baseline ``constraint`` entity: the blocker itself (§6)."""

    type: Literal["hard", "soft", "unknown", "temporary"]
    # §6: capacity versus eligibility versus permission versus third-party policy.
    limit_kind: Literal["capacity", "eligibility", "permission", "policy", "other"] = "other"
    severity: Importance = "medium"
    status: BlockerStatus = "open"
    timing: str | None = None
    threshold: str | None = None
    impacted_entity_ids: list[uuid.UUID] = []
    owner_id: uuid.UUID | None = None
    review_at: datetime | None = None


class BlockerOptionDetails(BaseModel):
    """``blocker_options.details``."""

    expected_outcome: str | None = None
    cost: str | None = None
    effort: str | None = None
    risk: str | None = None
    residual_limitations: str | None = None
    fallback: str | None = None
    monitoring_signal: str | None = None
    scaling_trigger: str | None = None
    corrective_action: str | None = None
    review_at: datetime | None = None


# --- modules ----------------------------------------------------------------------------


class ModuleDefinitionOut(ORM):
    id: uuid.UUID
    key: str
    title: str
    description: str | None = None
    builtin: bool
    archived_at: datetime | None = None
    created_by: uuid.UUID | None = None
    created_at: datetime


class ModuleVersionOut(ORM):
    id: uuid.UUID
    module_id: uuid.UUID
    version: str
    contract: dict[str, Any]
    contract_hash: str
    origin: ModuleOrigin
    created_by: uuid.UUID | None = None
    created_at: datetime


class TemplateModuleAssignmentOut(ORM):
    id: uuid.UUID
    template_id: uuid.UUID
    module_key: str
    module_version: str | None = None
    policy: ModulePolicy
    display_order: int
    section_ids: list[str]
    since_template_version: int | None = None
    manifest_format: int
    created_by: uuid.UUID | None = None
    created_at: datetime


class DocumentCompositionOut(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    template: str | None = None
    template_version: str | None = None
    current_revision: int | None = None
    lock_version: int
    created_at: datetime
    updated_at: datetime


class CompositionRevisionOut(ORM):
    id: uuid.UUID
    composition_id: uuid.UUID
    number: int
    status: CompositionRevisionStatus
    modules: list[CompositionModule]
    inputs: CompositionInputs
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    reason: str | None = None
    parent_number: int | None = None
    document_version_id: uuid.UUID | None = None
    lock_version: int
    created_at: datetime


# --- intake -----------------------------------------------------------------------------


class ProductIntakeOut(ORM):
    id: uuid.UUID
    title: str
    brief: str
    author_id: uuid.UUID | None = None
    source_snapshot_ids: list[uuid.UUID]
    status: IntakeStatus
    analysis: IntakeAnalysis
    document_id: uuid.UUID | None = None
    lock_version: int
    created_at: datetime
    updated_at: datetime


class KnowledgeGapOut(ORM):
    id: uuid.UUID
    intake_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    category: GapCategory
    statement: str
    impact: list[ImpactArea]
    importance: Importance
    evidence_ids: list[uuid.UUID]
    confidence: Decimal | None = Field(default=None, ge=0, le=1)
    knowledge_state: KnowledgeState
    status: GapStatus
    owner_id: uuid.UUID | None = None
    related_modules: list[str]
    stop_condition: str | None = None
    entity_ids: list[uuid.UUID]
    section_keys: list[str]
    created_by: uuid.UUID | None = None
    lock_version: int
    created_at: datetime
    updated_at: datetime


class StakeholderQuestionOut(ORM):
    id: uuid.UUID
    gap_id: uuid.UUID | None = None
    intake_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    category: GapCategory
    prompt: str
    rationale: str | None = None
    priority: int
    batch: int | None = None
    asked_to: uuid.UUID | None = None
    asked_by: uuid.UUID | None = None
    module_key: str | None = None
    section_key: str | None = None
    status: QuestionStatus
    created_at: datetime
    updated_at: datetime


class StakeholderAnswerOut(ORM):
    id: uuid.UUID
    question_id: uuid.UUID
    kind: AnswerKind
    body: str | None = None
    answered_by: uuid.UUID | None = None
    delegated_to: uuid.UUID | None = None
    evidence_ids: list[uuid.UUID]
    knowledge_state: KnowledgeState
    created_at: datetime


class AssumptionDecisionOut(ORM):
    id: uuid.UUID
    gap_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    entity_id: uuid.UUID | None = None
    statement: str
    decision: AssumptionDecisionKind
    rationale: str
    decided_by: uuid.UUID | None = None
    decided_at: datetime
    review_at: datetime | None = None
    created_at: datetime


# --- blockers ---------------------------------------------------------------------------


class BlockerOptionOut(ORM):
    id: uuid.UUID
    blocker_id: uuid.UUID
    title: str
    approach: BlockerApproach
    description: str | None = None
    technical_feasibility: Feasibility
    policy_feasibility: Feasibility
    compliance: Compliance
    status: BlockerOptionStatus
    details: BlockerOptionDetails
    evidence_ids: list[uuid.UUID]
    owner_id: uuid.UUID | None = None
    selected_reason: str | None = None
    created_by: uuid.UUID | None = None
    lock_version: int
    created_at: datetime
    updated_at: datetime


class FeasibilityExperimentOut(ORM):
    id: uuid.UUID
    blocker_id: uuid.UUID
    option_id: uuid.UUID | None = None
    hypothesis: str
    method: str | None = None
    success_threshold: str | None = None
    owner_id: uuid.UUID | None = None
    decision_gate_at: datetime | None = None
    status: ExperimentStatus
    result: str | None = None
    evidence_ids: list[uuid.UUID]
    lock_version: int
    created_at: datetime
    updated_at: datetime


class BlockerResolutionEventOut(ORM):
    id: uuid.UUID
    blocker_id: uuid.UUID
    option_id: uuid.UUID | None = None
    experiment_id: uuid.UUID | None = None
    kind: BlockerEventKind
    from_status: BlockerStatus | None = None
    to_status: BlockerStatus | None = None
    reason: str | None = None
    actor: str
    data: dict[str, Any]
    created_at: datetime


# --- change events and trace ------------------------------------------------------------


class ChangeEventOut(ORM):
    id: uuid.UUID
    subject_kind: ChangeSubject
    subject_id: uuid.UUID | None = None
    subject_ref: str | None = None
    document_id: uuid.UUID | None = None
    cause: str
    actor: str
    data: dict[str, Any]
    handled_by: list[str]
    created_at: datetime


class DocumentSectionLinkOut(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    version_id: uuid.UUID | None = None
    section_key: str
    section_hash: str | None = None
    composition_revision: int | None = None
    module_key: str | None = None
    kind: SectionLinkKind
    entity_id: uuid.UUID | None = None
    evidence_id: uuid.UUID | None = None
    source_item_id: uuid.UUID | None = None
    precision: LinkPrecision
    claim: str | None = None
    created_by: uuid.UUID | None = None
    created_at: datetime


class ArtifactDependencyOut(ORM):
    id: uuid.UUID
    artifact_version_id: uuid.UUID | None = None
    document_version_id: uuid.UUID | None = None
    upstream_version_id: uuid.UUID | None = None
    upstream_section_key: str | None = None
    upstream_section_hash: str | None = None
    upstream_entity_id: uuid.UUID | None = None
    composition_revision: int | None = None
    freshness: Freshness
    caused_by_change_id: uuid.UUID | None = None
    stale_since: datetime | None = None
    reconciled_by: uuid.UUID | None = None
    reconciled_at: datetime | None = None
    note: str | None = None
    created_at: datetime
    updated_at: datetime


# --- evaluation -------------------------------------------------------------------------


class EvaluationFindingOut(ORM):
    id: uuid.UUID
    report_id: uuid.UUID
    criterion: str
    status: FindingStatus
    hard: bool
    rationale: str
    evidence_ids: list[uuid.UUID]
    owner_id: uuid.UUID | None = None
    section_keys: list[str]
    module_key: str | None = None
    created_at: datetime


class EvaluationReportOut(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    version_id: uuid.UUID | None = None
    composition_revision: int | None = None
    evaluator: Evaluator
    policy: str
    status: ReportStatus
    summary: dict[str, Any]
    created_by: uuid.UUID | None = None
    created_at: datetime


class EvaluationReportDetail(EvaluationReportOut):
    findings: list[EvaluationFindingOut] = []


# --- artifacts --------------------------------------------------------------------------


class ArtifactRequestOut(ORM):
    id: uuid.UUID
    kind: ArtifactKind
    title: str
    source_document_id: uuid.UUID
    source_version_id: uuid.UUID | None = None
    requirement_ids: list[uuid.UUID]
    section_keys: list[str]
    params: dict[str, Any]
    status: ArtifactRequestStatus
    run_id: uuid.UUID | None = None
    requested_by: uuid.UUID | None = None
    lock_version: int
    created_at: datetime
    updated_at: datetime


class ArtifactVersionOut(ORM):
    id: uuid.UUID
    request_id: uuid.UUID
    number: int
    status: ArtifactVersionStatus
    freshness: Freshness
    source_version_id: uuid.UUID | None = None
    composition_revision: int | None = None
    content_hash: str | None = None
    summary: str | None = None
    provenance: dict[str, Any]
    created_by: uuid.UUID | None = None
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    created_at: datetime


class ArtifactOutputOut(ORM):
    """Metadata of an output; its content comes from a lane's download route."""

    id: uuid.UUID
    version_id: uuid.UUID
    name: str
    media_type: str
    size_bytes: int
    sha256: str
    meta: dict[str, Any]
    created_at: datetime


class ArtifactReviewEventOut(ORM):
    id: uuid.UUID
    version_id: uuid.UUID
    kind: ArtifactReviewKind
    body: str | None = None
    actor: str
    data: dict[str, Any]
    created_at: datetime
