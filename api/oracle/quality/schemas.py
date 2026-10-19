"""Schemas for PRD quality and readiness, outcome tracking and learnings (CR-08)."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from oracle.v2.schemas import FindingStatus, GapCategory

# --- typed attrs the hard checks read on baseline entities ------------------------------


class PolicyRequirement(BaseModel):
    """``attrs["policy"]`` of a requirement, constraint or risk: a security or policy rule.

    Only ``critical`` and ``failed`` together block a publish (T2).
    """

    area: Literal["security", "privacy", "platform_policy", "legal", "compliance"]
    critical: bool = False
    status: Literal["met", "unverified", "failed"] = "unverified"
    note: str | None = None


class ThirdPartyOperation(BaseModel):
    """``attrs["third_party"]``: an operation the product needs from a third party.

    ``limit_kind`` keeps rate and capacity apart from eligibility, permission and policy
    (§16 item 8); only the last three can make an operation unsupported.
    """

    provider: str
    operation: str
    limit_kind: Literal["rate_capacity", "eligibility", "permission", "policy"] = "policy"
    # False: the provider does not support or permit it; None: not verified yet.
    supported: bool | None = None
    note: str | None = None


# --- criteria and the dashboard ---------------------------------------------------------


class CriterionInfo(BaseModel):
    key: str
    title: str
    # The question the criterion answers about a PRD.
    question: str
    # True for the hard checks (they can block a publish); the ten criteria are advisory.
    hard: bool
    # What it reads, in words.
    reads: list[str]


class ModelView(BaseModel):
    """The built-in quality review job's view of one criterion. Model output, not fact."""

    status: FindingStatus
    rationale: str
    section_keys: list[str] = []
    report_id: uuid.UUID


class HumanView(BaseModel):
    status: FindingStatus
    rationale: str
    rater_id: uuid.UUID | None = None
    report_id: uuid.UUID
    created_at: datetime


class Agreement(BaseModel):
    # Whether the model's status equals the rules' status (None: no model view).
    model: bool | None = None
    # Share of human ratings equal to the rules' status (None: no rating).
    human: float | None = None


class ReadinessItem(BaseModel):
    key: str
    title: str
    question: str
    hard: bool
    status: FindingStatus
    rationale: str
    evidence_ids: list[uuid.UUID] = []
    owner_id: uuid.UUID | None = None
    section_keys: list[str] = []
    # Set when the check could not run (an advisory check then shows a warning).
    error: str | None = None
    model: ModelView | None = None
    human: list[HumanView] = []
    agreement: Agreement = Agreement()


class ModelReviewInfo(BaseModel):
    report_id: uuid.UUID
    job_id: uuid.UUID | None = None
    model: str | None = None
    created_at: datetime
    label: Literal["model_output"] = "model_output"
    disclaimer: str


class ReportRef(BaseModel):
    id: uuid.UUID
    created_at: datetime


class ReadinessDashboard(BaseModel):
    """The soft readiness dashboard of one document version, criterion by criterion."""

    document_id: uuid.UUID
    slug: str
    version: int
    version_id: uuid.UUID
    composition_revision: int | None = None
    # T2 (2026-10-19): advisory; only hard checks block.
    policy: Literal["advisory"] = "advisory"
    policy_note: str
    evaluated_at: datetime
    blocked: bool
    # Keys of the hard checks that are critical.
    blocking: list[str]
    counts: dict[str, int]
    items: list[ReadinessItem]
    model_review: ModelReviewInfo | None = None
    # The latest stored rules report of this version, if any.
    latest_report: ReportRef | None = None


class HumanRatingItem(BaseModel):
    criterion: str = Field(min_length=1, max_length=100)
    status: FindingStatus
    rationale: str = Field(min_length=1, max_length=4000)
    section_keys: list[str] = Field(default=[], max_length=50)


class HumanRatingIn(BaseModel):
    """A person's rating of the ten criteria (all or some), for comparison with the rules."""

    ratings: list[HumanRatingItem] = Field(min_length=1, max_length=20)
    note: str | None = Field(default=None, max_length=4000)


# --- outcomes and learnings -------------------------------------------------------------

