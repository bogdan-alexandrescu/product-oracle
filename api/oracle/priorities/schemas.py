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


class SnapshotCreate(BaseModel):
    method: Method = "goal_weighted"
    note: str | None = Field(default=None, max_length=500)


class SnapshotSummary(BaseModel):
    id: uuid.UUID
    method: Method
    created_by: uuid.UUID | None
    created_at: datetime
    note: str | None
    feature_count: int
    top: list[str]


class SnapshotOut(SnapshotSummary):
    params: dict[str, Any]
    ranking: list[RankedFeature]
