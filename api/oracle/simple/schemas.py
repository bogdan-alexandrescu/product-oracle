"""Simple S2 (#723): the company-wide roadmap read and the date suggestions; S3a: the
change engine's sessions and changes; S3b: working drafts."""

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

DateSource = Literal["typed", "accepted", "engineering", "tracker", "estimated"]
RoadmapGroup = Literal["goal", "track", "prd"]
PhaseKey = Literal["discover", "build", "beta", "launch"]
FlagKind = Literal[
    "dependency_order",
    "blocker_date",
    "outside_milestone",
    "cut_with_dependents",
    "draft_without_owner",
]
FixKind = Literal["shift_dependents", "move_dependency", "accept_risk"]
ItemStatus = Literal["planned", "in_progress", "done", "cut", "draft"]
SuggestionStatus = Literal["open", "accepted", "edited", "dismissed"]


class SimpleDate(BaseModel):
    date: dt.date
    source: DateSource
    # Drawn hatched: the horizon's window (or a span backed off from a known date).
    estimated: bool


class SimpleWindow(BaseModel):
    start: dt.date
    end: dt.date


class SimpleWindows(BaseModel):
    now: SimpleWindow
    next: SimpleWindow
    later: SimpleWindow


class SimplePhase(BaseModel):
    key: PhaseKey
    start: dt.date
    end: dt.date
    estimated: bool


class SimpleFlag(BaseModel):
    kind: FlagKind
    # One line, in words.
    reason: str
    fixes: list[FixKind]
    # red: broken; amber: broken, and accepted as a risk (risk_note).
    state: Literal["red", "amber"]
    # What the flag is about: the dependency's item id, the blocker's id, the milestone's name.
    subject: str | None = None
    risk_note: str | None = None


class SimpleDocRef(BaseModel):
    id: uuid.UUID
    slug: str
    title: str


class SimpleGoalRef(BaseModel):
    id: uuid.UUID
    key: str
    title: str


class SimpleTrackRef(BaseModel):
    id: uuid.UUID
    title: str


class SimpleItemMilestone(BaseModel):
    name: str | None = None
    date: dt.date | None = None
    # item: the item's own milestone; track: a track milestone naming the item.
    source: Literal["item", "track"]