OutcomeStatus = Literal["tracking", "held", "partially_held", "not_held", "inconclusive"]
Verdict = Literal["held", "partially_held", "not_held", "inconclusive"]
LearningTarget = Literal["module", "question_category", "criterion"]
LearningDirection = Literal["recommend_more", "recommend_less", "note"]
LearningStatus = Literal["active", "retired"]


class Prediction(BaseModel):
    """What the PRD predicted for the goal, in its own words and numbers."""

    metric: str = Field(min_length=1, max_length=300)
    baseline: str | None = Field(default=None, max_length=300)
    predicted: str = Field(min_length=1, max_length=300)
    threshold: str | None = Field(default=None, max_length=300)
    by: date | None = None


class OutcomeCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    # The confirmed or proposed company goal (a baseline ``goal`` entity) it serves.
    goal_id: uuid.UUID
    # A baseline ``outcome`` entity it measures, if the baseline has one.
    outcome_entity_id: uuid.UUID | None = None
    # What launched: an approved PRD version, a roadmap item, a validation experiment.
    prd_version_id: uuid.UUID | None = None
    roadmap_version_id: uuid.UUID | None = None
    roadmap_item_key: str | None = Field(default=None, max_length=200)
    experiment_id: uuid.UUID | None = None
    prediction: Prediction
    # Modules and question categories the prediction rested on (for learnings).
    module_keys: list[str] = Field(default=[], max_length=50)
    gap_categories: list[GapCategory] = Field(default=[], max_length=17)
    owner_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _linked(self) -> "OutcomeCreate":
        if not (self.prd_version_id or self.roadmap_version_id or self.experiment_id):
            raise ValueError(
                "link what launched: prd_version_id, roadmap_version_id or experiment_id"
            )
        if bool(self.roadmap_version_id) != bool(self.roadmap_item_key):
            raise ValueError("roadmap_version_id and roadmap_item_key go together")
        return self


class AssessmentIn(BaseModel):
    verdict: Verdict
    observed: str = Field(min_length=1, max_length=1000)
    note: str | None = Field(default=None, max_length=4000)
    evidence_ids: list[uuid.UUID] = Field(default=[], max_length=50)


class Assessment(BaseModel):
    verdict: Verdict
    observed: str
    note: str | None = None
    evidence_ids: list[uuid.UUID] = []
    assessed_by: uuid.UUID | None = None
    assessed_at: datetime


class OutcomeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    goal_id: uuid.UUID
    outcome_entity_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    prd_version_id: uuid.UUID | None = None
    roadmap_version_id: uuid.UUID | None = None
    roadmap_item_key: str | None = None
    experiment_id: uuid.UUID | None = None
    prediction: Prediction
    module_keys: list[str]
    gap_categories: list[str]
    status: OutcomeStatus
    observed: str | None = None
    assessments: list[Assessment]
    owner_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None
    assessed_at: datetime | None = None
    lock_version: int
    created_at: datetime
    updated_at: datetime


class LearningDraft(BaseModel):
    """A learning Oracle suggests from an assessment; a person decides to keep it."""

    outcome_id: uuid.UUID | None = None
    statement: str = Field(min_length=1, max_length=2000)
    applies_to: LearningTarget
    target: str = Field(min_length=1, max_length=200)
    direction: LearningDirection
    weight: int = Field(default=1, ge=1, le=3)


class AssessmentResult(BaseModel):
    outcome: OutcomeOut
    suggested_learnings: list[LearningDraft]


class LearningCreate(LearningDraft):
    pass


class LearningRetire(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)


class LearningOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    outcome_id: uuid.UUID | None = None
    statement: str
    applies_to: LearningTarget
    target: str
    direction: LearningDirection
    weight: int
    status: LearningStatus
    retired_reason: str | None = None
    created_by: uuid.UUID | None = None
    retired_by: uuid.UUID | None = None
    retired_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class LearningSignal(BaseModel):
    """The net recommendation signal for one module, question category or criterion.

    ``score``: sum of weights, + for recommend_more, - for recommend_less, 0 for notes.
    Advisory input for future module and question recommendations; it never changes a
    published document.
    """

    applies_to: LearningTarget
    target: str
    score: int
    learning_ids: list[uuid.UUID]
    statements: list[str]
