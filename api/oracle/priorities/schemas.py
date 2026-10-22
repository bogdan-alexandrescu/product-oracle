import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

Method = Literal["goal_weighted", "rice", "moscow", "wsjf"]


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


class RankedFeature(BaseModel):
    rank: int
    # Position by score alone, before dependency order.
    score_rank: int
    entity_id: str
    key: str
    title: str
    status: str
    score: float | None
    serves_goal: bool
    # no_confirmed_goal, missing_inputs, no_confidence, low_confidence,
    # dependency_cycle, moved_for_dependency
    flags: list[str]
    depends_on: list[str]
    dependents: list[str]
    explanation: Explanation
    # A run's order (C8): the live ranking's rank of this feature, restricted to the
    # features the run ranks, and the run's own explanation (priority.yaml).
    live_rank: int | None = None
    run_explanation: str | None = None


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
