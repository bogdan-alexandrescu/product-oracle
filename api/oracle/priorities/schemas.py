import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Method = Literal["goal_weighted", "rice", "moscow", "wsjf"]
OverrideKind = Literal["move", "pin"]
ReasonCheckStatus = Literal["contradiction", "no_contradiction", "skipped", "failed", "timed_out"]


class GoalTerm(BaseModel):
    goal: str
    title: str
    weight: float
    weight_assumed: bool
    contribution: int
    contribution_assumed: bool
    # Status of the feature -> goal 'supports' link.
    link_status: str
    term: float | None


class EvidenceUsed(BaseModel):
    id: str
    confidence: float | None
    ref: str | None
    # From a source item since removed (a narrowed source, or deleted upstream: S5).
    source_removed: bool = False
    # What a person picks it by when citing it (C9): its source item's title, else its
    # link; the kind of source; the date it is from.
    title: str | None = None
    source_kind: str | None = None
    date: str | None = None


class ConfidenceUsed(BaseModel):
    value: float
    # evidence: mean of its scored evidence; baseline: the feature's stored
    # confidence; attrs: the feature's attrs; default: nothing known.
    source: Literal["evidence", "baseline", "attrs", "default"]
    explain: str
    evidence: list[EvidenceUsed]


class Explanation(BaseModel):
    method: Method
    formula: str
    # Each input by name: {"value", "attr", "raw"}; goal_value carries its terms.
    inputs: dict[str, Any]
    confidence: ConfidenceUsed
    goals: list[GoalTerm]
    missing: list[str]
    steps: list[str]
    # Why dependencies moved this feature (empty when they did not).
    order: list[str] = Field(default_factory=list)


class RowOverride(BaseModel):
    """The active move or pin that placed a row (C9)."""

    id: str
    kind: OverrideKind
    # Who made it: a member's email or an API token's name.
    by: str
    reason: str
    kept_after_pushback: bool = False
    # The anchor's key (a move) or the rank held (a pin).
    above: str | None = None
    position: int | None = None
    created_at: datetime | None = None


class RankedFeature(BaseModel):
    rank: int
    # Position by score alone, before dependency order.
    score_rank: int
    # Rank in Oracle's order (the formula and dependencies), before people's overrides.
    formula_rank: int | None = None
    entity_id: str
    key: str
    title: str
    status: str
    score: float | None
    serves_goal: bool
    # no_confirmed_goal, missing_inputs, no_confidence, low_confidence,
    # dependency_cycle, moved_for_dependency, held_by_dependency
    flags: list[str]
    depends_on: list[str]
    dependents: list[str]
    explanation: Explanation
    # A run's order (C8): the live ranking's rank of this feature, restricted to the
    # features the run ranks, and the run's own explanation (priority.yaml).
    live_rank: int | None = None
    run_explanation: str | None = None
    # The move or pin that placed it, if any.
    override: RowOverride | None = None
    # A prerequisite an override could not pass: the row sits just below it.
    held_below: str | None = None


class RankingCounts(BaseModel):
    features: int
    no_goal: int
    unscored: int
    in_cycles: int


class PriorityRanking(BaseModel):
    method: Method
    formula: str
    generated_at: datetime
    features: list[RankedFeature]
    # Each dependency cycle as the feature keys in it.
    cycles: list[list[str]]
    counts: RankingCounts


class PrioritySnapshotCreate(BaseModel):
    method: Method = "goal_weighted"
    note: str | None = Field(default=None, max_length=500)


SnapshotStatus = Literal["saved", "proposed", "discarded"]


class SnapshotDocument(BaseModel):
    """The PRD a run's order is for: its document once the draft imported, else the slug
    the run writes (no id or title yet)."""

    id: uuid.UUID | None = None
    slug: str
    title: str | None = None


class PrioritySnapshotSummary(BaseModel):
    id: uuid.UUID
    method: Method
    created_by: uuid.UUID | None
    created_at: datetime
    note: str | None
    feature_count: int
    top: list[str]
    # saved: a person's snapshot, or a run's approved order; proposed: a run's order
    # waiting at its priority stop; discarded: sent back or replaced (C8).
    status: SnapshotStatus = "saved"
    run_id: uuid.UUID | None = None
    document: SnapshotDocument | None = None
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None


class PriorityProblem(BaseModel):
    """One problem of a run's priority.yaml (oracle.priorities.run_order). A blocking one
    refuses Approve until the order is sent back (call c3)."""

    code: str
    blocking: bool = True
    feature: str | None = None
    message: str


class PriorityOrderRow(BaseModel):
    key: str
    rank: int
    score: float | None = None
    explanation: str | None = None
    live_rank: int | None = None


class PriorityCheck(BaseModel):
    """The check of a run's priority.yaml (C8): the file's method, the features ranked,
    every problem, and the order as the file gives it."""

    method: Method | None = None
    features: int
    problems: list[PriorityProblem]
    order: list[PriorityOrderRow] = []


