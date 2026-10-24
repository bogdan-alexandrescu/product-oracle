"""Request and response shapes of the decision log (``/v1/decisions``)."""

import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from oracle.quality.schemas import Prediction

Reversibility = Literal["reversible", "irreversible"]
DecisionStatus = Literal["proposed", "decided", "superseded", "reversed", "withdrawn"]
# The table's state chip: a decided judgement call whose review date has come is review_due.
DecisionState = Literal["proposed", "decided", "review_due", "superseded", "reversed", "withdrawn"]
DecisionClass = Literal["judgement", "checkpoint"]
Origin = Literal[
    "manual",
    "oracle",
    "version_approval",
    "assumption",
    "blocker",
    "pushback_override",
    "priority_override",
    "autonomy",
    "checkpoint",
    "request_decline",
]
SubjectKind = Literal[
    "document",
    "document_version",
    "section",
    "roadmap_item",
    "entity",
    "blocker",
    "gap",
    "run",
    "ritual_occurrence",
    "discussion",
    "request",
]
Verdict = Literal["reaffirmed", "revisit", "reversed"]
OPTION_KEY = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$"
MAX_OPTIONS = 6
MAX_SUBJECTS = 10
MAX_PEOPLE = 50
MAX_IDS = 100


class DecisionOption(BaseModel):
    key: str = Field(pattern=OPTION_KEY)
    label: str = Field(min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=1000)
    pros: list[str] = Field(default=[], max_length=20)
    cons: list[str] = Field(default=[], max_length=20)
    evidence_ids: list[uuid.UUID] = Field(default=[], max_length=50)
    cost_if_wrong: str | None = Field(default=None, max_length=1000)
    # Oracle's pick (Ask Oracle for options); people never set it.
    recommended: bool = False

    @field_validator("pros", "cons")
    @classmethod
    def _lines(cls, value: list[str]) -> list[str]:
        out = [v.strip() for v in value if v and v.strip()]
        if any(len(v) > 500 for v in out):
            raise ValueError("each pro or con is at most 500 characters")
        return out


def _unique_options(options: list[DecisionOption]) -> list[DecisionOption]:
    keys = [o.key for o in options]
    if len(set(keys)) != len(keys):
        raise ValueError("option keys must be unique")
    return options


class Subject(BaseModel):
    kind: SubjectKind
    id: uuid.UUID
    ref: str | None = Field(default=None, max_length=300)


class PredictionIn(Prediction):
    """A measurable version of the expected outcome: deciding creates its outcome record."""

    goal_id: uuid.UUID


class DecisionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    question: str | None = Field(default=None, max_length=1000)
    context: str | None = Field(default=None, max_length=4000)
    # Up to six; at least two are needed to decide (Ask Oracle for options fills them).
    options: list[DecisionOption] = Field(default=[], max_length=MAX_OPTIONS)
    approver_id: uuid.UUID
    reversibility: Reversibility = "reversible"
    contributor_ids: list[uuid.UUID] = Field(default=[], max_length=MAX_PEOPLE)
    informed_ids: list[uuid.UUID] = Field(default=[], max_length=MAX_PEOPLE)
    evidence_ids: list[uuid.UUID] = Field(default=[], max_length=MAX_IDS)
    entity_ids: list[uuid.UUID] = Field(default=[], max_length=MAX_IDS)
    subjects: list[Subject] = Field(default=[], max_length=MAX_SUBJECTS)

    @field_validator("options")
    @classmethod
    def _options(cls, value: list[DecisionOption]) -> list[DecisionOption]:
        return _unique_options(value)


class DecisionPatch(BaseModel):
    """Edit a proposed decision (lock_version required). On a decided captured call its
    approver may change only review_at, expected_outcome and prediction."""

    lock_version: int
    title: str | None = Field(default=None, min_length=1, max_length=200)
    question: str | None = Field(default=None, max_length=1000)
    context: str | None = Field(default=None, max_length=4000)
    options: list[DecisionOption] | None = Field(default=None, max_length=MAX_OPTIONS)
    reversibility: Reversibility | None = None
    contributor_ids: list[uuid.UUID] | None = Field(default=None, max_length=MAX_PEOPLE)
    informed_ids: list[uuid.UUID] | None = Field(default=None, max_length=MAX_PEOPLE)
    evidence_ids: list[uuid.UUID] | None = Field(default=None, max_length=MAX_IDS)
    entity_ids: list[uuid.UUID] | None = Field(default=None, max_length=MAX_IDS)
    subjects: list[Subject] | None = Field(default=None, max_length=MAX_SUBJECTS)
    review_at: date | None = None
    expected_outcome: str | None = Field(default=None, max_length=2000)
    prediction: PredictionIn | None = None

    @field_validator("options")
    @classmethod
    def _options(cls, value: list[DecisionOption] | None) -> list[DecisionOption] | None:
        return None if value is None else _unique_options(value)


