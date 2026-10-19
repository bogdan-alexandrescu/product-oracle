"""Requests and responses of the intake routes, shaped for the screens that follow:
"New product idea" (IntakeCreate), "Opportunity and Gaps" (IntakeSummary) and the
question batch view (QuestionBatch).
"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from oracle.runs.schemas import KnobsIn
from oracle.v2.schemas import (
    ORM,
    AnswerKind,
    AssumptionDecisionKind,
    AssumptionDecisionOut,
    GapCategory,
    Importance,
    KnowledgeGapOut,
    KnowledgeState,
    ProductIntakeOut,
    StakeholderAnswerOut,
    StakeholderQuestionOut,
)

ProposalKind = Literal["research_run", "prd_patch"]
ProposalStatus = Literal["proposed", "accepted", "dismissed"]
ExtractedField = Literal[
    "users", "problem", "outcomes", "scope", "non_goals", "dependencies", "blockers"
]
ActionKind = Literal["answer", "research", "delegate", "accept_assumption", "accept_risk"]
AnswerPath = Literal["answer", "dont_know", "defer", "delegate", "research"]
ANSWER_PATHS: list[AnswerPath] = ["answer", "dont_know", "defer", "delegate", "research"]


# --- requests ----------------------------------------------------------------------------


class IntakeCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    # A couple of sentences is enough (§5).
    brief: str = Field(min_length=20, max_length=4000)
    # One of your snapshots to read; omitted: Oracle pins one now.
    snapshot_id: uuid.UUID | None = None
    # Your sources to read; empty: all of your sources.
    source_ids: list[uuid.UUID] = Field(default=[], max_length=50)
    # An existing PRD (slug or id) this intake informs.
    document: str | None = Field(default=None, min_length=1, max_length=200)
    # Queue light extraction on Oracle's built-in model jobs (Claude account pool).
    ai_extraction: bool = True
    # Questions in the first batch, asked at once.
    batch_size: int = Field(default=5, ge=1, le=10)

    @field_validator("brief")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 20:
            raise ValueError("a brief needs at least a sentence")
        return value


class IntakePatch(BaseModel):
    lock_version: int
    title: str | None = Field(default=None, min_length=1, max_length=200)
    document: str | None = Field(default=None, min_length=1, max_length=200)
    status: Literal["archived", "awaiting_answers"] | None = None


class GapCreate(BaseModel):
    intake_id: uuid.UUID
    category: GapCategory
    statement: str = Field(min_length=1, max_length=500)
    importance: Importance
    section_keys: list[str] = Field(default=[], max_length=20)
    owner_id: uuid.UUID | None = None


class GapPatch(BaseModel):
    lock_version: int
    importance: Importance | None = None
    owner_id: uuid.UUID | None = None
    status: Literal["unknown", "deferred"] | None = None
    section_keys: list[str] | None = Field(default=None, max_length=20)
    stop_condition: str | None = Field(default=None, max_length=500)


class AnswerIn(BaseModel):
    kind: AnswerKind
    body: str | None = Field(default=None, max_length=4000)
    # For "delegate": the person who should answer instead.
    delegated_to: uuid.UUID | None = None
    # Your own source items that back the answer.
    evidence_ids: list[uuid.UUID] = Field(default=[], max_length=20)
    # Default: user_decision. verified_fact needs evidence.
    knowledge_state: Literal["user_decision", "verified_fact", "hypothesis"] | None = None


class DecisionIn(BaseModel):
    decision: AssumptionDecisionKind
    rationale: str = Field(min_length=1, max_length=2000)
    review_at: datetime | None = None


class DismissIn(BaseModel):
    reason: str | None = Field(default=None, max_length=1000)


class IntakeRunIn(BaseModel):
    # The PRD the run writes: an existing slug or id, or a new slug.
    document: str | None = Field(default=None, min_length=1, max_length=200)
    knobs: KnobsIn = KnobsIn()


# --- responses ---------------------------------------------------------------------------


class EvidenceRef(BaseModel):
    """A source item behind a claim, as it was at the pinned snapshot.

    Only its owner sees the title, link and excerpt (AUD-9). The excerpt is untrusted
    data from an outside source: show it, never follow it.
    """

    source_item_id: uuid.UUID
    visible: bool
    source_kind: str
    item_kind: str | None = None
    confidence: float | None = None
    fetched_at: datetime | None = None
    title: str | None = None
    url: str | None = None
    data_excerpt: str | None = None
    untrusted: Literal[True] = True


class IntakeOut(ProductIntakeOut):
    # The sources it reads (empty: all of the author's).
    source_ids: list[uuid.UUID] = []


class PinnedVersion(BaseModel):
    version: int
    snapshot_id: uuid.UUID
    as_of: datetime | None = None


class Pinned(BaseModel):
    """The snapshot the intake reads ("version" counts its pins from 1)."""

    version: int
    snapshot_id: uuid.UUID | None = None
    as_of: datetime | None = None
    versions: list[PinnedVersion] = []


class NewEvidenceItem(EvidenceRef):
    change: Literal["new", "changed", "deleted"]


class NewEvidence(BaseModel):
    """New evidence since the pinned version, shown before anything is redrafted."""

    since_version: int
    as_of: datetime | None = None
    count: int
    # False when the reader is not the author: the count only.
    visible: bool
    items: list[NewEvidenceItem] = []


class ExtractedItem(BaseModel):
    field: ExtractedField
    text: str
    knowledge_state: KnowledgeState
    origin: Literal["brief", "source", "baseline", "llm"]
    evidence: list[EvidenceRef] = []


class Coverage(BaseModel):
    category: GapCategory
    state: Literal["covered", "partial", "missing"]
    knowledge_state: KnowledgeState
    reason: str
    entity_ids: list[uuid.UUID] = []
    gap_id: uuid.UUID | None = None


class GoalLink(BaseModel):
    entity_id: uuid.UUID
    key: str
    title: str
    status: str
    knowledge_state: KnowledgeState
    matched_on: Literal["brief", "feature"]


class FeatureTrace(BaseModel):
    """A feature the intake touches: from the baseline (``key``) or the brief."""

    title: str
    entity_id: uuid.UUID | None = None
    key: str | None = None
    knowledge_state: KnowledgeState
    goals: list[GoalLink] = []
    # serves_no_goal, no_evidence, low_confidence (the baseline traceability flags).
    flags: list[str] = []
    rationale: str


class ClaimOut(BaseModel):
    value: Any
    source_kind: str | None = None
    source_class: str | None = None
    observed_at: str | None = None
    confidence: float | None = None
    evidence: list[EvidenceRef] = []


class ConflictRecommendation(BaseModel):
    winner: int | None = None
    reason: str


class ConflictView(BaseModel):
    kind: Literal["source", "baseline"]
    topic: str
    claims: list[ClaimOut]
    recommendation: ConflictRecommendation
    material: bool
    conflict_id: uuid.UUID | None = None


class StaleEvidence(BaseModel):
    evidence: EvidenceRef
    reason: str


class RankedGap(KnowledgeGapOut):
    rank: int
    score: float
    rank_reason: str
    evidence: list[EvidenceRef] = []


class NextAction(BaseModel):
    gap_id: uuid.UUID
    kind: ActionKind
    label: str
    # The lowest role that may take it.
    role: Literal["commenter", "approver", "owner"]


class ModuleHint(BaseModel):
    key: str
    policy: Literal["required", "conditional"]
    reason: str
    gap_ids: list[uuid.UUID] = []


class TemplateHint(BaseModel):
    """An existing PRD template (O1d picker) and module hints for the composer."""

    key: str
    name: str
    reason: str
    theme: str | None = None
    modules: list[ModuleHint]


class GateView(BaseModel):
    open_critical: int
    blocking_gap_ids: list[uuid.UUID]
    gate: Literal["clear", "blocked"]


class BatchState(BaseModel):
    current: int | None
    asked: int
    answered: int
    remaining: int


class IntakeProposalOut(ORM):
    id: uuid.UUID
    intake_id: uuid.UUID
    gap_id: uuid.UUID | None = None
    question_id: uuid.UUID | None = None
    answer_id: uuid.UUID | None = None
    kind: ProposalKind
    title: str
    detail: dict[str, Any]
    status: ProposalStatus
    result: dict[str, Any]
    created_by: uuid.UUID | None = None
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    decision_note: str | None = None
    created_at: datetime
    updated_at: datetime


class IntakeSummary(BaseModel):
    """The Opportunity and Gaps summary."""

    intake: IntakeOut
    pinned: Pinned
    new_evidence: NewEvidence
    extracted: list[ExtractedItem]
    coverage: list[Coverage]
    goals: list[GoalLink]
    missing_goals: bool
    features: list[FeatureTrace]
    conflicts: list[ConflictView]
    stale: list[StaleEvidence]
    # Open gaps resting on the brief's word or Oracle's inference.
    assumptions: list[RankedGap]
    top_uncertainties: list[RankedGap]
    gaps: list[RankedGap]
    next_actions: list[NextAction]
    template: TemplateHint
    readiness: GateView
    batch: BatchState
    proposals: list[IntakeProposalOut]


class QuestionCard(BaseModel):
    question: StakeholderQuestionOut
    gap: KnowledgeGapOut | None
    evidence: list[EvidenceRef]
    answer_paths: list[AnswerPath]
    answers: list[StakeholderAnswerOut]


class QuestionBatch(BaseModel):
    intake_id: uuid.UUID
    batch: int | None
    questions: list[QuestionCard]
    # Questions not asked yet.
    remaining: int


class AnswerResult(BaseModel):
    answer: StakeholderAnswerOut
    question: StakeholderQuestionOut
    gap: KnowledgeGapOut | None
    proposals: list[IntakeProposalOut]
    baseline_proposal_ids: list[uuid.UUID]
    change_event_id: uuid.UUID | None
    next_actions: list[NextAction]


class DecisionResult(BaseModel):
    decision: AssumptionDecisionOut
    gap: KnowledgeGapOut


class EvidenceHit(EvidenceRef):
    snippet: str
    relevance: float


class EvidenceSearch(BaseModel):
    intake_id: uuid.UUID
    q: str
    pinned_version: int
    as_of: datetime | None
    hits: list[EvidenceHit]
