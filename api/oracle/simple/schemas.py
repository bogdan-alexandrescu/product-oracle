"""Simple S2 (#723): the company-wide roadmap read and the date suggestions; S3a: the
change engine's sessions and changes; S3b: working drafts."""

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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
ItemStatus = Literal["planned", "in_progress", "done", "cut", "draft", "merged"]
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
    # S4: the goal's metric (its ``attrs.metric``), the goal counters' line.
    metric: str | None = None


class SimpleTrackRef(BaseModel):
    id: uuid.UUID
    title: str


class SimpleItemMilestone(BaseModel):
    name: str | None = None
    date: dt.date | None = None
    # item: the item's own milestone; track: a track milestone naming the item.
    source: Literal["item", "track"]
    # The track milestone record naming the item, whichever source the name and date are
    # from: the plan strip groups its items by it, whatever their own texts say.
    record_id: uuid.UUID | None = None
    record_name: str | None = None
    # plan-model: the milestone's start when the PRD's plan dates it (``date`` its end).
    start_date: dt.date | None = None


class SimpleOwnerRef(BaseModel):
    id: uuid.UUID
    name: str


class SimpleMilestoneTarget(BaseModel):
    """plan-model: one goal's target at a milestone, in words with its unit."""

    goal: str
    target: str


class SimpleSlice(BaseModel):
    """plan-model: the part of a roadmap item's feature one milestone builds (F-05a / F-05b;
    an item in one milestone has one slice, F-05). Its dates are Oracle's placement inside
    the milestone by the PRD's order words (``estimated``)."""

    code: str
    feature_code: str
    name: str
    milestone: str
    milestone_name: str
    milestone_start: dt.date | None = None
    milestone_end: dt.date | None = None
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    estimated: bool = True
    # Null for PM-owned work (no engineering).
    effort_weeks: float | None = None
    # The goal it moves most: the first in the PRD's goals column for it.
    goal: str | None = None
    pm_owned: bool = False


class SimplePlanSpan(BaseModel):
    """plan-model: first milestone start to last milestone end, "2 Nov - 12 Feb"."""

    start: dt.date
    end: dt.date
    label: str


class SimplePlanMilestone(BaseModel):
    code: str
    name: str
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    # Its capacity, as the PRD gives it.
    effort_weeks: float | None = None
    # The slices' engineer-weeks in it.
    planned_weeks: float = 0
    done_when: list[str] = []
    targets: list[SimpleMilestoneTarget] = []
    feature_codes: list[str] = []
    # prd: the PRD's own tables; oracle: Oracle's reading of its text.
    source: Literal["prd", "oracle"] = "prd"


class SimplePlanGoalTarget(BaseModel):
    milestone: str
    target: str


class SimplePlanGoal(BaseModel):
    name: str
    targets: list[SimplePlanGoalTarget] = []


class SimpleGoalWeeks(BaseModel):
    """Engineer-weeks per goal per milestone: each slice once, under its feature's first
    goal."""

    goal: str
    milestone: str
    weeks: float


class SimpleHoliday(BaseModel):
    start: dt.date
    end: dt.date
    label: str | None = None


class SimplePlanOut(BaseModel):
    prd: "SimpleDocRef"
    # The approved version the plan is read from.
    version: int | None = None
    # none: no approved version or no plan in it; reading: Oracle's job is reading it.
    status: Literal["ready", "reading", "failed", "none"]
    source: Literal["prd", "oracle"] | None = None
    dated: bool = False
    message: str | None = None
    milestones: list[SimplePlanMilestone] = []
    slices: list[SimpleSlice] = []
    goals: list[SimplePlanGoal] = []
    goal_weeks: list[SimpleGoalWeeks] = []
    span: SimplePlanSpan | None = None
    holidays: list[SimpleHoliday] = []
    can_read_again: bool = False
    read_at: dt.datetime | None = None


class SimpleOpenDecision(BaseModel):
    """S4: a proposed decision naming the item as a subject (the floating card's)."""

    id: uuid.UUID
    number: int
    title: str


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
    # plan-model: the slice it dates (F-05a), inside the slice's milestone; null: the item.
    slice_code: str | None = None
    # The caller may accept, edit or dismiss it: an owner, the roadmap's decider, or with
    # no decider the roadmap's track owner.
    can_decide: bool = False


