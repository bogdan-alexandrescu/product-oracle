"""Roadmap alignment and product track schemas (CR-11, V2b)."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.v2.schemas import Freshness

Horizon = Literal["now", "next", "later"]
TrackStatus = Literal["active", "paused", "closed"]
TrackHealth = Literal["on_track", "at_risk", "off_track", "no_roadmap", "paused", "closed"]
MilestoneStatus = Literal["planned", "done", "dropped"]
BasisKind = Literal["estimate", "capacity", "commitment"]
BasisStatus = Literal["verified", "withdrawn"]
Tracker = Literal["linear", "jira", "github", "other"]
TrackerState = Literal["todo", "in_progress", "done", "cancelled", "unknown"]
ItemView = Literal["brief", "full"]
DriftKind = Literal["ahead", "date_slip", "overdue", "cancelled", "unplanned"]
RiskKind = Literal["blocked", "stale", "slipping"]
Alignment = Literal["aligned", "drift", "untracked", "done"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class DocumentRef(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    version: int | None = None
    approved: bool | None = None


# --- schedule bases ------------------------------------------------------------------------


class ScheduleBasisCreate(BaseModel):
    """A verified estimate, capacity figure or commitment. Recording it is the
    verification: the approver says this source supports this date."""

    model_config = ConfigDict(extra="forbid")

    kind: BasisKind
    reference: str = Field(min_length=1, max_length=200, pattern=r"\S")
    supports_date: date
    detail: str | None = Field(None, max_length=2000)
    # Limit it to one PRD's roadmaps (slug or id); omitted: any.
    prd: str | None = None
    tracker_record_id: uuid.UUID | None = None


class ScheduleBasisWithdraw(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=2000)


class ScheduleBasisOut(ORM):
    id: uuid.UUID
    kind: BasisKind
    reference: str
    supports_date: date
    detail: str | None
    prd_document_id: uuid.UUID | None
    tracker_record_id: uuid.UUID | None
    status: BasisStatus
    verified_by: uuid.UUID | None
    verified_at: datetime
    withdrawn_by: uuid.UUID | None
    withdrawn_at: datetime | None
    created_at: datetime


class WithdrawOut(BaseModel):
    basis: ScheduleBasisOut
    # Milestones that lost the date this basis alone supported.
    undated_milestones: list[uuid.UUID]
    # Roadmap items whose date rested on it, now potentially stale.
    stale_items: list[uuid.UUID]


# --- roadmap items -------------------------------------------------------------------------


class ItemsImport(BaseModel):
    """``roadmap_items.yaml`` for a roadmap version (the format the run writes)."""

    model_config = ConfigDict(extra="forbid")

    yaml: str = Field(min_length=1, max_length=500_000)


class ItemProblem(BaseModel):
    code: str
    message: str
    item: str | None = None


class TraceLink(BaseModel):
    target: Literal["feature", "requirement", "blocker"]
    id: uuid.UUID | None = None
    key: str
    via: Literal["declared", "section_link", "key_match", "graph"] | None = None
    unresolved: bool = False


class EntityRef(BaseModel):
    id: uuid.UUID
    type: str
    key: str
    title: str
    status: str


class BlockerDependency(EntityRef):
    # The blocker strategy's fields (oracle.blockers), when the constraint has one.
    blocker_status: str
    severity: str | None = None
    blocker_type: str | None = None
    resolved: bool
    critical: bool


class TrackerRecordRef(BaseModel):
    tracker: Tracker
    external_ref: str
    state: TrackerState
    raw_status: str | None = None
    target_date: date | None = None
    estimate: Decimal | None = None
    url: str | None = None


class DriftEntry(BaseModel):
    kind: DriftKind
    detail: str
    item_key: str | None = None
    tracker_ref: str | None = None


class PrdAnchor(BaseModel):
    document: DocumentRef | None
    section_key: str | None
    section_hash: str | None
    # /documents/<slug>/v/<n>#<section>: opens the PRD at that section.
    link: str | None


class RoadmapItemOut(BaseModel):
    id: uuid.UUID
    item_key: str
    position: int
    title: str
    outcome: str | None
    horizon: Horizon
    milestone: dict[str, Any] | None
    freshness: Freshness
    stale_reasons: list[str]
    stale_since: datetime | None
    caused_by_change_id: uuid.UUID | None
    prd: PrdAnchor
    track_id: uuid.UUID | None
    # Full view only (empty in the brief view).
    feature: EntityRef | None = None
    requirements: list[EntityRef] = []
    blockers: list[BlockerDependency] = []
    trace: list[TraceLink] = []
    depends_on: list[str] = []
    validation_gates: list[dict[str, Any]] = []
    economics: dict[str, Any] = {}
    priority: dict[str, Any] | None = None
    confidence: str | None = None
    engineering: list[TrackerRecordRef] = []
    note: str | None = None


class RoadmapItemsOut(BaseModel):
    roadmap: DocumentRef
    source: DocumentRef | None
    track_id: uuid.UUID | None
    view: ItemView
    items: list[RoadmapItemOut]


class ItemsImportOut(RoadmapItemsOut):
    problems: list[ItemProblem]
    # Items whose milestone date was refused (no verified basis supports it).
    refused_dates: list[str]


class ItemStalenessAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["review", "reconcile"]
    # The roadmap version; omitted: the latest version with items.
    version: int | None = Field(None, ge=1)
    item_keys: list[str] = Field(default_factory=list, max_length=500)
    reason: str | None = Field(None, max_length=2000)


class ItemStalenessOut(BaseModel):
    changed: list[dict[str, Any]]
    items: list[RoadmapItemOut]


# --- tracker (read-only, E1) -----------------------------------------------------------------


class TrackerRecordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    external_ref: str = Field(min_length=1, max_length=200)
    title: str | None = Field(None, max_length=500)
    url: str | None = Field(None, max_length=2000, pattern=r"^https?://")
    state: TrackerState
    raw_status: str | None = Field(None, max_length=200)
    estimate: Decimal | None = Field(None, ge=0, le=Decimal("99999999"))
    estimate_unit: str | None = Field(None, max_length=50)
    target_date: date | None = None
    observed_at: datetime | None = None
    track_id: uuid.UUID | None = None
    item_key: str | None = Field(None, max_length=200)


class TrackerRecordsImport(BaseModel):
    """Engineering status as read from a tracker (an export, the CLI, an agent with read
    access). Oracle stores it; it never writes back."""

    model_config = ConfigDict(extra="forbid")

    tracker: Tracker
    records: list[TrackerRecordIn] = Field(min_length=1, max_length=500)


class TrackerRecordOut(ORM):
    id: uuid.UUID
    tracker: Tracker
    external_ref: str
    title: str | None
    url: str | None
    track_id: uuid.UUID | None
    item_key: str | None
    state: TrackerState
    raw_status: str | None
    estimate: Decimal | None
    estimate_unit: str | None
    target_date: date | None
    observed_at: datetime
    recorded_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class TrackerImportOut(BaseModel):
    created: int
    updated: int
    records: list[TrackerRecordOut]


class TrackerConnectorOut(BaseModel):
    """The two-way tracker connector's gate (E1, §11.1): off unless verified."""

    two_way_enabled: bool
    writes_allowed: bool
    read_only_alignment: bool
    reason: str