class DateSuggestionOut(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID
    item_key: str
    item_title: str
    start_date: dt.date
    end_date: dt.date
    # One sentence: why these dates.
    basis: str
    status: SuggestionStatus
    created_at: dt.datetime
    decided_by: uuid.UUID | None = None
    decided_at: dt.datetime | None = None
    # The caller may accept, edit or dismiss it: an owner, the roadmap's decider, or with
    # no decider the roadmap's track owner.
    can_decide: bool = False


class SimpleRoadmapItem(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    outcome: str | None = None
    horizon: Literal["now", "next", "later"]
    roadmap: SimpleDocRef
    prd: SimpleDocRef | None = None
    goal: SimpleGoalRef | None = None
    track: SimpleTrackRef | None = None
    confidence: str | None = None
    status: ItemStatus
    draft: bool = False
    start: SimpleDate
    end: SimpleDate
    # The bar's source (its end's, else its start's) and whether it is an estimate.
    source: DateSource
    estimated: bool
    suggestion: DateSuggestionOut | None = None
    milestone: SimpleItemMilestone | None = None
    phases: list[SimplePhase]
    # Item ids (of this read) the item depends on, and those that depend on it.
    depends_on: list[uuid.UUID]
    needed_by: list[uuid.UUID]
    flags: list[SimpleFlag]
    # Whether the caller applies changes to this item (service.can_decide), and the names of
    # who decides it (D-a: the decider, else the deciding track owner, else the owners).
    can_decide: bool = False
    deciders: list[str] = []


class SimpleGroup(BaseModel):
    # The goal's, track's or PRD's id; "none" for the items without one.
    key: str
    title: str
    item_ids: list[uuid.UUID]


class SimpleMilestone(BaseModel):
    id: uuid.UUID
    track_id: uuid.UUID
    name: str
    date: dt.date | None = None
    horizon: Literal["now", "next", "later"]
    status: Literal["planned", "done", "dropped"]
    item_ids: list[uuid.UUID]


class SimpleRoadmapOut(BaseModel):
    today: dt.date
    group: RoadmapGroup
    windows: SimpleWindows
    groups: list[SimpleGroup]
    items: list[SimpleRoadmapItem]
    milestones: list[SimpleMilestone]
    # S3b: changes waiting in working drafts and proposals of roadmaps whose drafts the
    # reader may not see (the banner's count, no details: they read the published version).
    changes_in_review: int = 0
    # S3b: the open drafts the reader sees (their items read as the draft has them).
    drafts: list["SimpleDraftBrief"] = []


class DateSuggestionEdit(BaseModel):
    start_date: dt.date
    end_date: dt.date

    @model_validator(mode="after")
    def _span(self) -> "DateSuggestionEdit":
        if self.end_date < self.start_date:
            raise ValueError("end_date must not be before start_date")
        return self


class RefreshOut(BaseModel):
    open: int = Field(description="Open suggestions after the refresh")


# --------------------------------------------------------------------------- S3a changes

ChangeOp = Literal[
    "move_dates",
    "change_horizon",
    "reorder",
    "cut",
    "restore",
    "edit_title",
    "edit_outcome",
    "accept_date_suggestion",
    "accept_risk",
    "shift_dependents",
    "move_dependency",
    # S3b: non-versioned targets (oracle.simple.targets), applied directly or proposed.
    "override_priority",
    "add_item_task",
    "edit_item_task",
    "set_item_task_status",
    "add_action_item",
    "edit_action_item",
    "set_action_item_status",
    "add_launch_task",
    "set_launch_task_status",
    # S6: a person's estimate of a feature's goal value and effort (non-versioned), and a
    # draft item confirmed (into the working draft).
    "estimate_feature",
    "confirm_item",
]
ChangeStatus = Literal["applied", "proposed", "accepted", "declined", "undone"]
SessionKind = Literal["editing", "meeting"]


class SimpleSessionIn(BaseModel):
    kind: SessionKind = "editing"


class SimpleSessionOut(BaseModel):
    id: uuid.UUID
    kind: SessionKind
    started_by: uuid.UUID
    started_at: dt.datetime
    last_change_at: dt.datetime | None
    closed_at: dt.datetime | None


class SimpleChangeIn(BaseModel):
    # The caller's open session; without one, an applied change goes to the caller's
    # open editing session (opened when none), a proposal to none.
    session_id: uuid.UUID | None = None
    op: ChangeOp
    # {"item_id"} for every op; accept_date_suggestion adds "suggestion_id"; accept_risk
    # "flag" and "subject" (optional); shift_dependents and move_dependency "subject" (the
    # dependency's item id of the flag).
    target: dict[str, Any]
    # The fields the change writes, as the caller saw them; for shift_dependents and
    # move_dependency, {item_id: {"start_date", "end_date"}} for the item and its subject.
    before: dict[str, Any]
    after: dict[str, Any] = Field(default_factory=dict)
    reason: str | None = Field(default=None, max_length=500)


class SimpleDecisionIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class SimplePersonRef(BaseModel):
    id: uuid.UUID
    name: str


class SimpleChangeOut(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID | None
    document_id: uuid.UUID | None
    # S3b: the working drafts an applied change wrote (empty: a proposal, a non-versioned
    # target).
    draft_ids: list[uuid.UUID] = []
    op: ChangeOp
    target: dict[str, Any]
    before: dict[str, Any]
    after: dict[str, Any]
    status: ChangeStatus
    by: uuid.UUID
    by_name: str
    at: dt.datetime
    decided_by: uuid.UUID | None
    decided_at: dt.datetime | None
    reason: str | None
    decision_reason: str | None
    routed_to: list[uuid.UUID]
    undoes_id: uuid.UUID | None
    # An undone row reverses this change.
    undone: bool = False
    # The caller may accept or decline this proposal / undo this change now.
    can_decide: bool = False
    can_undo: bool = False


class SimpleItemFlags(BaseModel):
    item_id: uuid.UUID
    flags: list[SimpleFlag]


class SimpleChangeResult(BaseModel):
    change: SimpleChangeOut
    # S2's constraint checker on the touched items and their dependents, after the
    # change (for a proposal: as if it were applied).
    flags: list[SimpleItemFlags]


class SimpleChangeConflict(BaseModel):
    """The 409 detail: what the target holds now and who changed it last (null: not
    through Simple). Nothing was written."""

    message: str
    current: dict[str, Any]
    changed_by: SimplePersonRef | None
    changed_at: dt.datetime | None


class InboxSimpleChange(BaseModel):
    """A proposal waiting for me (``simple_proposals``) or a decision on my proposal
    (``simple_decisions``)."""

    id: uuid.UUID
    op: ChangeOp
    status: ChangeStatus
    item_id: uuid.UUID | None
    item_title: str | None
    document_id: uuid.UUID | None
    by: uuid.UUID
    by_name: str
    at: dt.datetime
    decided_by: uuid.UUID | None
    decided_at: dt.datetime | None
    reason: str | None
    decision_reason: str | None
    state: Literal["new", "open", "done"]


DraftStatus = Literal["working", "submitted", "approved", "discarded"]


class SimpleDraftBrief(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    status: DraftStatus
    changes: int


class SimpleDraftChange(BaseModel):
    """One change a draft holds (D-d): what an approval covers, by whom, when, and whether
    it was made in a meeting."""

    id: uuid.UUID
    op: str
    item_id: uuid.UUID | None
    by: uuid.UUID
    by_name: str
    at: dt.datetime
    session_kind: Literal["editing", "meeting"] | None
    in_meeting: bool


class SimpleDraftOut(BaseModel):
    """A working draft of one roadmap (S3b): its changes until submitted, then the version
    in review and who it waits on."""

    id: uuid.UUID
    document: SimpleDocRef
    status: DraftStatus
    # The version it was opened on, and the one submitting it imported.
    base_version: int | None
    version: int | None
    created_by: uuid.UUID
    created_at: dt.datetime
    participant_ids: list[uuid.UUID]
    # Applied changes in it, not undone.
    changes: int
    submitted_at: dt.datetime | None
    submitted_by: uuid.UUID | None
    # The decider approved (in a meeting or not); the version publishes when no required
    # reviewer is left in ``waiting_on``.
    decider_approved: bool
    waiting_on: list[uuid.UUID]
    approved_at: dt.datetime | None
    # What else holds the version back (the review policy's blockers), on approve.
    blocked_by: list[str] = []
    can_submit: bool
    can_resume: bool
    can_approve: bool
    # D-d: every applied change it holds, not undone, oldest first (one shared draft per
    # roadmap: approving it publishes them all).
    change_log: list[SimpleDraftChange] = []
    # The draft's author or the decider withdraws a submitted draft back to working.
    can_withdraw: bool = False


class SimpleNotApproved(BaseModel):
    """A roadmap a meeting's session worked on that the caller does not approve."""

    draft_id: uuid.UUID
    document: SimpleDocRef
    reason: str


class SimpleMeetingApproval(BaseModel):
    """approve_in_meeting's answer (S8): the drafts approved, and those left for their own
    decider."""

    drafts: list[SimpleDraftOut]
    not_approved: list[SimpleNotApproved] = []


class SimpleResumeOut(BaseModel):
    session: SimpleSessionOut
    draft: SimpleDraftOut


class InboxSimpleApproval(BaseModel):
    """A roadmap version from a Simple draft waiting for my approval as a required
    reviewer (``simple_approvals``, counted in ``total``)."""

    draft_id: uuid.UUID
    document: SimpleDocRef
    version: int | None
    submitted_by: uuid.UUID | None
    submitted_at: dt.datetime | None
    decider_approved: bool
    state: Literal["new", "open"]


# --------------------------------------------------------------------------- S6 priorities


class SimpleQuarter(BaseModel):
    start: dt.date
    end: dt.date
    # "Q4 2026"
    label: str


class SimplePriorityGoal(BaseModel):
    key: str
    title: str


class SimplePriorityAfter(BaseModel):
    """The dependency ranked above a higher-scoring row: "after <code>, which it needs"."""

    code: str
    title: str


class SimplePriorityOverride(BaseModel):
    """The active move or pin that placed a row, and who made it."""

    by_name: str
    reason: str
    at: dt.datetime | None = None


class SimplePriorityRow(BaseModel):
    rank: int
    # Oracle's rank (the formula and dependencies, before people's overrides).
    oracle_rank: int | None = None
    feature_id: str
    item_id: uuid.UUID | None = None
    # The item's key, else the feature's key.
    code: str
    title: str
    goal: SimplePriorityGoal | None = None
    milestone: str | None = None
    horizon: Literal["now", "next", "later"] | None = None
    goal_value: float | None = None
    # Engineer-weeks.
    effort: float | None = None
    score: float | None = None
    # The goal value is a person's estimate (estimate_feature).
    value_estimated: bool = False
    # Codes of the rows it depends on (direct).
    depends_on: list[str] = []
    after: SimplePriorityAfter | None = None
    override: SimplePriorityOverride | None = None
    # This quarter's plan (horizon now).
    above_line: bool = False
    # Serves no confirmed goal.
    no_goal: bool = False
    can_reorder: bool = False
    # The caller's change applies (else it is proposed).
    applies: bool = False
    # The feature's active override as override_priority's ``before.override`` wants it.
    before_override: dict[str, Any] | None = None


class SimpleFlowScreen(BaseModel):
    title: str
    regions: list[str]


class SimpleFlow(BaseModel):
    title: str
    steps: list[str]
    screen: SimpleFlowScreen


class SimplePriorityProposal(BaseModel):
    change_id: uuid.UUID
    op: Literal["override_priority", "estimate_feature", "confirm_item", "cut"]
    item_id: uuid.UUID
    # The item's baseline feature (the row it shows under); None for a draft with none.
    feature_id: str | None = None
    code: str
    title: str
    by_name: str
    at: dt.datetime
    reason: str | None = None
    after: dict[str, Any]
    # Names of who decides it.
    waiting_for: list[str]
    can_decide: bool = False
    # The design bundle of the item's feature; None until S10 ("No flow yet").
    flow: SimpleFlow | None = None


class SimplePriorityMerge(BaseModel):
    item_id: uuid.UUID
    code: str
    title: str


class SimplePriorityDraft(BaseModel):
    item_id: uuid.UUID
    code: str
    title: str
    goal: SimplePriorityGoal | None = None
    roadmap: SimpleDocRef
    applies: bool = False
    # Non-draft items of the same roadmap, same goal first (at most 8).
    merge_into: list[SimplePriorityMerge] = []


class SimpleGoalBucket(BaseModel):
    # The goal's key, or "none".
    key: str
    title: str
    # This quarter's engineer-weeks: the effort of the goal's rows with horizon now.
    weeks: float
    share: float
    codes: list[str]
    no_goal: bool = False


class SimplePrioritiesOut(BaseModel):
    today: dt.date
    quarter: SimpleQuarter
    method: str
    formula: str
    # In the company's order (rank 1 first).
    rows: list[SimplePriorityRow]
    proposals: list[SimplePriorityProposal]
    drafts: list[SimplePriorityDraft]
    buckets: list[SimpleGoalBucket]
    weeks_total: float
    # Commenter and up: may reorder and estimate (applies or proposes).
    can_change: bool


SimpleRoadmapOut.model_rebuild()