class SimpleRoadmapItem(BaseModel):
    id: uuid.UUID
    key: str
    # The PRD's own code of the section the item was imported from ("f-06" -> "F-06");
    # null when that section key is no code.
    code: str | None = None
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
    # Whether the caller applies changes to this item (service.can_decide), the names of who
    # decides it (D-a: the decider, else the deciding track owner, else the owners), and S4's
    # floating card: the item's track owner (enabled), up to 3 one-line reasons (the
    # priority's rationale, the goal it serves, its PRD section) and the open decisions naming it.
    owner: SimpleOwnerRef | None = None
    can_decide: bool = False
    deciders: list[str] = []
    reasons: list[str] = []
    open_decisions: list[SimpleOpenDecision] = []
    # S7 (oracle.simple.additions): a draft's likely duplicates (not kept both; at most 2,
    # best first), the item it was merged into, whether Oracle is drafting it, its flow
    # (null: no flow yet) and the goals it is linked to directly.
    looks_like: list["SimpleMatch"] = Field(
        default=[],
        description="S7: likely duplicates of a draft not kept both (at most 2, best first).",
    )
    merged_into: "SimpleMergedInto | None" = None
    drafting: bool = Field(
        default=False, description="S7: Oracle's drafting job for this draft is queued or running."
    )
    flow: "SimpleFlow | None" = None
    goal_ids: list[str] = Field(
        default=[], description="S7: the goals the item is linked to directly."
    )

    # S8: the decided decisions that changed the item (newest first; the Decisions page).
    decided_in: list[SimpleOpenDecision] = []
    # plan-model: one slice per milestone its feature spans in the PRD's plan, and those
    # milestones' codes.
    slices: list["SimpleSlice"] = []
    milestones: list[str] = []


class SimpleMatch(BaseModel):
    kind: Literal["item", "feature"]
    id: str
    # Its display code ("F-06"), "" when it has none (never its key).
    code: str
    title: str


class SimpleMergedInto(BaseModel):
    id: str
    code: str
    title: str


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
    # plan-model: from the PRD's plan, the milestone of the same code (M1, M2, ...).
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    effort_weeks: float | None = None
    done_when: list[str] = []
    targets: list["SimpleMilestoneTarget"] = []


class SimpleKeyDate(BaseModel):
    """Roadmap-plus: one of a roadmap's key dates (a conference, a product launch, a board
    meeting), as the reader reads it (the working draft's when they see it)."""

    id: uuid.UUID
    roadmap: "SimpleDocRef"
    name: str
    date: dt.date
    note: str | None = None
    # Added or changed in the roadmap's working draft (not published yet).
    in_draft: bool = False


