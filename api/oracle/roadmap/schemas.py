"""Roadmap alignment and product track schemas (CR-11, V2b)."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from oracle.v2.schemas import Freshness

Horizon = Literal["now", "next", "later"]
TrackStatus = Literal["active", "paused", "closed"]
TrackHealth = Literal["on_track", "at_risk", "off_track", "no_roadmap", "paused", "closed"]
MilestoneStatus = Literal["planned", "done", "dropped"]
BasisKind = Literal["estimate", "capacity", "commitment"]
BasisStatus = Literal["verified", "proposed", "withdrawn", "rejected"]
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
    """An estimate, capacity figure or commitment supporting a date for this PRD's roadmap
    items (O4). The recorder's rights decide its status (F3): an engineering lead or an
    owner (an approver while no lead is named) verifies it by recording it; an approver's
    waits as proposed for a lead."""

    model_config = ConfigDict(extra="forbid")

    kind: BasisKind
    reference: str = Field(min_length=1, max_length=200, pattern=r"\S")
    supports_date: date
    detail: str | None = Field(None, max_length=2000)
    # The PRD (slug or id) whose roadmap items it supports: required.
    prd: str = Field(min_length=1, max_length=200)
    # Optionally only one item of that PRD's roadmap, or only the items one tracker
    # issue is matched to (its tracker records' item_key); not both.
    item_key: str | None = Field(None, min_length=1, max_length=200, pattern=r"\S")
    tracker_key: str | None = Field(None, min_length=1, max_length=200, pattern=r"\S")
    tracker_record_id: uuid.UUID | None = None
    note: str | None = Field(None, max_length=2000)

    @model_validator(mode="after")
    def _one_key(self) -> "ScheduleBasisCreate":
        if self.item_key is not None and self.tracker_key is not None:
            raise ValueError("name an item_key or a tracker_key, not both")
        return self


class ScheduleBasisWithdraw(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=2000)


class ScheduleBasisVerify(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: str | None = Field(None, max_length=2000)


class ScheduleBasisReject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=2000, pattern=r"\S")


class ScheduleBasisOut(ORM):
    id: uuid.UUID
    kind: BasisKind
    reference: str
    supports_date: date
    detail: str | None
    prd_document_id: uuid.UUID
    item_key: str | None
    tracker_key: str | None
    tracker_record_id: uuid.UUID | None
    status: BasisStatus
    note: str | None = None
    proposed_by: uuid.UUID | None = None
    proposed_at: datetime | None = None
    verified_by: uuid.UUID | None
    verified_at: datetime | None
    withdrawn_by: uuid.UUID | None
    withdrawn_at: datetime | None
    withdrawn_reason: str | None = None
    rejected_by: uuid.UUID | None = None
    rejected_at: datetime | None = None
    rejected_reason: str | None = None
    created_at: datetime


class InboxDateBasis(ScheduleBasisOut):
    """A proposed basis in the Inbox of those who verify it (F3), with its PRD."""

    prd: DocumentRef


class ImpactMilestone(BaseModel):
    id: uuid.UUID
    track_id: uuid.UUID
    name: str
    target_date: date | None
    # Whether another verified basis still supports its date.
    keeps_date: bool


class ImpactItem(BaseModel):
    id: uuid.UUID
    roadmap: str
    version: int
    item_key: str


class ImpactDocument(BaseModel):
    slug: str
    version: int
    # Places that will show "date withdrawn".
    marks: int


class DateRightsOut(BaseModel):
    rights: Literal["verify", "propose"] | None
    lead_named: bool


class BasisImpactOut(BaseModel):
    """What withdrawing a basis would change (F3), computed as the withdrawal would."""

    basis_id: uuid.UUID
    milestones: list[ImpactMilestone]
    items: list[ImpactItem]
    documents: list[ImpactDocument]


class WithdrawOut(BaseModel):
    basis: ScheduleBasisOut
    # Milestones that lost the date this basis alone supported.
    undated_milestones: list[uuid.UUID]
    # Roadmap items whose date rested on it: potentially stale, and read without the date.
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
    # The tracker record (Unlink names it: DELETE /v1/tracker/links/{id}); null on a
    # preview that is no stored record.
    id: uuid.UUID | None = None
    tracker: Tracker
    external_ref: str
    state: TrackerState
    raw_status: str | None = None
    target_date: date | None = None
    estimate: Decimal | None = None
    url: str | None = None
    # When the synced issue it is refreshed from went away (F7): it shows as last read.
    refresh_lost_at: datetime | None = None


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
    # The approved PRD version (and section hash) a person reconciled the item against;
    # staleness compares with it once set. The fields above stay as the item was built.
    reconciled_version: int | None = None
    reconciled_section_hash: str | None = None


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


# E1 Roadmap per PRD draft. "none": the version has no derivation (imported before E1).
DraftRoadmapStatus = Literal[
    "queued", "running", "ready", "failed", "superseded", "off", "skipped", "none"
]


class DraftRoadmapSummary(BaseModel):
    """A PRD version's derivation on its version read (the Roadmap tab's label)."""

    status: DraftRoadmapStatus
    items: int
    problems: int


class DraftRoadmapPrd(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    version: int
    approved: bool


class DraftRoadmapPrevious(BaseModel):
    """The nearest earlier version of the PRD with ready items."""

    version: int
    status: DraftRoadmapStatus
    items: int


class DraftRoadmapOut(BaseModel):
    """A PRD version's items-only roadmap: its derivation's status and its items. Items
    have no track, are always fresh and carry no engineering records."""

    prd: DraftRoadmapPrd
    status: DraftRoadmapStatus
    run_id: uuid.UUID | None
    requested_at: datetime | None
    ready_at: datetime | None
    error: str | None
    # {"items", "by_horizon", "problems"} as the run's items check returned it.
    check: dict[str, Any] | None
    previous: DraftRoadmapPrevious | None
    # The PRD's "Derive for each new draft" switch.
    auto: bool
    view: ItemView
    items: list[RoadmapItemOut]


class DeriveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    depth: Literal["quick", "standard", "deep"] = "standard"


class DraftRoadmapSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    each_draft: bool


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
    """Engineering status as read from a tracker, posted by an approver (an export, the
    CLI, an MCP client acting for them; not a run's token). Oracle stores it; it never
    writes back."""

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
    prd_document_id: uuid.UUID | None = None
    source_item_id: uuid.UUID | None = None
    linked_by: uuid.UUID | None = None
    linked_at: datetime | None = None
    refresh_lost_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class TrackerIssueMilestone(BaseModel):
    title: str
    due: date | None = None


class TrackerIssueLinked(BaseModel):
    prd: str | None
    item_key: str
    record_id: uuid.UUID
    item_title: str | None = None


class TrackerIssueOut(BaseModel):
    """One of the caller's own synced GitHub issues, as a link would read it (F7)."""

    source_item_id: uuid.UUID
    external_ref: str
    title: str | None
    url: str | None
    state: TrackerState
    raw_status: str | None
    milestone: TrackerIssueMilestone | None
    linked: TrackerIssueLinked | None


class TrackerLinkIn(BaseModel):
    """Link one of the caller's synced GitHub issues to a roadmap item of a PRD, by its
    source item or its issue URL. ``move``: take it from the item it is linked to."""

    model_config = ConfigDict(extra="forbid")

    prd: str = Field(min_length=1, max_length=200)
    item_key: str = Field(min_length=1, max_length=200)
    source_item_id: uuid.UUID | None = None
    url: str | None = Field(None, max_length=2000)
    move: bool = False

    @model_validator(mode="after")
    def _one_issue(self) -> "TrackerLinkIn":
        if (self.source_item_id is None) == (self.url is None):
            raise ValueError("name the issue by source_item_id or url, not both")
        return self


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


# --- change sets: edits to the approved plan, proposed as a new version (#346) --------------

ChangeSetStatus = Literal["draft", "proposed", "discarded", "superseded"]
ItemKey = Annotated[str, Field(min_length=1, max_length=120)]


class AddChange(BaseModel):
    """Add an item: a Baseline feature (``feature_id``) or a new one (``title``)."""

    op: Literal["add"]
    title: str = Field(min_length=1, max_length=200)
    horizon: Horizon
    feature_id: uuid.UUID | None = None
    outcome: str | None = Field(default=None, max_length=1000)
    # Set by Oracle when the change is stored: the feature's key, else from the title.
    key: ItemKey | None = None


class MoveChange(BaseModel):
    """Move an item to another horizon (to the end of it)."""

    op: Literal["move"]
    key: ItemKey
    horizon: Horizon


class DeferChange(BaseModel):
    """Defer an item: it moves to Later."""

    op: Literal["defer"]
    key: ItemKey


class CutChange(BaseModel):
    """Cut an item from the plan, with the reason."""

    op: Literal["cut"]
    key: ItemKey
    reason: str = Field(min_length=1, max_length=500)


class ReorderChange(BaseModel):
    """Put an item at ``position`` (0 first) within its horizon."""

    op: Literal["reorder"]
    key: ItemKey
    position: int = Field(ge=0, le=500)


PlanChange = Annotated[
    AddChange | MoveChange | DeferChange | CutChange | ReorderChange, Field(discriminator="op")
]


class ChangeSetPatch(BaseModel):
    """The change set's changes, whole, in order, and the lock_version last read."""

    changes: list[PlanChange] = Field(max_length=200)
    lock_version: int


class PlannedItem(BaseModel):
    key: str
    title: str
    horizon: Horizon
    position: int
    outcome: str | None = None
    feature_id: uuid.UUID | None = None
    new: bool = False
    deferred: bool = False


class CutItem(BaseModel):
    key: str
    title: str
    horizon: Horizon
    reason: str


class ChangeSetDiffItem(BaseModel):
    """How an item of the proposal differs from the approved version (roadmap.diff)."""

    key: str
    title: str
    status: Literal["added", "dropped", "moved", "changed", "unchanged"]
    from_horizon: Horizon | None = None
    to_horizon: Horizon | None = None
    fields: list[str] = []
    # Its place within its horizon changed (a reorder).
    reordered: bool = False
    reason: str | None = None


class ChangeSetOut(BaseModel):
    id: uuid.UUID
    roadmap: str
    roadmap_title: str
    base_version: int
    status: ChangeSetStatus
    changes: list[PlanChange]
    items: list[PlannedItem]
    cut: list[CutItem]
    diff: list[ChangeSetDiffItem]
    summary: dict[str, int]
    proposed_version: int | None = None
    # The proposed version is approved: it is the live plan (or was).
    approved: bool = False
    # A later proposal superseded this one while it waited: its version can't be approved.
    superseded_by_version: int | None = None
    # Who approves the proposed version: the document's designated decider, when named.
    decider_id: uuid.UUID | None = None
    lock_version: int
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


# --- roadmap item diff (E3) ------------------------------------------------------------------

ItemsKind = Literal["prd_draft", "roadmap"]
RoadmapItemChangeKind = Literal["added", "dropped", "moved", "changed", "unchanged"]


class ItemsRef(BaseModel):
    """A set of items: ``<slug>@<n>``, a PRD version's draft items or a roadmap version's."""

    ref: str
    kind: ItemsKind
    # "Draft v2" or "Roadmap v3".
    label: str
    document: DocumentRef


class ItemsOption(BaseModel):
    ref: str
    label: str


class ItemsOptions(BaseModel):
    previous: ItemsOption | None
    approved: ItemsOption | None


class ItemFieldChange(BaseModel):
    # title | outcome | horizon | milestone_name | milestone_date | depends_on |
    # prd_section | rank | item_key; notes: confidence | rank | prd_section_text | date_state.
    field: str
    before: Any = None
    after: Any = None
    # depends_on only: the ids added and removed (left out on other fields).
    added: list[str] | None = Field(default=None, exclude_if=lambda v: v is None)
    removed: list[str] | None = Field(default=None, exclude_if=lambda v: v is None)


class RoadmapItemChange(BaseModel):
    item_key: str
    change: RoadmapItemChangeKind
    matched_by: Literal["key", "title"] | None
    title: str
    base_horizon: str | None
    head_horizon: str | None
    base_position: int | None
    head_position: int | None
    # What counts as a change (oracle.roadmap.diff.COUNTED_FIELDS); notes do not count.
    fields: list[ItemFieldChange]
    notes: list[ItemFieldChange]


class ItemsDiffOut(BaseModel):
    head: ItemsRef
    # None (with summary None and no items) when there is nothing to compare with.
    base: ItemsRef | None
    options: ItemsOptions
    summary: dict[str, int] | None
    items: list[RoadmapItemChange]


class RoadmapItemHistoryEntry(BaseModel):
    ref: str
    kind: ItemsKind
    label: str
    approved: bool
    at: datetime
    # False on the entry where the item left (change "dropped").
    present: bool
    title: str | None
    horizon: str | None
    milestone_name: str | None
    milestone_date: str | None
    # Against the previous entry.
    change: RoadmapItemChangeKind


class RoadmapItemHistoryOut(BaseModel):
    prd: DocumentRef
    item_key: str
    entries: list[RoadmapItemHistoryEntry]