class DecideIn(BaseModel):
    option_key: str = Field(min_length=1, max_length=80)
    rationale: str = Field(max_length=4000)
    # The approver confirms it; defaults to the decision's.
    reversibility: Reversibility | None = None
    # Default: the proposal's review date, else the decision date plus 90 days; at most
    # 365 days out, never in the past.
    review_at: date | None = None
    expected_outcome: str = Field(max_length=2000)
    prediction: PredictionIn | None = None
    lock_version: int | None = None


class ReassignIn(BaseModel):
    approver_id: uuid.UUID
    reason: str = Field(min_length=1, max_length=1000)


class WithdrawIn(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


class ReviewIn(BaseModel):
    verdict: Verdict
    note: str = Field(min_length=1, max_length=4000)
    # Reaffirmed: the next review (default plus 90 days, at most 365 days out).
    next_review_at: date | None = None

    @model_validator(mode="after")
    def _note(self) -> "ReviewIn":
        if not self.note.strip():
            raise ValueError("say what the review found (note)")
        return self


class DecisionSource(BaseModel):
    """What a captured record came from; for a checkpoint record, the stop."""

    kind: str
    id: uuid.UUID
    checkpoint_kind: str | None = None
    segment: str | None = None


class DecisionReviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    verdict: Verdict
    note: str
    outcome_status: str | None = None
    next_review_at: date | None = None
    revisit_id: uuid.UUID | None = None
    reviewed_by: uuid.UUID
    reviewed_by_email: str | None = None
    created_at: datetime


class DecisionSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    number: int
    # "D-12"
    ref: str
    title: str
    status: DecisionStatus
    state: DecisionState
    class_: DecisionClass = Field(alias="class")
    origin: Origin
    reversibility: Reversibility
    approver_id: uuid.UUID
    approver_email: str | None = None
    chosen_option: str | None = None
    decided_at: datetime | None = None
    review_at: date | None = None
    run_id: uuid.UUID | None = None
    created_at: datetime
    source: DecisionSource | None = None


class DecisionOut(DecisionSummary):
    question: str | None = None
    context: str | None = None
    options: list[DecisionOption] = []
    rationale: str | None = None
    driver: str
    contributor_ids: list[uuid.UUID] = []
    informed_ids: list[uuid.UUID] = []
    evidence_ids: list[uuid.UUID] = []
    entity_ids: list[uuid.UUID] = []
    subjects: list[dict[str, Any]] = []
    expected_outcome: str | None = None
    prediction: dict[str, Any] | None = None
    outcome_id: uuid.UUID | None = None
    supersedes_id: uuid.UUID | None = None
    # The proposed decision a "revisit" review opened, while it is open or once decided.
    revisit_id: uuid.UUID | None = None
    superseded_by_id: uuid.UUID | None = None
    entity_id: uuid.UUID | None = None
    decided_via: str | None = None
    decided_by: uuid.UUID | None = None
    decided_by_email: str | None = None
    decided_actor: str | None = None
    # Who withdrew a withdrawn proposal, when and the reason they gave (#404).
    withdrawn_at: datetime | None = None
    withdrawn_by: uuid.UUID | None = None
    withdrawn_by_email: str | None = None
    withdrawn_reason: str | None = None
    created_by: uuid.UUID | None = None
    updated_at: datetime
    lock_version: int
    reviews: list[DecisionReviewOut] = []
    # What the caller may do now (the page draws its actions from these).
    can_edit: bool = False
    can_decide: bool = False
    can_withdraw: bool = False
    can_review: bool = False
    can_reassign: bool = False


class DecisionPerson(BaseModel):
    """An active member, for the approver, contributor and informed pickers."""

    id: uuid.UUID
    email: str
    role: Literal["viewer", "commenter", "approver", "owner"]


InboxDecisionReason = Literal["needs_decision", "review_due", "oracle_decided", "informed"]