class SimpleKeyDateRoadmap(BaseModel):
    """A roadmap whose key dates the reader reads; ``applies``: their change applies (an
    owner, the decider, with none its owner), ``can_change``: they may change or propose."""

    roadmap: "SimpleDocRef"
    applies: bool = False
    can_change: bool = False


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
    # Roadmap-plus: the key dates of the roadmap chosen (else of every roadmap the reader
    # may read), by day, and those roadmaps.
    key_dates: list[SimpleKeyDate] = []
    key_date_roadmaps: list[SimpleKeyDateRoadmap] = []
    # The Roadmap filter: every roadmap the reader may read (whether their change applies
    # there), and the one the read is narrowed to (``roadmap``), if any.
    roadmaps: list[SimpleKeyDateRoadmap] = []
    roadmap: "SimpleDocRef | None" = None
    # plan-model: the shown PRDs' plan span ("this quarter"); null with no plan.
    span: "SimplePlanSpan | None" = None


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
    # S5: a one-pager line, as a section patch of each of its source sections
    # (oracle.simple.one_pager).
    "edit_line",
    # Roadmap-plus: a roadmap's key dates, into its working draft (oracle.simple.key_dates).
    "add_key_date",
    "edit_key_date",
    "remove_key_date",
    # S7: a draft item added (oracle.simple.additions), merged into another item or a
    # feature, kept beside its look-alikes.
    "add_item",
    "merge_item",
    "keep_both",
    # S9: an item's own milestone (into the working draft) and a feature ask filed in
    # Oracle's Requests (non-versioned), both made by chat as well.
    "set_milestone",
    "add_feature_ask",
    # chat-actions: the item's own owner and decider (into the working draft).
    "set_owner",
    "set_decider",
]
# chat-actions: chat cards applied through the meetings module or Oracle's decisions, not
# the change engine (oracle.simple.chat_actions).
ChatActionOp = Literal[
    "record_decision",
    "minutes_note",
    "open_question",
    "agenda_next",
    "agenda_skip",
    "suggest_feature",
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
    # S8: a meeting's session: the accepted proposal applies into the meeting's drafts and
    # the decision is a meeting decision.
    session_id: uuid.UUID | None = None


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
    # What a mark on the value/effort 2x2 shows: a short code that never changes with rank, the
    # feature's code (F-12) else 2-3 capitals from the feature's key, the same for every
    # reader, unique in the company (a digit added on a clash, in the features' creation
    # order). oracle.simple.priorities.short_codes.
    short_code: str = ""
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
    # Above the line: this quarter's plan (horizon now) by default; with a date line, planned
    # to finish by that day (its stored or estimated end).
    above_line: bool = False
    # Roadmap-plus: the item's end as the roadmap resolves it (stored or estimated).
    end_date: dt.date | None = None
    end_estimated: bool = False
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


class SimpleFlowStep(BaseModel):
    """A step of a user flow (S10): a decision point or a step, the feature that enables
    it and what changes versus today."""

    id: str
    label: str
    kind: Literal["step", "decision"] = "step"
    feature: str | None = None
    change: Literal["new", "changed", "same"] = "same"
    section_key: str | None = None
    # Who does it ("User", "App", "Admin"...); null on drawings made before it was asked.
    actor: str | None = None
    # A decision: what its Yes and its No lead to, in words.
    yes: str | None = None
    no: str | None = None


class SimpleFlowNote(BaseModel):
    """A numbered annotation: the part of the drawing it is on (an element id of the flow
    or a region of the wireframe), the PRD section and requirement it ties to."""

    n: int
    target: str
    note: str
    section_key: str | None = None
    requirement: str | None = None


class SimpleFlow(BaseModel):
    """A proposal's visual (S10, oracle.simple.visuals): its newest drawing."""

    title: str
    steps: list[str]
    screen: SimpleFlowScreen
    subject_kind: str | None = None
    subject_id: uuid.UUID | None = None
    version: int = 1
    versions: int = 1
    goal: str | None = None
    nodes: list[SimpleFlowStep] = []
    # The user flow as sanitised SVG (static, offline); the screen's low-fi wireframe as
    # sanitised HTML, null when the proposal touches no screen.
    svg: str | None = None
    wireframe: str | None = None
    touches_screen: bool = True
    annotations: list[SimpleFlowNote] = []
    made_at: dt.datetime | None = None


class SimpleVisualVersionOut(BaseModel):
    number: int
    title: str
    made_at: dt.datetime
    made_by_name: str | None = None
    # How many comments this version addressed.
    addressed: int = 0


class SimpleVisualCommentOut(BaseModel):
    id: uuid.UUID
    version: int
    annotation: int | None = None
    body: str
    by_name: str
    at: dt.datetime
    # The version that addressed it (a revise); null: open.
    addressed_in: int | None = None


class SimpleVisualOut(BaseModel):
    subject_kind: str
    subject_id: uuid.UUID
    brief: str | None = None
    # The newest drawing; null: none yet ("No flow yet").
    flow: SimpleFlow | None
    # Newest first.
    versions: list[SimpleVisualVersionOut]
    comments: list[SimpleVisualCommentOut]
    # Oracle is drawing it (a queued or running job).
    pending: bool
    # Oracle's newest drawing job ended without a drawing (it failed, or its answer did
    # not check out): the panel says so and offers Retry. ``failure``: why, in words.
    failed: bool = False
    failure: str | None = None
    # While Oracle draws: when the job was asked for and how far it got, 0 reading the
    # subject (queued), 1 drawing (running); the subject named with its code, for "Read
    # F-06 Adaptive pacing".
    started_at: dt.datetime | None = None
    stage: int = 0
    subject_name: str | None = None
    # Commenters and up comment on a drawn visual; who changes the subject directly asks
    # for a drawing and revises.
    can_comment: bool
    can_revise: bool


class SimpleVisualCommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    # The numbered annotation the comment is on.
    annotation: int | None = Field(default=None, ge=1)


class SimpleVisualReviseIn(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


class SimpleVisualRequestIn(BaseModel):
    brief: str = Field(default="", max_length=2000)
    # A one-pager bet line's PRD (its subject is a bet of that page).
    document_id: uuid.UUID | None = None


class SimplePriorityProposal(BaseModel):
    change_id: uuid.UUID
    op: Literal["override_priority", "estimate_feature", "confirm_item", "cut", "merge_item"]
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
    # This quarter's engineer-weeks: the effort of the goal's rows the plan places in its
    # span (plan-model), else (no dated plan) of its rows with horizon now.
    weeks: float
    share: float
    codes: list[str]
    no_goal: bool = False


class SimpleLine(BaseModel):
    """Roadmap-plus: where the line on priorities is drawn. ``now``: this quarter's plan
    (the Now horizon); ``key_date:<id>``, ``milestone:<id>``, ``date:<YYYY-MM-DD>``: planned
    to finish by that day."""

    key: str
    kind: Literal["now", "key_date", "milestone", "date"]
    label: str
    date: dt.date | None = None


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
    # Roadmap-plus: the line drawn, and the lines offered (Pick a date aside).
    line: SimpleLine | None = None
    lines: list[SimpleLine] = []


SimpleRoadmapItem.model_rebuild()
SimpleRoadmapOut.model_rebuild()


# --------------------------------------------------------------------------- S5 one-pagers


class OnePagerMetric(BaseModel):
    name: str
    # Empty when the section states no starting value.
    from_: str = Field(default="", alias="from", serialization_alias="from")
    to: str

    model_config = {"populate_by_name": True}


class OnePagerLine(BaseModel):
    # Stable within a version's one-pager: "<block>-<n>".
    id: str
    text: str
    # The whole text when ``text`` is shortened (cut at a word boundary with "…"): the page
    # offers it in place ("Show all").
    full: str | None = None
    # The PRD sections the line rests on: a click opens the drill-down, "Open the
    # detailed view" lands on the first.
    source_keys: list[str]
    metric: OnePagerMetric | None = None
    # published: as the version has it; edited: the working draft's (the reader sees it);
    # proposal: someone proposes new wording (the margin note says who).
    state: Literal["published", "edited", "proposal"] = "published"
    # S10: a bet's ("What we will build") visual subject and its newest drawing.
    flow_subject: uuid.UUID | None = None
    flow: "OnePagerFlow | None" = None
    # S8: the decisions that changed this line (newest first; the Decisions page).
    decisions: list[SimpleOpenDecision] = []


class OnePagerItem(BaseModel):
    """The timeline strip: the PRD's slice of the Simple roadmap."""

    id: uuid.UUID
    title: str
    horizon: Literal["now", "next", "later"]
    start: dt.date
    end: dt.date
    estimated: bool


class OnePagerBlock(BaseModel):
    key: str
    title: str
    # The block's cap in words ("At most 60 words", "3-5 bets").
    rules: str
    kind: Literal["text", "lines", "metrics", "timeline"]
    lines: list[OnePagerLine] = []


class OnePagerSectionPatch(BaseModel):
    key: str
    heading: str
    before: str
    after: str


class OnePagerFlow(BaseModel):
    """A design bundle's flow (S10's), as the API returns it; none yet: null."""

    title: str
    steps: list[str] = []
    screen: str | None = None
    # S10: the visual it is (for the widened card's comments, versions and Revise).
    subject_kind: str | None = None
    subject_id: uuid.UUID | None = None
    version: int | None = None


class OnePagerNote(BaseModel):
    """A margin note beside its line: a change in the working draft or a proposal."""

    change_id: uuid.UUID
    line_id: str
    kind: Literal["change", "proposal"]
    by: uuid.UUID
    by_name: str
    at: dt.datetime
    in_meeting: bool
    before: str
    after: str
    sections: list[OnePagerSectionPatch]
    can_undo: bool
    can_decide: bool
    # S8: the titled meeting the change was made in ("…, in <meeting title>").
    meeting_title: str | None = None
    # The line adds or reshapes a flow or feature (a "What we will build" bet): the note
    # shows its flow thumbnail, ``flow`` (null: "No flow yet").
    adds_feature: bool
    flow: OnePagerFlow | None = None


class OnePagerDraft(BaseModel):
    id: uuid.UUID
    status: Literal["working", "submitted"]
    changes: int
    base_version: int | None
    # Approved in a meeting by the decider, waiting on required reviewers' approval.
    decider_approved: bool
    waiting_on: list[SimplePersonRef]
    can_submit: bool
    # Remind (owner, 2026-10-26): the last nudge to a waiting reviewer, and whether the
    # caller (the PRD's owners, its decider) may nudge one now (each at most once a day).
    reminded_at: dt.datetime | None = None
    can_remind: bool = False

    # S8: the meeting the decider approved it in ("Approved in <meeting title>").
    approved_in: str | None = None
    # What else, besides ``waiting_on``, holds a decider-approved draft back (#723 review:
    # "Sections Scope need a reviewer"), as the meeting's banner says it.
    blocked_by: list[str] = []


class OnePagerRemindOut(BaseModel):
    """Remind's answer: the reviewers nudged now (each gets an Inbox nudge)."""

    reminded: list[SimplePersonRef]
    reminded_at: dt.datetime


class OnePagerSource(BaseModel):
    """A source section of the page's lines, as the reader reads it (the drill-down)."""

    key: str
    heading: str
    body: str


class SimplePlanRow(BaseModel):
    """One row of the plan strip: a milestone (its name, date and how many of the PRD's
    items carry it), or the items with no milestone summed in one row."""

    name: str
    date: dt.date | None = None
    items: int
    # The span of its items (the row's bar), and whether every one of them is estimated.
    start: dt.date
    end: dt.date
    estimated: bool
    milestone: bool
    # Its date falls after the strip's last month.
    past_edge: bool = False


class SimplePlanStrip(BaseModel):
    """The plan strip (the owner's pick for Home and the one-pager): the PRD's span by
    month with its milestones, today's line and how many commitments end past the edge."""

    start: dt.date
    end: dt.date
    # The first day of each month across the strip.
    months: list[dt.date]
    today: dt.date | None = None
    rows: list[SimplePlanRow]
    # Committed (not estimated) items that end after the strip's last day.
    past_edge: int = 0


class OnePagerOut(BaseModel):
    document: SimpleDocRef
    version: int
    published_at: dt.datetime | None
    owner: SimplePersonRef | None
    decider: SimplePersonRef | None
    span_start: dt.date | None
    span_end: dt.date | None
    # extract: Oracle's quick read, shown while the one_pager job builds it; oracle: built.
    built_by: Literal["extract", "oracle"]
    built_at: dt.datetime
    blocks: list[OnePagerBlock]
    # The timeline strip: the PRD's slice of the Simple roadmap (the span is its ends).
    timeline: list[OnePagerItem]
    # The Timeline block's strip: the PRD's span by month and its milestones (no per-item
    # bars); None with no roadmap items.
    plan: SimplePlanStrip | None = None
    sections: list[OnePagerSource] = []
    notes: list[OnePagerNote]
    draft: OnePagerDraft | None
    # Drafts and proposals the reader may not see (the count only).
    changes_in_review: int
    # Owners and the decider change lines directly (Undo); approvers and commenters
    # propose; viewers read.
    can_edit: bool
    can_propose: bool


# --------------------------------------------------------------------------- S7


class SimpleGoalBrief(BaseModel):
    id: str
    key: str
    title: str


class SimpleEvidence(BaseModel):
    label: str
    kind: str
    ref: str | None
    url: str | None
    confidence: Literal["high", "medium", "low"]


class SimpleGoalSuggestion(BaseModel):
    id: str
    goal: SimpleGoalBrief
    title: str
    outcome: str
    why: str
    evidence: list[SimpleEvidence]
    status: Literal["open", "accepted", "rejected"]
    reason: str | None
    origin: Literal["auto", "on_demand", "person"]
    created_at: dt.datetime
    decided_by_name: str | None
    decided_at: dt.datetime | None
    change_id: str | None
    item_id: str | None
    looks_like: list[SimpleMatch]
    flow: SimpleFlow | None
    can_accept: bool
    can_reject: bool
    # A person's suggestion (origin "person"): their display name.
    proposed_by_name: str | None = None


class SimpleGoalSuggestionGoal(BaseModel):
    goal: SimpleGoalBrief
    pending: bool
    empty: bool
    # Who decides the goal's suggestions (its roadmap's decider, else its approving owners).
    decider_name: str | None = None
    # Whether the caller decides them (the drawer folds its form for the decider).
    can_decide: bool = False


# oracle.simple.changes.TITLE_MAX (changes imports this module).
SUGGESTION_TITLE_MAX = 200


class SimpleGoalSuggestionIn(BaseModel):
    """A person's goal suggestion: its title and what it does, and for whom."""

    title: str = Field(min_length=1, max_length=SUGGESTION_TITLE_MAX)
    outcome: str = Field(min_length=1, max_length=1000)

    @field_validator("title", "outcome", mode="before")
    @classmethod
    def _collapse(cls, v: Any) -> Any:
        return " ".join(v.split()) if isinstance(v, str) else v


class SimpleGoalSuggestionsOut(BaseModel):
    goals: list[SimpleGoalSuggestionGoal]
    suggestions: list[SimpleGoalSuggestion]


class SimpleSuggestJobOut(BaseModel):
    goal_id: str
    pending: bool
    job_id: str


class SimpleSuggestionAcceptIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    roadmap_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None


class SimpleSuggestionRejectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=500)


# --------------------------------------------------------------------------- S9 chat

CardStatus = Literal["open", "applied", "proposed", "discarded", "undone"]
ChangeMode = Literal["everyone", "presenter", "named"]


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    # The Simple page the person asks from (the Ask panel), for context.
    page: str | None = Field(default=None, max_length=300)
    # The Ask panel's one box: write nothing when Oracle's reader does not know the line
    # (the answer says understood=false and the panel asks Oracle's Ask instead).
    only_understood: bool = False
    # ask-fresh: continue the caller's own Ask chat ``chat_id``; else ``new_chat`` starts a
    # new one about ``page`` (the Ask panel opened again); else the page's first chat.
    chat_id: uuid.UUID | None = None
    new_chat: bool = False
    # ask-fresh: the new chat is about General, not the page (Recent names it "General").
    general: bool = False


class ChatFix(BaseModel):
    """A one-click fix for a broken link the card would make: its own change-engine op."""

    label: str
    op: ChangeOp
    target: dict[str, Any]
    before: dict[str, Any]
    after: dict[str, Any] = Field(default_factory=dict)


class ChatCardOut(BaseModel):
    id: uuid.UUID
    message_id: uuid.UUID | None
    op: ChangeOp | ChatActionOp
    target: dict[str, Any]
    before: dict[str, Any]
    after: dict[str, Any]
    summary: str
    item_id: uuid.UUID | None
    item_title: str | None
    status: CardStatus
    # What the reader's Apply does now: the change engine applies or proposes it; None:
    # the reader may not (``why_not``).
    may: Literal["apply", "propose"] | None
    why_not: str | None
    # The constraint check as if applied, and one-click fixes of the links it breaks.
    flags: list[SimpleItemFlags]
    fixes: list[ChatFix]
    # How the stage shows it before Apply: {kind: dates|horizon|title|milestone|cut, ...}.
    preview: dict[str, Any] | None
    # Cards that add or change a flow or feature: the design bundle (oracle.simple.visuals).
    flow: SimpleFlow | None
    change_id: uuid.UUID | None
    decided_by_name: str | None
    decided_at: dt.datetime | None
    # The meeting decision an applied card became.
    decision_id: uuid.UUID | None


class ChatChoiceOut(BaseModel):
    index: int
    label: str


class ChatMessageOut(BaseModel):
    id: uuid.UUID
    author_kind: Literal["person", "oracle"]
    author_id: uuid.UUID | None
    author_name: str
    body: str
    at: dt.datetime
    # pending: Oracle's reader is reading the line; failed: it could not (``retry``); ask:
    # a question for Oracle's Ask (the Ask panel's one box hands the line there).
    kind: Literal["request", "cards", "question", "answer", "note", "pending", "failed", "ask"]
    cards: list[ChatCardOut]
    reply_to: uuid.UUID | None = None
    # A question's clickable choices ("Neither" last); ``picked``: the one taken.
    choices: list[ChatChoiceOut] = Field(default_factory=list)
    picked: int | None = None
    retry: bool = False


class ChatRulesOut(BaseModel):
    change_mode: ChangeMode
    change_people: list[SimplePersonRef]
    presenter: SimplePersonRef
    is_presenter: bool
    may_apply: bool
    ask_only: bool
    ended: bool


class ChatThreadOut(BaseModel):
    id: uuid.UUID | None
    meeting_id: uuid.UUID | None
    messages: list[ChatMessageOut]
    rules: ChatRulesOut | None
    # False when Oracle's reader did not know the last line (the Ask panel's one box).
    understood: bool = True
    # ask-fresh: the Oracle's Ask chat this Ask chat handed its questions to, if any.
    ask_id: uuid.UUID | None = None


class ChatSummaryOut(BaseModel):
    """ask-fresh: one of the person's Ask chats on Recent chats, named by its page."""

    id: uuid.UUID
    page: str
    page_name: str
    last_at: dt.datetime
    ask_id: uuid.UUID | None = None
    # Started under "General": named so on Recent, and reopened as General.
    general: bool = False


class ChatListOut(BaseModel):
    items: list[ChatSummaryOut]


class ChatAskIn(BaseModel):
    ask_id: uuid.UUID


class ChatChooseIn(BaseModel):
    index: int = Field(ge=0, le=10)


class ChatStopOut(BaseModel):
    card_id: uuid.UUID
    summary: str
    reason: str


class ChatApplyAllOut(BaseModel):
    thread: ChatThreadOut
    applied: list[uuid.UUID]
    # The first card that could not apply, and why (the rest stay open); None: all applied.
    stopped: ChatStopOut | None


class ChatModeIn(BaseModel):
    change_mode: ChangeMode
    change_people: list[uuid.UUID] = Field(default_factory=list, max_length=2)


class ChatApplyIn(BaseModel):
    # Apply the card's fixes[fix] instead of its own op.
    fix: int | None = Field(default=None, ge=0)


class ChatApplyOut(BaseModel):
    card: ChatCardOut
    # None for chat-actions' direct ops (no change-engine change).
    result: SimpleChangeResult | None = None


class WalkDecision(BaseModel):
    id: uuid.UUID
    title: str
    url: str


class WalkStepOut(BaseModel):
    id: str
    kind: Literal["broken_link", "agenda_decision", "proposal"]
    title: str
    why: str
    card: ChatCardOut | None = None
    change: SimpleChangeOut | None = None
    decision: WalkDecision | None = None


class WalkOut(BaseModel):
    steps: list[WalkStepOut]


# --------------------------------------------------------------------------- S8 meetings

ChangeMode = Literal["everyone", "presenter", "named"]
MeetingOrigin = Literal["one_pager", "roadmap", "ritual"]
MeetingStatus = Literal["live", "ended"]
MinutesState = Literal["drafting", "ready", "sent"]
# The ``meeting_minutes`` job while the minutes are drafting: running, past
# meetings.MINUTES_SLOW ("slow": send what is written), or failed (draft again).
MinutesJobState = Literal["drafting", "slow", "failed"]


class SimpleAttendee(BaseModel):
    id: uuid.UUID
    name: str
    # What the person is to the PRD: decider, required reviewer, owner (its tracks').
    roles: list[Literal["decider", "reviewer", "owner", "presenter"]] = []
    present: bool = True


class SimpleDecidedFlow(BaseModel):
    """The new flow or feature a meeting decision decided (a draft item) and its flow
    (oracle.simple.visuals, S10); ``flow`` is None until one is drawn ("No flow yet")."""

    kind: str
    id: uuid.UUID
    title: str
    flow: SimpleFlow | None = None


class SimpleMeetingDecision(BaseModel):
    """A decision taken in a meeting: a ``decisions`` row, origin ``meeting``."""

    id: uuid.UUID
    number: int
    title: str
    approver: SimplePersonRef
    at: dt.datetime
    subjects: list[dict[str, Any]] = []
    change_ids: list[uuid.UUID] = []
    flow: SimpleDecidedFlow | None = None


class SimpleActionItemIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    owner_id: uuid.UUID | None = None
    due_date: dt.date | None = None
    # An action item recorded in the meeting (its row): Send adds only the new ones.
    action_item_id: uuid.UUID | None = None


class SimpleActionItemOut(SimpleActionItemIn):
    owner_name: str | None = None


class SimpleWait(BaseModel):
    """What still waits on whom (an absent required reviewer's approval, a proposal)."""

    what: str
    on: list[SimplePersonRef] = []


class SimpleMinutes(BaseModel):
    summary: str = ""
    open_questions: list[str] = []
    action_items: list[SimpleActionItemOut] = []
    waits: list[SimpleWait] = []
    # extract: Oracle's quick draft, shown at once; oracle: the minutes job's; edited: a
    # person's.
    written_by: Literal["extract", "oracle", "edited"] = "extract"


class SimpleMinutesIn(BaseModel):
    summary: str = Field(default="", max_length=4000)
    open_questions: list[str] = Field(default_factory=list, max_length=20)
    action_items: list[SimpleActionItemIn] = Field(default_factory=list, max_length=30)


class SimpleDelivery(BaseModel):
    decisions: bool = True
    inbox: bool = True
    # chosen by whoever ended the meeting; status: queued, sent, failed, unavailable.
    email: bool = False
    email_status: str | None = None
    slack: bool = False
    slack_status: str | None = None
    slack_channel: str | None = None


class SimpleSlackState(BaseModel):
    # The company's Slack notifications integration is installed and active.
    connected: bool
    # The Notifications channel minutes go to (Settings › Notifications), when set.
    channel: str | None = None


class SimpleMeetingBrief(BaseModel):
    id: uuid.UUID
    title: str
    prd: SimpleDocRef
    origin: MeetingOrigin
    status: MeetingStatus
    presenter: SimplePersonRef
    attendees: list[SimpleAttendee]
    length_min: int
    started_at: dt.datetime
    ended_at: dt.datetime | None
    decisions: int
    minutes_state: MinutesState | None = None
    summary: str | None = None


class SimpleMeetingCan(BaseModel):
    # Change through the meeting (the presenter's change mode; the caller's own rights
    # decide applied or proposed).
    change: bool
    # The presenter: change mode, presence.
    set_rules: bool
    # The PRD's decider (or an owner): Approve in the meeting.
    approve: bool
    # The presenter, an owner or the decider ends it, edits and sends the minutes.
    end: bool
    # The same people requeue a failed minutes job ("Draft again").
    redraft: bool = False


class SimpleMeetingNote(BaseModel):
    """chat-actions: a minutes note or open question added during the meeting."""

    id: str
    kind: Literal["note", "question"]
    text: str
    by_name: str
    card_id: uuid.UUID | None = None


class SimpleAgendaItem(BaseModel):
    id: uuid.UUID
    title: str


class SimpleAgenda(BaseModel):
    """chat-actions: the item the meeting takes next and the items it skips."""

    next: SimpleAgendaItem | None = None
    skipped: list[SimpleAgendaItem] = []


class SimpleMeetingOut(SimpleMeetingBrief):
    session_id: uuid.UUID
    occurrence_id: uuid.UUID | None = None
    change_mode: ChangeMode
    change_people: list[SimplePersonRef] = []
    roadmap_ids: list[uuid.UUID] = []
    meeting_decisions: list[SimpleMeetingDecision] = []
    open_decisions: list[SimpleOpenDecision] = []
    pending_proposals: list[SimpleChangeOut] = []
    drafts: list[SimpleDraftOut] = []
    # Everyone its drafts wait on, named (#723 review: an absent section reviewer need not
    # be an attendee), for the banner's "Waiting on <name>'s approval".
    waiting_people: list[SimplePersonRef] = []
    minutes: SimpleMinutes | None = None
    # The minutes job's state while ``minutes_state`` is "drafting" (else None).
    minutes_job: MinutesJobState | None = None
    delivery: SimpleDelivery | None = None
    slack: SimpleSlackState
    email_available: bool
    can: SimpleMeetingCan
    # Approve's answer: the roadmaps left for their own decider.
    not_approved: list[SimpleNotApproved] = []
    # chat-actions: the notes and open questions so far, and the agenda's changes.
    notes: list[SimpleMeetingNote] = []
    agenda: SimpleAgenda = SimpleAgenda()


class SimpleUpcomingMeeting(BaseModel):
    """A scheduled review to start from: a ritual occurrence, or an active ritual's next
    due time before its occurrence is made (``occurrence_id`` None; starting it makes it)."""

    occurrence_id: uuid.UUID | None = None
    ritual_id: uuid.UUID
    ritual_title: str
    due_at: dt.datetime
    ends_at: dt.datetime
    length_min: int
    attendees: list[SimplePersonRef]
    meeting_id: uuid.UUID | None = None
    # Its occurrence's pre-read is built (Home's "Open pre-read").
    pre_read_ready: bool = False
    # Owners and the ritual's owner start a ritual's review (the caller may).
    can_start: bool = False


class SimpleMeetingsOut(BaseModel):
    upcoming: list[SimpleUpcomingMeeting]
    live: list[SimpleMeetingBrief]
    past: list[SimpleMeetingBrief]


class SimpleStartPrd(BaseModel):
    document: SimpleDocRef
    decider: SimplePersonRef | None
    # Owners and the document's decider start a meeting; others see who starts it.
    can_start: bool
    starters: list[SimplePersonRef]
    default_attendee_ids: list[uuid.UUID]


class SimpleStartOptions(BaseModel):
    prds: list[SimpleStartPrd]
    members: list[SimplePersonRef]
    length_min: int = 60
    occurrence: SimpleUpcomingMeeting | None = None


class SimpleMeetingIn(BaseModel):
    prd: str = Field(min_length=1, max_length=200)
    title: str | None = Field(default=None, max_length=200)
    origin: MeetingOrigin = "one_pager"
    occurrence_id: uuid.UUID | None = None
    # A ritual's next review before its occurrence is made (Meetings > Upcoming), with the
    # row's due time: a start the ritual has moved past is 409, never next week's review.
    ritual_id: uuid.UUID | None = None
    due_at: dt.datetime | None = None
    attendee_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    change_mode: ChangeMode = "everyone"
    change_people: list[uuid.UUID] = Field(default_factory=list, max_length=2)
    length_min: int = Field(default=60, ge=5, le=240)


class SimpleMeetingRulesIn(BaseModel):
    change_mode: ChangeMode | None = None
    change_people: list[uuid.UUID] | None = Field(default=None, max_length=2)
    absent_ids: list[uuid.UUID] | None = None


class SimpleMeetingCommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    subjects: list[dict[str, Any]] = Field(default_factory=list, max_length=10)


class SimpleSendIn(BaseModel):
    email: bool = False
    slack: bool = False


class SimpleDecisionRow(BaseModel):
    id: uuid.UUID
    number: int
    title: str
    origin: str
    status: str
    approver: SimplePersonRef | None
    decided_at: dt.datetime | None
    created_at: dt.datetime
    subjects: list[dict[str, Any]] = []
    # A meeting decision on a new flow or feature: that flow.
    flow: SimpleDecidedFlow | None = None


class SimpleMeetingGroup(BaseModel):
    meeting: SimpleMeetingBrief
    minutes: SimpleMinutes | None
    decisions: list[SimpleDecisionRow]


class SimpleFilterOption(BaseModel):
    id: str
    title: str


class SimpleDecisionsOut(BaseModel):
    """Simple's Decisions (direction B "By meeting"): the meetings' decisions grouped under
    them, newest first, then the decisions taken outside meetings."""

    meetings: list[SimpleMeetingGroup]
    other: list[SimpleDecisionRow]
    prds: list[SimpleFilterOption]
    goals: list[SimpleFilterOption]
    meeting_options: list[SimpleFilterOption]


class InboxSimpleMinutes(BaseModel):
    """A meeting's minutes, sent to each attendee (``simple_minutes``)."""

    meeting_id: uuid.UUID
    title: str
    ended_at: dt.datetime | None
    decisions: int
    state: Literal["new", "open"]


SimpleRoadmapItem.model_rebuild()
OnePagerOut.model_rebuild()
