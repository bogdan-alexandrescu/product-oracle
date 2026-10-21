import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

FindingKind = Literal[
    "goal_without_strategy",
    "focus_without_goal",
    "outside_strategy",
    "stopped_but_planned",
    "strategy_review_due",
    "vision_review_due",
    "no_strategy",
]
Severity = Literal["info", "warning", "high"]
SubjectKind = Literal["entity", "roadmap_item", "document"]
FindingStatus = Literal["open", "resolved", "waived"]


class StrategyFindingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: FindingKind
    severity: Severity
    subject_kind: SubjectKind
    subject_id: uuid.UUID | None
    # "goal:activation", a roadmap item key, a document slug.
    subject_ref: str
    strategy_version_id: uuid.UUID | None
    # Rule facts: the item's roadmap and horizon, the stop choice, the due date.
    detail: dict[str, Any]
    status: FindingStatus
    waived_by: uuid.UUID | None
    waived_at: datetime | None
    waive_reason: str | None
    first_seen_at: datetime
    last_seen_at: datetime
    resolved_at: datetime | None


class WaiveIn(BaseModel):
    reason: str = Field(max_length=2000)

    @field_validator("reason")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("a waiver needs a reason")
        return value


class CheckOut(BaseModel):
    opened: int
    resolved: int


class StackDocument(BaseModel):
    slug: str
    title: str
    version: int
    approved_at: datetime | None


class StackBelief(BaseModel):
    id: str
    statement: str
    status: Literal["supported", "untested", "strained"]
    # Evidence attached to the belief's assumption entity.
    evidence: int


class StackVision(BaseModel):
    document: StackDocument
    headline: str | None
    horizon_years: int | None = None
    beliefs: list[StackBelief]
    review_on: date


class StackNode(BaseModel):
    id: uuid.UUID
    key: str
    title: str


class StackChoice(BaseModel):
    entity_id: uuid.UUID
    id: str
    title: str
    stance: Literal["focus", "stop"]
    # Focus: the confirmed goals derived from it. Stop: none.
    goals: list[StackNode]
    # Stop: the features it covers. Focus: none.
    features: list[StackNode]
    # Focus: roadmap items under it. Stop: items still planned in Now or Next.
    items: int
    open_findings: int


class StackStrategy(BaseModel):
    document: StackDocument
    summary: str | None
    review_on: date
    choices: list[StackChoice]


class UnalignedItem(BaseModel):
    roadmap_item_id: uuid.UUID
    title: str
    # An item of a per-draft roadmap (E1), not an approved one.
    draft: bool


class Unaligned(BaseModel):
    goals: list[StackNode] = []
    items: list[UnalignedItem] = []


class StackCounts(BaseModel):
    open: int
    high: int
    waived: int


class StrategyStackOut(BaseModel):
    """The approved vision and strategy, the choices with their goals and items, and what
    is not under the strategy."""

    vision: StackVision | None
    strategy: StackStrategy | None
    unaligned: Unaligned
    counts: StackCounts
