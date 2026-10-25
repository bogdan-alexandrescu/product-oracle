"""The Plan screen's one read (F1, c7 Plan rename): goals' items, PRDs in play and the
roadmap rows, assembled from the roadmap module's numbers."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

from oracle.roadmap.schemas import EntityRef, Horizon, TrackerRecordRef, TrackHealth, TrackStatus

PlanScope = Literal["all", "approved"]
Stage = Literal[
    "idea", "drafting", "waiting", "draft", "in_review", "approved", "in_build", "paused", "closed"
]
ItemState = Literal["proposed", "done", "slipped", "at_risk", "on_track", "planned"]
Origin = Literal["approved", "draft"]
ChangeKind = Literal["new", "moved", "changed", "unchanged", "dropped"]
DateStatus = Literal["verified", "unverified", "withdrawn"]
NextAction = Literal[
    "review_prd",
    "verify_date",
    "reverify_date",
    "decide_slip",
    "resolve_blocker",
    "reconcile",
    "link_issue",
]
# Who decides: a role, or a named person in it (user_id). "track_owner": the track's
# owner; "engineering_lead": the company's engineering lead (A3), once one is named.
WhoRole = Literal["viewer", "commenter", "approver", "owner", "track_owner", "engineering_lead"]


class PlanCounts(BaseModel):
    prds: int
    at_risk: int
    proposed: int
    items: int


class PlanDocument(BaseModel):
    id: uuid.UUID
    slug: str
    title: str


class PlanRun(BaseModel):
    id: uuid.UUID
    status: str
    # The pending checkpoint's kind and the lowest role that may decide it.
    checkpoint: str | None = None
    checkpoint_role: str | None = None
    # The segment the run is at (its title).
    segment: str | None = None


class PlanTrack(BaseModel):
    id: uuid.UUID
    status: TrackStatus
    health: TrackHealth
    owner_id: uuid.UUID | None = None


class PlanPrd(BaseModel):
    document: PlanDocument
    stage: Stage
    stage_label: str
    # 1-based step of the nine-step journey (Idea ... Publish).
    journey_step: int
    latest_version: int | None
    approved_version: int | None
    run: PlanRun | None
    track: PlanTrack | None
    figure: str | None
    # The run waits at a checkpoint the viewer may decide.
    waiting_for_viewer: bool = False
    updated_at: datetime


class ItemChange(BaseModel):
    """How a draft item differs from its approved twin (roadmap.diff.diff_items)."""

    kind: ChangeKind
    from_horizon: Horizon | None = None
    to_horizon: Horizon | None = None
    # Counted fields that changed ("title", "outcome", "rank" ...), and notes only
    # ("confidence", a one-place rank shift).
    fields: list[str] = []
    notes: list[str] = []
    # For a dropped item: the draft that leaves it out.
    draft_version: int | None = None


class PlanItemPrd(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    version: int | None
    approved: bool
    # /documents/<slug>/v/<n>#<section>
    link: str | None


class PlanItemRoadmap(BaseModel):
    slug: str
    version: int
    # The item's heading anchor in the roadmap version: <horizon>-<key>.
    anchor: str


class PlanEngineering(BaseModel):
    records: list[TrackerRecordRef]
    # The item's milestone date: verified, or the refused one.
    date: date | None
    date_status: DateStatus | None
    # The bases the date rests on (verified) or lost (withdrawn), by schedule.supporting:
    # this PRD's, supporting exactly the date, covering the item and named in its source.
    basis_ids: list[uuid.UUID] = []
    # Days the latest tracker target runs past the milestone date (date_slip drift).
    slip_days: int | None
    tracked: bool


class PlanWho(BaseModel):
    role: WhoRole
    user_id: uuid.UUID | None = None


class PlanNext(BaseModel):
    action: NextAction | None
    label: str
    who: PlanWho | None
    # Where the decision is taken, when it is a page (the PRD draft, the blocker).
    href: str | None = None
    # The viewer's role is enough to take it there.
    viewer_may: bool = False


class PlanReason(BaseModel):
    kind: str
    detail: str


class PlanItem(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    outcome: str | None = None
    horizon: Horizon
    position: int
    origin: Origin
    change: ItemChange | None
    prd: PlanItemPrd | None
    roadmap: PlanItemRoadmap
    track_id: uuid.UUID | None
    goal_ids: list[uuid.UUID]
    # The item's trace (F5 lane 3: Request spec pre-ticks its requirements): its baseline
    # feature and requirements.
    feature: EntityRef | None = None
    requirements: list[EntityRef] = []
    state: ItemState
    reasons: list[PlanReason]
    engineering: PlanEngineering
    next: PlanNext


class PlanOut(BaseModel):
    scope: PlanScope
    generated_at: datetime
    counts: PlanCounts
    prds: list[PlanPrd]
    items: list[PlanItem]


class ItemVersion(BaseModel):
    version: int
    prd_version: int | None
    horizon: Horizon
    approved_at: datetime | None


class ItemHistoryOut(BaseModel):
    roadmap: str
    item: str
    versions: list[ItemVersion]
    # Tracker events for the item (F2 Track health stores them); empty until then.
    tracker_events: list[dict] = []