class TrackerPlanIssue(BaseModel):
    title: str
    requirement_key: str | None = None


class TrackerPlanEpic(BaseModel):
    item_key: str
    title: str
    horizon: Horizon
    description: str | None
    prd_link: str | None
    issues: list[TrackerPlanIssue]


class TrackerPlanOut(BaseModel):
    """What a two-way connector would create: a preview only, never written."""

    track_id: uuid.UUID
    would_write: Literal[False] = False
    connector: TrackerConnectorOut
    epics: list[TrackerPlanEpic]


class AlignmentItem(BaseModel):
    item_key: str
    title: str
    horizon: Horizon
    milestone: dict[str, Any] | None
    alignment: Alignment
    tracker: list[TrackerRecordRef]
    drift: list[DriftEntry]


class AlignmentReport(BaseModel):
    """The roadmap against the tracker's state, read-only: the path that works without
    tracker write permission (E1)."""

    mode: Literal["read_only"] = "read_only"
    generated_at: datetime
    roadmap: DocumentRef
    track_id: uuid.UUID | None
    connector: TrackerConnectorOut
    counts: dict[str, int]
    items: list[AlignmentItem]
    # Tracker work linked to the track that no roadmap item names.
    unplanned: list[DriftEntry]


# --- tracks and milestones -------------------------------------------------------------------


class TrackCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The PRD (slug or id); it needs an approved version.
    prd: str = Field(min_length=1)
    title: str | None = Field(None, min_length=1, max_length=300)


class TrackPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_version: int
    title: str | None = Field(None, min_length=1, max_length=300)
    status: TrackStatus | None = None
    owner_id: uuid.UUID | None = None


class MilestoneCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    horizon: Horizon = "now"
    target_date: date | None = None
    basis_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    item_keys: list[str] = Field(default_factory=list, max_length=200)


class MilestonePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_version: int
    name: str | None = Field(None, min_length=1, max_length=200)
    horizon: Horizon | None = None
    # Explicit null clears the date.
    target_date: date | None = None
    basis_ids: list[uuid.UUID] | None = Field(None, max_length=20)
    item_keys: list[str] | None = Field(None, max_length=200)
    status: MilestoneStatus | None = None


class MilestoneOut(ORM):
    id: uuid.UUID
    track_id: uuid.UUID
    name: str
    horizon: Horizon
    target_date: date | None
    basis_ids: list[uuid.UUID]
    item_keys: list[str]
    status: MilestoneStatus
    lock_version: int
    created_at: datetime
    updated_at: datetime


class NextMilestone(BaseModel):
    name: str
    horizon: Horizon
    target_date: date | None
    dated: bool
    bases: list[dict[str, Any]]
    items: int
    milestone_id: uuid.UUID | None = None


class AtRiskItem(BaseModel):
    item_key: str
    title: str
    horizon: Horizon
    reasons: list[dict[str, str]]


class TrackOut(BaseModel):
    id: uuid.UUID
    title: str
    status: TrackStatus
    owner_id: uuid.UUID | None
    prd: DocumentRef
    started_version: int | None
    current_version: int | None
    latest_approved_version: int | None
    roadmap: DocumentRef | None
    lock_version: int
    created_at: datetime
    monitored_at: datetime | None


class TrackSummary(TrackOut):
    health: TrackHealth
    headline: str


class TrackOverview(TrackSummary):
    """One calm overview per track: health, the next milestone, what needs attention."""

    counts: dict[str, int]
    next_milestone: NextMilestone | None
    at_risk: list[AtRiskItem]
    drift: list[DriftEntry]
    # Engineering status is known for some items (tracker records read back).
    engineering_known: bool
    # A later approved PRD version than the roadmap was built from.
    prd_moved: bool
    milestones: list[MilestoneOut]


class MonitorOut(BaseModel):
    overview: TrackOverview
    # The change event recorded when the track's health or risks changed; null: none.
    change_event_id: uuid.UUID | None
    changed: list[str]


class TrackChange(BaseModel):
    id: uuid.UUID
    cause: str
    actor: str
    data: dict[str, Any]
    created_at: datetime