class PrioritySnapshotOut(PrioritySnapshotSummary):
    params: dict[str, Any]
    ranking: list[RankedFeature]
    checkpoint_id: uuid.UUID | None = None
    scope_id: uuid.UUID | None = None
    check_result: PriorityCheck | None = None


class CompareRow(BaseModel):
    key: str
    title: str
    run_rank: int
    # The live ranking's rank, restricted to the features the run ranks; None: not in it.
    live_rank: int | None
    # live_rank - run_rank: positive, the run ranks it higher than the live ranking does.
    delta: int | None
    run_explanation: str | None
    live_explanation: str | None
    problems: list[PriorityProblem]


class CompareRun(BaseModel):
    id: uuid.UUID
    flow_title: str
    status: str
    document_slug: str | None = None


class CompareCheckpoint(BaseModel):
    id: uuid.UUID
    status: str
    approver_role: str
    # Why Approve is refused now (the checkpoint's own reason, as the run page shows it).
    cannot_approve: str | None = None
    can_decide: bool = False


class CompareOut(BaseModel):
    """A snapshot (a run's order) next to Oracle's live ranking of the same method."""

    snapshot: PrioritySnapshotOut
    rows: list[CompareRow]
    live_generated_at: datetime
    run: CompareRun | None = None
    checkpoint: CompareCheckpoint | None = None


# --- overrides (C9 Move and pin) ---------------------------------------------------------


class OverrideCreate(BaseModel):
    feature_id: uuid.UUID
    kind: OverrideKind
    # A move: directly above this feature.
    above_feature_id: uuid.UUID | None = None
    # A pin: at this rank (1 is the top).
    position: int | None = Field(default=None, ge=1)
    reason: str = Field(min_length=1, max_length=500)
    # Evidence of the feature the person cites, at most 5.
    evidence_ids: list[uuid.UUID] = Field(default_factory=list, max_length=5)
    # Null: the live ranking; else a proposed run snapshot (pick C8 Priority order snapshot).
    snapshot_id: uuid.UUID | None = None
    # True: keep the change after Oracle's pushback (no second check).
    confirm: bool = False

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("a reason is required")
        return v

    @model_validator(mode="after")
    def _target(self) -> "OverrideCreate":
        if self.kind == "move":
            if self.above_feature_id is None or self.position is not None:
                raise ValueError("a move needs above_feature_id and no position")
            if self.above_feature_id == self.feature_id:
                raise ValueError("a feature cannot move above itself")
        elif self.position is None or self.above_feature_id is not None:
            raise ValueError("a pin needs position and no above_feature_id")
        return self


class OverrideRemove(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class EvidenceChip(BaseModel):
    """A piece of evidence as a citation chip shows it."""

    id: str
    title: str
    source_kind: str
    confidence: float | None = None
    date: str | None = None


class PushbackMessage(BaseModel):
    # no_confirmed_goal, low_confidence, against_score, open_blocker (the rules), or
    # reason_contradicts_evidence (Oracle's reading of the reason).
    code: str
    message: str
    # The numbers behind a rule message.
    numbers: dict[str, Any] | None = None
    # Oracle's reading of the reason: the claim it read and the evidence it rests on.
    claim: str | None = None
    evidence: list[EvidenceChip] | None = None


class ReasonCheckOut(BaseModel):
    status: ReasonCheckStatus
    ms: int | None = None


class PushbackOut(BaseModel):
    """409: Oracle disagrees. Nothing is stored; ``confirm: true`` keeps the change."""

    detail: str
    pushback: list[PushbackMessage]
    reason_check: ReasonCheckOut
    # Where the feature would rank, and the prerequisite holding it, if any.
    preview_rank: int | None
    held_below: str | None


class FeatureRef(BaseModel):
    id: uuid.UUID
    key: str
    title: str


class PersonRef(BaseModel):
    id: uuid.UUID
    name: str


class OverrideOut(BaseModel):
    id: uuid.UUID
    feature: FeatureRef
    kind: OverrideKind
    above: FeatureRef | None
    position: int | None
    reason: str
    evidence_ids: list[uuid.UUID]
    # The cited evidence, as chips.
    evidence: list[EvidenceChip] = Field(default_factory=list)
    pushback: list[PushbackMessage]
    kept_after_pushback: bool
    reason_check: ReasonCheckOut
    snapshot_id: uuid.UUID | None
    created_by: PersonRef
    created_at: datetime
    removed_at: datetime | None
    removed_by: PersonRef | None
    removed_reason: str | None
    replaced_by: uuid.UUID | None
    # Active, but its feature or anchor is no longer ranked (rejected): it does nothing.
    no_longer_applies: bool = False
    # On create: where the feature ranks now, and the prerequisite holding it, if any.
    preview_rank: int | None = None
    held_below: str | None = None
