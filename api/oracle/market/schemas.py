"""H7 Competitive digest's API shapes (``/v1/competitors``, ``/v1/competitor-pages``,
``/v1/competitor-changes``, ``/v1/competitor-web-findings``, ``/v1/positioning``)."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Kind = Literal["direct", "indirect", "status_quo"]
Label = Literal["pricing", "changelog", "product", "docs", "blog", "other"]
PageStatus = Literal["active", "paused", "blocked", "error"]
Rating = Literal["minor", "notable", "major"]
Origin = Literal["page", "web"]
FindingKind = Literal["news", "review", "launch", "pricing", "other"]
FindingStatus = Literal["open", "promoted", "dismissed"]
Field_ = Literal[
    "alternatives",
    "unique_attributes",
    "value_and_proof",
    "best_fit_customers",
    "market_category",
    "trends",
]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CompetitorCreate(_In):
    name: str = Field(min_length=1, max_length=120)
    kind: Kind
    website: str | None = Field(None, max_length=500)
    description: str | None = Field(None, max_length=2000)
    aliases: list[str] = Field(default_factory=list)


class CompetitorPatch(_In):
    lock_version: int
    name: str | None = Field(None, min_length=1, max_length=120)
    kind: Kind | None = None
    website: str | None = Field(None, max_length=500)
    description: str | None = Field(None, max_length=2000)
    aliases: list[str] | None = None


class CompetitorOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: Kind
    website: str | None
    aliases: list[str]
    description: str | None
    status: Literal["active", "archived"]
    pages: int
    last_change_on: date | None
    changes_this_month: int
    open_web_findings: int
    # "Not read for 3 weeks" when one of its pages failed three weeks running.
    watch_problem: str | None = None
    lock_version: int


class PageIn(_In):
    url: str = Field(min_length=1, max_length=2000)
    label: Label


class PagePatch(_In):
    label: Label | None = None
    status: Literal["active", "paused"] | None = None


class PageOut(BaseModel):
    id: uuid.UUID
    competitor_id: uuid.UUID
    url: str
    host: str
    label: Label
    status: PageStatus
    last_checked_at: datetime | None
    last_changed_at: datetime | None
    attempts: int
    last_error: str | None


class DiffLine(BaseModel):
    op: Literal["+", "-"]
    text: str


class ChangeOut(BaseModel):
    id: uuid.UUID
    competitor_id: uuid.UUID
    competitor_name: str
    origin: Origin
    page_label: Label | None
    page_url: str | None
    web_host: str | None = None
    detected_at: datetime
    added_lines: int
    removed_lines: int
    rating: Rating
    rated_by: Literal["rule", "oracle", "person"]
    summary: str | None
    web_finding_id: uuid.UUID | None


class WebFindingOut(BaseModel):
    id: uuid.UUID
    competitor_id: uuid.UUID
    competitor_name: str
    kind: FindingKind
    title: str
    summary: str
    excerpt: str
    url: str
    host: str
    published_on: date | None
    found_on: date
    status: FindingStatus
    vetted: bool
    occurrence_id: uuid.UUID | None
    dismiss_reason: str | None = None


class ChangeDetail(ChangeOut):
    diff: list[DiffLine]
    web_finding: WebFindingOut | None = None


class CompetitorDetail(CompetitorOut):
    page_list: list[PageOut]
    changes: list[ChangeOut]
    web_findings: list[WebFindingOut]


class PromoteIn(_In):
    rating: Rating | None = None


class FindingDismissIn(_In):
    reason: str | None = Field(None, max_length=500)


class Item(BaseModel):
    id: str
    text: str


class ItemIn(_In):
    id: str | None = Field(None, max_length=60)
    text: str


class PositioningFields(BaseModel):
    alternatives: list[Item] = Field(default_factory=list)
    unique_attributes: list[Item] = Field(default_factory=list)
    value_and_proof: list[Item] = Field(default_factory=list)
    best_fit_customers: list[Item] = Field(default_factory=list)
    market_category: list[Item] = Field(default_factory=list)
    trends: list[Item] = Field(default_factory=list)


class PositioningFieldsIn(_In):
    alternatives: list[ItemIn] = Field(default_factory=list)
    unique_attributes: list[ItemIn] = Field(default_factory=list)
    value_and_proof: list[ItemIn] = Field(default_factory=list)
    best_fit_customers: list[ItemIn] = Field(default_factory=list)
    market_category: list[ItemIn] = Field(default_factory=list)
    trends: list[ItemIn] = Field(default_factory=list)


class PositioningIn(_In):
    fields: PositioningFieldsIn
    lock_version: int


class SuggestionRef(BaseModel):
    kind: Literal["change", "web", "request", "source_item"]
    id: str
    title: str | None = None
    vetted: bool | None = None


class PositioningSuggestionOut(BaseModel):
    id: uuid.UUID
    field: Field_
    action: Literal["add", "replace", "remove"]
    item_id: str | None
    text: str | None
    rationale: str
    refs: list[SuggestionRef]
    occurrence_id: uuid.UUID | None


class PositioningOut(BaseModel):
    fields: PositioningFields
    suggestions: list[PositioningSuggestionOut]
    updated_by_name: str | None
    updated_at: datetime | None
    lock_version: int
