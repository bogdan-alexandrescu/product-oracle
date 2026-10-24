"""Request and response bodies of the metrics API (H5)."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

Kind = Literal["output", "input"]
Direction = Literal["up", "down"]
Source = Literal["posthog", "manual", "api"]
Status = Literal["active", "paused", "error", "archived"]
VarianceStatus = Literal["open", "explained", "unknown", "noise"]

MAX_QUERY = 4000


class MetricCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=3, max_length=200)
    kind: Kind
    unit: str = Field(min_length=1, max_length=40)
    direction: Direction
    goal_id: uuid.UUID | None = None
    drives_metric_id: uuid.UUID | None = None
    owner_id: uuid.UUID
    source: Source
    query: str | None = Field(default=None, min_length=1, max_length=MAX_QUERY)
    threshold_pct: float | None = Field(default=None, ge=1, le=500)


class MetricPatch(BaseModel):
    lock_version: int
    title: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, min_length=3, max_length=200)
    unit: str | None = Field(default=None, min_length=1, max_length=40)
    direction: Direction | None = None
    goal_id: uuid.UUID | None = None
    drives_metric_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    query: str | None = Field(default=None, min_length=1, max_length=MAX_QUERY)
    threshold_pct: float | None = Field(default=None, ge=1, le=500)


class WeekValue(BaseModel):
    week_start: date
    value: float


class Change(BaseModel):
    value: float
    pct: float | None
    variance: Literal["better", "worse"] | None


class MetricOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str
    kind: Kind
    unit: str
    direction: Direction
    goal_id: uuid.UUID | None
    drives_metric_id: uuid.UUID | None
    owner_id: uuid.UUID
    owner_name: str | None
    source: Source
    query: str | None
    threshold_pct: float | None
    status: Status
    definition_version: int
    last_week: WeekValue | None
    change: Change | None
    # The last 12 weeks' values, oldest first (None: no value that week).
    spark: list[float | None]
    last_pulled_at: datetime | None
    last_error: str | None
    lock_version: int


class MetricValueOut(BaseModel):
    week_start: date
    value: float
    source: Source
    definition_version: int
    note: str | None
    recorded_by: uuid.UUID | None
    recorded_at: datetime


class Definition(BaseModel):
    version: int
    unit: str
    query: str | None
    at: datetime


class Band(BaseModel):
    low: float
    high: float


class PossibleCause(BaseModel):
    kind: Literal["launch", "changelog", "roadmap_item", "decision", "definition"]
    title: str
    on: date
    href: str


class VarianceOut(BaseModel):
    id: uuid.UUID
    metric_id: uuid.UUID
    metric_title: str
    owner_id: uuid.UUID
    week_start: date
    value: float
    previous: float
    change: float
    change_pct: float | None
    band: Band | None
    direction: Literal["better", "worse"]
    status: VarianceStatus
    explanation: str | None
    explained_by_name: str | None
    find_out_by: date | None
    noise_reason: str | None
    oracle_draft: str | None
    oracle_confidence: Literal["high", "medium", "low"] | None
    possible_causes: list[PossibleCause]
    lock_version: int


class MetricDetail(MetricOut):
    # Up to 52 weekly values, oldest first.
    values: list[MetricValueOut]
    variances: list[VarianceOut]
    definitions: list[Definition]


class ValueIn(BaseModel):
    value: float
    note: str | None = Field(default=None, max_length=500)


class QueryIn(BaseModel):
    query: str = Field(min_length=1, max_length=MAX_QUERY)


class MetricTestOut(BaseModel):
    # The last 4 complete weeks' values, oldest first; empty with ``error`` on a failure.
    values: list[WeekValue]
    error: str | None


class ExplainIn(BaseModel):
    explanation: str = Field(min_length=10, max_length=1000)
    lock_version: int | None = None


class UnknownIn(BaseModel):
    find_out_by: date
    lock_version: int | None = None


class NoiseIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)
    lock_version: int | None = None


class AnalyticsIn(BaseModel):
    provider: Literal["posthog"]
    # "us", "eu", or the company's own https address.
    host: str = Field(min_length=2, max_length=300)
    project_id: str = Field(min_length=1, max_length=40, pattern=r"^[0-9A-Za-z_-]+$")
    api_key: str = Field(min_length=8, max_length=300)


class AnalyticsOut(BaseModel):
    """The connection, never its key."""

    provider: Literal["posthog"]
    host: str | None
    project_id: str | None
    status: Literal["active", "error", "disconnected"]
    last_error: str | None
    connected_by_name: str | None
    connected_at: datetime | None
    # PostHog metrics not archived (Disconnect pauses them).
    metrics: int


class InboxMetric(BaseModel):
    """A metric row of the Inbox (H5): Explain a variance and Find out (the metric's
    owner; Find out from its find-out-by day), Metric not read for a day (owners).
    ``counts``: in needs_me and the badge. ``occurrence_id``: the weekly review that
    lists the variance, when one does."""

    variance_id: uuid.UUID | None = None
    metric_id: uuid.UUID
    metric_title: str
    reason: Literal["explain", "find_out", "pull_failed"]
    week_start: date
    due_on: date | None = None
    occurrence_id: uuid.UUID | None = None
    counts: bool
