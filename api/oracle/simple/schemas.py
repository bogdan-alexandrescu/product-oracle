"""Simple S2 (#723): the company-wide roadmap read and the date suggestions; S3a: the
change engine's sessions and changes; S3b: working drafts."""

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import ConfigDict, Field, field_validator

from oracle.base_model import BaseModel
from oracle.simple.schemas_meetings import (
    DecisionsView,  # noqa: F401
    DeliveryStatus,  # noqa: F401
    InboxSimpleActionItem,  # noqa: F401
    InboxSimpleMinutes,  # noqa: F401
    MeetingOrigin,  # noqa: F401
    MeetingStatus,  # noqa: F401
    MinutesJobState,  # noqa: F401
    MinutesState,  # noqa: F401
    QuestionColumn,  # noqa: F401
    SimpleActionItemIn,  # noqa: F401
    SimpleActionItemOut,  # noqa: F401
    SimpleAgenda,  # noqa: F401
    SimpleAgendaEditIn,  # noqa: F401
    SimpleAgendaItem,  # noqa: F401
    SimpleAgendaProposal,  # noqa: F401
    SimpleAgendaRow,  # noqa: F401
    SimpleAttendee,  # noqa: F401
    SimpleDecidedFlow,  # noqa: F401
    SimpleDecisionCan,  # noqa: F401
    SimpleDecisionRow,  # noqa: F401
    SimpleDecisionsOut,  # noqa: F401
    SimpleDecisionsWaitingOut,  # noqa: F401
    SimpleDelivery,  # noqa: F401
    SimpleDraftDatesIn,  # noqa: F401
    SimpleDraftRoadmap,  # noqa: F401
    SimpleDraftRoadmapItem,  # noqa: F401
    SimpleEmailDelivery,  # noqa: F401
    SimpleFilterOption,  # noqa: F401
    SimpleMeetingBrief,  # noqa: F401
    SimpleMeetingCan,  # noqa: F401
    SimpleMeetingCommentIn,  # noqa: F401
    SimpleMeetingDecision,  # noqa: F401
    SimpleMeetingGroup,  # noqa: F401
    SimpleMeetingIn,  # noqa: F401
    SimpleMeetingNote,  # noqa: F401
    SimpleMeetingOut,  # noqa: F401
    SimpleMeetingRulesIn,  # noqa: F401
    SimpleMeetingsOut,  # noqa: F401
    SimpleMinutes,  # noqa: F401
    SimpleMinutesIn,  # noqa: F401
    SimpleQuestion,  # noqa: F401
    SimpleQuestionBlocks,  # noqa: F401
    SimpleQuestionCan,  # noqa: F401
    SimpleQuestionFeature,  # noqa: F401
    SimpleQuestionOption,  # noqa: F401
    SimpleQuestionPending,  # noqa: F401
    SimpleQuestionSource,  # noqa: F401
    SimpleRetryDeliveryIn,  # noqa: F401
    SimpleRoadmapDraftItem,  # noqa: F401
    SimpleRoadmapDraftPrd,  # noqa: F401
    SimpleRunGroup,  # noqa: F401
    SimpleRunStepOut,  # noqa: F401
    SimpleRunStopOut,  # noqa: F401
    SimpleSendIn,  # noqa: F401
    SimpleSlackState,  # noqa: F401
    SimpleStartMember,  # noqa: F401
    SimpleStartOptions,  # noqa: F401
    SimpleStartPrd,  # noqa: F401
    SimpleUpcomingMeeting,  # noqa: F401
    SimpleWait,  # noqa: F401
    SimpleWaitingItem,  # noqa: F401
)
from oracle.simple.schemas_roadmap import (
    ChangeOp,
    ChangeStatus,  # noqa: F401
    ChatActionOp,
    DateSource,  # noqa: F401
    DateSuggestionEdit,  # noqa: F401
    DateSuggestionOut,  # noqa: F401
    DraftStatus,  # noqa: F401
    FixKind,  # noqa: F401
    FlagKind,  # noqa: F401
    InboxSimpleApproval,  # noqa: F401
    InboxSimpleChange,  # noqa: F401
    ItemStatus,  # noqa: F401
    MilestoneKind,  # noqa: F401
    MilestoneNumber,  # noqa: F401
    MilestoneProgress,  # noqa: F401
    MilestoneStatus,  # noqa: F401
    PhaseKey,  # noqa: F401
    RoadmapGroup,  # noqa: F401
    SessionKind,  # noqa: F401
    SimpleAppliedVersion,  # noqa: F401
    SimpleChangeConflict,  # noqa: F401
    SimpleChangeIn,  # noqa: F401
    SimpleChangeMeeting,  # noqa: F401
    SimpleChangeOut,
    SimpleChangeResult,
    SimpleDate,  # noqa: F401
    SimpleDecidedRef,  # noqa: F401
    SimpleDecisionIn,  # noqa: F401
    SimpleDocRef,
    SimpleDraftBrief,  # noqa: F401
    SimpleDraftChange,  # noqa: F401
    SimpleDraftOut,  # noqa: F401
    SimpleDraftPrd,  # noqa: F401
    SimpleFlag,  # noqa: F401
    SimpleFlagDependent,  # noqa: F401
    SimpleFlow,
    SimpleFlowNote,  # noqa: F401
    SimpleFlowScreen,  # noqa: F401
    SimpleFlowStep,  # noqa: F401
    SimpleGoalMilestone,  # noqa: F401
    SimpleGoalMilestoneIn,  # noqa: F401
    SimpleGoalMilestonePatch,  # noqa: F401
    SimpleGoalRef,  # noqa: F401
    SimpleGoalWeeks,  # noqa: F401
    SimpleGroup,  # noqa: F401
    SimpleHoliday,  # noqa: F401
    SimpleItemFlags,
    SimpleItemMilestone,  # noqa: F401
    SimpleItemTask,  # noqa: F401
    SimpleKeyDate,  # noqa: F401
    SimpleKeyDateRoadmap,  # noqa: F401
    SimpleLeftOut,
    SimpleMatch,
    SimpleMeetingApproval,  # noqa: F401
    SimpleMeetingRef,  # noqa: F401
    SimpleMergedInto,  # noqa: F401
    SimpleMilestone,  # noqa: F401
    SimpleMilestonePending,  # noqa: F401
    SimpleMilestoneTarget,  # noqa: F401
    SimpleNotApproved,  # noqa: F401
    SimpleOldMilestone,  # noqa: F401
    SimpleOldMilestones,  # noqa: F401
    SimpleOldMilestonesResult,  # noqa: F401
    SimpleOpenDecision,
    SimpleOwnerRef,  # noqa: F401
    SimplePartRef,
    SimplePersonRef,
    SimplePhase,  # noqa: F401
    SimplePlanDecision,  # noqa: F401
    SimplePlanGoal,  # noqa: F401
    SimplePlanGoalTarget,  # noqa: F401
    SimplePlanMilestone,  # noqa: F401
    SimplePlanOut,
    SimplePlanRisk,  # noqa: F401
    SimplePlanSpan,  # noqa: F401
    SimplePrdRef,
    SimpleResumeOut,  # noqa: F401
    SimpleRoadmapItem,
    SimpleRoadmapOut,  # noqa: F401
    SimpleRoadmapTrack,  # noqa: F401
    SimpleRoadmapWaiting,  # noqa: F401
    SimpleSessionIn,  # noqa: F401
    SimpleSessionOut,  # noqa: F401
    SimpleSlice,  # noqa: F401
    SimpleSubmitIn,  # noqa: F401
    SimpleTaskWaiting,  # noqa: F401
    SimpleTrackRef,  # noqa: F401
    SimpleWindow,  # noqa: F401
    SimpleWindows,  # noqa: F401
    SuggestionStatus,  # noqa: F401
)


class RefreshOut(BaseModel):
    open: int = Field(description="Open suggestions after the refresh")


# --------------------------------------------------------------------------- S6 priorities


class SimpleQuarter(BaseModel):
    start: dt.date
    end: dt.date
    # "Q4 2026"
    label: str


class SimplePriorityGoal(BaseModel):
    key: str
    title: str
    # goal-order: the goal's place (its attrs.position, 1 = first); none when unset.
    position: int | None = None


class SimplePriorityAfter(BaseModel):
    """The dependency ranked above a higher-scoring row: "after <code>, which it needs"."""

    code: str
    title: str


class SimplePriorityOverride(BaseModel):
    """The active move or pin that placed a row, and who made it."""

    by_name: str
    reason: str
    at: dt.datetime | None = None


class SimplePriorityTwin(BaseModel):
    """qa-prio-twins: another ranked record of a row's feature, not linked to it (a Ground Truth
    feature of the same name), shown on that row, never as a row of its own: a person merges it
    into the row's record (``merge``) or keeps both; Oracle never merges it."""

    feature_id: str | None = None
    item_id: uuid.UUID | None = None
    code: str
    title: str
    goal: SimplePriorityGoal | None = None
    # Its own rank, were it a row (the name folding is shown, not hidden).
    rank: int | None = None
    # How it merges into the row's record: ``item`` (merge_item of its item into the row's,
    # ``into_id``: both on one roadmap), ``entity`` (the baseline's Merge into… of its feature
    # into the row's: no item, an item on another roadmap, or a row with only a draft); None:
    # the caller may change nothing.
    merge: Literal["item", "entity"] | None = None
    into_id: uuid.UUID | None = None
    # The caller's merge applies (else it is proposed).
    applies: bool = False
    # Why an approver's ``entity`` merge does not apply (merge_twin's 409): one of its items is
    # on a roadmap they do not decide, or beside the kept feature's own item; else None.
    blocked: str | None = None


class SimpleTwinMergeIn(BaseModel):
    """qa-prio-twins: a Same name record's Merge into… ``into`` (the row's feature)."""

    into: uuid.UUID


class SimpleTwinMergeOut(BaseModel):
    """The kept feature, and the item keys of the twin's items now linked to it."""

    feature_id: str
    relinked: list[str] = []


class SimplePriorityRow(BaseModel):
    rank: int
    # Oracle's rank (the formula and dependencies, before people's overrides).
    oracle_rank: int | None = None
    feature_id: str
    item_id: uuid.UUID | None = None
    # The item's key, else the feature's key.
    code: str
    # What a mark on the value/effort 2x2 shows: a short code that never changes with rank, the
    # feature's code (F-12) else 2-3 capitals from the feature's shown name, the same for every
    # reader, unique in the company (a digit added on a clash, in the features' creation
    # order). oracle.simple.priorities.short_codes.
    short_code: str = ""
    # prio-company (Nov 4): the feature's own code (F-12, or its PRD's F-06) shown beside its
    # name; None when it has none (never letters made up from its name).
    own_key: str | None = None
    title: str
    goal: SimplePriorityGoal | None = None
    # The item's own goals in order (Archive and Delete of a goal list it by any of them).
    goal_ids: list[str] = []
    milestone: str | None = None
    horizon: Literal["now", "next", "later"] | None = None
    goal_value: float | None = None
    # Engineer-weeks.
    effort: float | None = None
    score: float | None = None
    # qa-simple-plan-3: Oracle's confidence (0 to 1) the score is worked out with.
    confidence: float | None = None
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
    # A re-plan resized it: its date waits on a new estimate from its owner.
    estimate_pending: bool = False
    # Serves no confirmed goal.
    no_goal: bool = False
    # plan-charts: the item is the PRD's whose plan "this quarter" is (Goal buckets lists the
    # rest outside the plan).
    in_plan: bool = False
    can_reorder: bool = False
    # prio-company (Nov 4): the feature has an item on the company roadmap (else on every
    # roadmap while there is no company roadmap); false: an owner's move adds it there.
    on_roadmap: bool = False
    # The caller's change applies (else it is proposed).
    applies: bool = False
    # feature-parts: the feature this one is part of, as the roadmap reads it (its part_of).
    part_of: "SimplePartRef | None" = None
    # Its own parts, as the roadmap reads them (open or cut), whether this list shows them or not.
    parts: "list[SimplePartRef]" = Field(default_factory=list)
    # The feature's active override as override_priority's ``before.override`` wants it.
    before_override: dict[str, Any] | None = None
    # qa-prio-twins: the feature's draft item on the roadmap when it has no other (it is on the
    # roadmap, not yet confirmed: a move confirms it, never adds a second item).
    draft_item_id: uuid.UUID | None = None
    # qa-prio-twins: the same feature's other ranked records, not linked to it (same name).
    twins: list[SimplePriorityTwin] = Field(default_factory=list)


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
    op: Literal[
        "override_priority", "estimate_feature", "confirm_item", "cut", "merge_item", "merge_twin"
    ]
    # None: a ``merge_twin`` of a twin with no item on the roadmap read.
    item_id: uuid.UUID | None
    # The item's baseline feature (the row it shows under); None for a draft with none; a
    # ``merge_twin``'s twin feature (it shows on that twin).
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
    # qa-simple-plan-30: the caller proposed it and may take it back (POST .../withdraw).
    can_withdraw: bool = False
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
    # The item's own goals in order (Archive and Delete of a goal list it by any of them).
    goal_ids: list[str] = []
    roadmap: SimpleDocRef
    applies: bool = False
    # Non-draft items of the same roadmap, same goal first (at most 8); its row's item first.
    merge_into: list[SimplePriorityMerge] = []
    # qa-prio-twins: the ranked row it shows on, not as a draft of its own: its feature's (by
    # its link: feature_id, else its trace's source feature), else a row of its name's.
    row_feature_id: str | None = None
    # Linked to that row's feature (else only named as it: Merge into… its item).
    linked: bool = False


class SimplePriorityUnranked(BaseModel):
    """prio-unranked: a live, non-draft roadmap item with no ranked feature (none, or one the
    ranking leaves out): listed under the ranked rows, with no score and no rank."""

    item_id: uuid.UUID
    code: str
    title: str
    goal: SimplePriorityGoal | None = None
    # The item's own goals in order (Archive and Delete of a goal list it by any of them).
    goal_ids: list[str] = []
    roadmap: SimpleDocRef


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
    # goal-order: the goal's place (its attrs.position, 1 = first); none when unset.
    position: int | None = None


class SimpleLine(BaseModel):
    """Roadmap-plus: where the line on priorities is drawn. ``now``: this quarter's plan
    (the Now horizon); ``key_date:<id>``, ``milestone:<id>``, ``date:<YYYY-MM-DD>``: planned
    to finish by that day."""

    key: str
    kind: Literal["now", "key_date", "milestone", "date"]
    label: str
    date: dt.date | None = None
    # priorities-keydates: a key date read from a PRD's milestone (SimpleKeyDate.prd), marked
    # "From the PRD"; None: any other line.
    prd: SimpleDocRef | None = None


class SimplePrioritiesOut(BaseModel):
    today: dt.date
    quarter: SimpleQuarter
    method: str
    formula: str
    # In the company's order (rank 1 first).
    rows: list[SimplePriorityRow]
    proposals: list[SimplePriorityProposal]
    drafts: list[SimplePriorityDraft]
    # prio-unranked: the items no row holds, by horizon then position.
    unranked: list[SimplePriorityUnranked] = []
    buckets: list[SimpleGoalBucket]
    weeks_total: float
    # Commenter and up: may reorder and estimate (applies or proposes).
    can_change: bool
    # Roadmap-plus: the line drawn, and the lines offered (Pick a date aside).
    line: SimpleLine | None = None
    lines: list[SimpleLine] = []
    # prio-company (Nov 4): the one roadmap priorities moves; None while there is none.
    company_roadmap: "SimpleDocRef | None" = None
    # plan-charts: the plan "this quarter" is (Goal buckets by milestone); none with no
    # dated plan.
    plan: SimplePlanOut | None = None


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
    # Reads clearly (2026-10-30, oracle.simple.one_pager_checks): an outcome's measure (what
    # is counted) and its source (where), from the PRD; null when the PRD does not say.
    measure: str | None = None
    measure_source: str | None = None
    # The notes of the footnote marks the line keeps ("† Sent once ..."); a mark with no
    # note in the PRD is dropped from the line.
    footnotes: list[str] = []
    # A bet with no flow yet that the caller may ask Oracle to draw ("Draw the flow").
    can_draw_flow: bool = False
    # The line's words before codes got their names and marks with no note were dropped
    # (the Edit box starts from them); null when those changed nothing.
    words: str | None = None


class OnePagerFixProposal(BaseModel):
    """An open proposal of the fix: who made it, and whether the reader decides or
    withdraws it."""

    change_id: uuid.UUID
    by_name: str
    can_decide: bool
    can_undo: bool


class OnePagerFix(BaseModel):
    """A "numbers" item's one-click fix (owner, Nov 5): POST /v1/simple/changes with ``op``
    ``action``, this ``target``, ``before: {number: before}`` and ``after: {number: value}``;
    ``words`` is its button ("Use 6")."""

    action: Literal["set_section_number"]
    # {document_id, section (its key), said (the words the number is in), part ("heading"
    # when the number is in the section's heading; absent: its text)}.
    target: dict[str, str]
    before: str
    value: str
    words: str
    proposal: OnePagerFixProposal | None = None


class OnePagerFixed(BaseModel):
    """A number fix (set_section_number) in the PRD's working draft, read from the draft's
    live changes: its words ('Fixed: set to 6 in “Later · 6 items”') and its Undo."""

    change_id: uuid.UUID
    words: str
    can_undo: bool


class OnePagerLook(BaseModel):
    """One "Needs a look" item for the PRD's owners (numbers that disagree, a code with no
    name): what to look at, and the sections it is in. Shared by the one-pager's checks."""

    kind: str
    text: str
    where: list[str] = []
    source_keys: list[str] = []
    # A "numbers" item's fix; null for other items and a number in no section's text.
    fix: OnePagerFix | None = None


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
    # The problem block: who has it, from the PRD's users or personas section; null when
    # the PRD has none ("Who has it is not in the PRD yet").
    who: str | None = None
    # Oracle marked it "Not in the PRD yet": nothing of the PRD maps to it (oracle.simple.quality).
    missing: bool = False


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
    # A working draft: who approves it once sent (the PRD's required reviewers); the owner
    # may add more when sending (build-review: Send for approval…).
    reviewers: list[SimplePersonRef] = []
    can_submit: bool
    # inbox-prd-approval-open: submitted, and the caller's approval is one it waits for.
    can_approve: bool = False
    # Remind (owner, 2026-10-26): the last nudge to a waiting reviewer, and whether the
    # caller (the PRD's owners, its decider) may nudge one now (each at most once a day).
    reminded_at: dt.datetime | None = None
    can_remind: bool = False

    # S8: the meeting the decider approved it in ("Approved in <meeting title>").
    approved_in: str | None = None
    # What else, besides ``waiting_on``, holds a decider-approved draft back (#723 review:
    # "Sections Scope need a reviewer"), as the meeting's banner says it.
    blocked_by: list[str] = []
    # decisions-reversed-or-trashed: decisions this draft cited that were reversed since
    # ("D-4 Cut bulk export was reversed on Nov 3: ...").
    decision_notes: list[str] = []


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
    # The one-pager: its roadmap items' ids (OnePagerOut.timeline), each once, in plan order.
    item_ids: list[uuid.UUID] = []
    # The one-pager: the milestone's roadmap-wide code, the one the Roadmap read gives it
    # (``roadmap_code``, roadmap-milestone-codes), which ``name`` leads with ("M2 · Beta");
    # null when it is no roadmap milestone (``name`` is then its name alone) or not a milestone.
    code: str | None = None


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


class OnePagerInReview(BaseModel):
    """One change in review a reader may not see in full (build-review): a line change in
    the PRD's draft or someone's proposal, in the same words its margin note would use."""

    line_id: str
    kind: Literal["change", "proposal"]
    before: str
    after: str
    by_name: str
    # A change: whom its submitted draft waits on (none while the draft is working); a
    # proposal: whom it is routed to.
    waiting_on: list[SimplePersonRef]


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
    # The one_pager job is writing the page: until it is done the reader gets the quick read
    # (the page says so in one quiet line).
    writing: bool = False
    built_at: dt.datetime
    blocks: list[OnePagerBlock]
    # The timeline strip: the PRD's slice of the Simple roadmap (the span is its ends).
    timeline: list[OnePagerItem]
    # The Timeline block's strip: the PRD's span by month and its milestones (no per-item
    # bars); None with no roadmap items.
    plan: SimplePlanStrip | None = None
    sections: list[OnePagerSource] = []
    # The lines' decided decisions left out as no longer standing, named in one line.
    left_out: "SimpleLeftOut | None" = None
    notes: list[OnePagerNote]
    draft: OnePagerDraft | None
    # Drafts and proposals the reader may not see (the count only).
    changes_in_review: int
    # The same changes, one per line change or proposal (build-review); empty for people
    # who see the draft itself.
    in_review: list[OnePagerInReview] = []
    # Owners and the decider change lines directly (Undo); approvers and commenters
    # propose; viewers read.
    can_edit: bool
    can_propose: bool
    # Start review: the start API's own rule (meetings.may_start: an owner or the decider).
    can_start: bool
    # "Needs a look", for owners only (empty for everyone else): the PRD's numbers that
    # disagree and its codes with no name (the PRD's owners; ad-onepager), and the checks a
    # build held for owners failed twice (kind "check"; oracle.simple.quality).
    needs_look: list[OnePagerLook] = []
    # The working draft's number fixes, for those who see the draft (fix round 2).
    fixed: list[OnePagerFixed] = []


# --------------------------------------------------------------------------- S7


class SimpleGoalBrief(BaseModel):
    id: str
    key: str
    title: str
    # goal-order: the goal's place (its attrs.position, 1 = first); none when unset.
    position: int | None = None


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
    # oracle.simple.quality: Oracle's suggestion failed its checks twice (owners only; people
    # below owner do not see it).
    needs_look: list[str] = []


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

# "declined" is read, never stored: a proposed card whose proposal was declined (chat.cards_out).
CardStatus = Literal["open", "applied", "proposed", "declined", "discarded", "undone"]
ChangeMode = Literal["everyone", "presenter", "named"]


# ask-length-limit: a long change request (a pasted list of changes) fits.
CHAT_TEXT_MAX = 4000


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=CHAT_TEXT_MAX)
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
    # roadmap-talk: the change in words ({before, after}) and, while open, what Correct
    # opens ({fields, values}: Oracle's reading, prefilled); None off the roadmap.
    change_words: dict[str, str | None] | None = None
    correct: dict[str, Any] | None = None
    # fix5-cut-dependents: an open cut's dependents, the titles of every item that waits on
    # it (transitively) and is not cut: what "Cut it and its dependents" cuts with it.
    dependents: list[str] = []
    # Their ids, in the same order: the apply sends them back (``ChatApplyIn.dependents``).
    dependent_ids: list[uuid.UUID] = []
    # Review major: what "Cut it and its dependents" does for the reader: "apply" when they
    # decide every item it cuts, "propose" when not, None when they may not (``why_not``).
    may_with_dependents: Literal["apply", "propose"] | None = None
    # qa4-simple-decide-1: an applied card the reader may undo (Apply's own rule).
    can_undo: bool = False
    # walkc-meeting: who Propose asks (an open card the reader proposes), or who a proposed
    # card went to, by name; in a meeting its deciders. ``asks_outside``: nobody in the
    # meeting may decide, so Propose asks these people outside it.
    asks: list[str] = []
    asks_outside: bool = False
    # walkc-meeting review: who "Propose: cut it and its dependents" asks, by every item
    # it cuts (changes.cut_route), and whether that is outside the meeting.
    asks_with_dependents: list[str] = []
    asks_with_dependents_outside: bool = False
    # meeting-changes-only-its-agenda: in a meeting, the card's item is not on its agenda:
    # "Delivery integrity is on another roadmap: sent to its owner to decide".
    elsewhere: str | None = None
    # chat-latest-card: a newer card in the chat replaced this one (its id): an open card
    # is no longer actionable; an applied one keeps its Undo.
    replaced_by: uuid.UUID | None = None


class ChatChoiceOut(BaseModel):
    index: int
    label: str


ChatKind = Literal["request", "cards", "question", "answer", "note", "pending", "failed", "ask"]


class ChatLinkOut(BaseModel):
    label: str
    href: str


class ChatLiveReadOut(BaseModel):
    """A live read of the asker's source an answer used (#710's live citation): its chip."""

    ref: str
    source: str
    call: str
    read_at: dt.datetime
    item_id: str | None = None


class ChatMessageOut(BaseModel):
    id: uuid.UUID
    author_kind: Literal["person", "oracle"]
    author_id: uuid.UUID | None
    author_name: str
    body: str
    at: dt.datetime
    # pending: Oracle's reader is reading the line; failed: it could not (``retry``); ask:
    # a question for Oracle's Ask (the Ask panel's one box hands the line there).
    kind: ChatKind
    cards: list[ChatCardOut]
    reply_to: uuid.UUID | None = None
    # A question's clickable choices ("Neither" last); ``picked``: the one taken.
    choices: list[ChatChoiceOut] = Field(default_factory=list)
    picked: int | None = None
    retry: bool = False
    # spent-pool: a line that failed on a spent Claude pool, when its window clears (the
    # thread then reads Retry); None otherwise.
    retry_after: dt.datetime | None = None
    # roadmap-talk: where an item talk's answer comes from ("From the PRD · F-06 …").
    source: str | None = None
    # ask-length-limit: where a part Oracle cannot change yet is changed (Priorities, Roadmap).
    links: list[ChatLinkOut] = Field(default_factory=list)
    # #710 in Simple: the live reads an Ask panel answer used (each a live chip).
    live_reads: list[ChatLiveReadOut] = Field(default_factory=list)


class ChatRulesOut(BaseModel):
    change_mode: ChangeMode
    change_people: list[SimplePersonRef]
    presenter: SimplePersonRef
    is_presenter: bool
    may_apply: bool
    ask_only: bool
    ended: bool
    # meet-chat-right-prd: when the meeting ended and who ended it, or ``ended_by_itself``
    # (its time ran out with nobody ending it).
    ended_at: dt.datetime | None = None
    ended_by: SimplePersonRef | None = None
    ended_by_itself: bool = False


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
    # The chat's first question (the person's first line, in it or in the Oracle's Ask chat
    # it handed it to): Recent chats names each chat by it (ask-panel fidelity, pick C).
    question: str | None = None


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
    # roadmap-talk's Correct: the card's fields as the person corrected them (its
    # ``correct.fields``: title, goal, milestone, start_date, end_date, owner).
    values: dict[str, str | None] | None = None
    # fix5-cut-dependents: a cut card applies as cut_with_dependents (the card's dependents
    # cut with it, one change).
    with_dependents: bool = False
    # With it, the ids of the dependents the card listed (``ChatCardOut.dependent_ids``): a
    # roadmap that has changed since is 409, so nothing unseen is cut.
    dependents: list[uuid.UUID] | None = None


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


SimpleRoadmapItem.model_rebuild()
OnePagerOut.model_rebuild()


# --------------------------------------------------------------------------- removed-tracks


class SimpleRemovedItem(BaseModel):
    """Something removed in Simple, to put back: a cut feature, an archived goal or a removed
    goal milestone, with who removed it and when."""

    kind: Literal["feature", "goal", "milestone"]
    # The roadmap item's, the goal entity's or the milestone's id.
    id: uuid.UUID
    title: str
    # Where it was: the feature's roadmap, "Goals", the milestone's goal.
    where: str
    at: dt.datetime | None = None
    by_name: str | None = None
    # The reader puts it back directly; else it is proposed to ``decider_name``.
    can_decide: bool = False
    decider_name: str | None = None
    roadmap_id: uuid.UUID | None = None


class SimpleRemovedList(BaseModel):
    items: list[SimpleRemovedItem]


class SimpleTrackRow(BaseModel):
    id: uuid.UUID
    title: str
    status: Literal["active", "paused", "closed"]
    owner_id: uuid.UUID | None = None
    owner_name: str | None = None
    # tracks-goal: a track holds many PRDs (``prds``, in the order they joined; ``prd_id``
    # and ``prd_title`` are the first), or none, and may be tied to one company goal.
    prd_id: uuid.UUID | None = None
    prd_title: str | None = None
    prds: list["SimplePrdRef"] = []
    goal_id: uuid.UUID | None = None
    goal_name: str | None = None
    # The reader edits or deletes it directly; else it is proposed to ``decider_name``.
    can_decide: bool = False
    decider_name: str | None = None
    # Its live features over the whole roadmap (cut and merged ones left out), whatever
    # the roadmap's filters show.
    feature_count: int = 0
    # Every feature on it, cut and merged ones too: what Move to Trash sends to no track.
    moves_count: int = 0
    # Of ``moves_count``, those still on it in the published version that the reader's draft
    # moved to another track or none (Move to Trash clears them there too).
    draft_off_count: int = 0
    # track-order (owner Nov 9): its place number in the company's track order (lower first;
    # none: after every numbered one, oldest first), which Move up and Move down change (op
    # ``move_track``). The list comes in that order.
    order: int | None = None


class SimplePerson(BaseModel):
    id: uuid.UUID
    name: str


class SimpleTracks(BaseModel):
    tracks: list[SimpleTrackRow]
    # The reader adds a track directly; else it is proposed to ``add_decider_name``.
    can_add: bool = False
    add_decider_name: str | None = None
    # Who can own a track (enabled members), and the PRDs a track can take (tracks-goal: one
    # on another track names it, and moves from it).
    people: list[SimplePerson]
    prds: list["SimpleTrackPrdChoice"]
    # tracks-goal: the company's goals a track may be tied to, by name.
    goals: list["SimpleTrackGoal"] = []


class SimpleTrackGoal(BaseModel):
    id: uuid.UUID
    name: str


class SimpleTrackPrdChoice(BaseModel):
    """tracks-goal: an accepted PRD a track can take, with the track it is on now."""

    id: uuid.UUID
    title: str
    track_id: uuid.UUID | None = None
    track_title: str | None = None


class InboxSimpleDateSuggestion(BaseModel):
    """inbox-meeting-proposals fix: Oracle's open date suggestion on an item I may decide
    (``simple_date_suggestions``, counted in ``total``): one row per item, its slices'
    span; decided on the item's roadmap."""

    id: uuid.UUID
    item_id: uuid.UUID
    item_title: str
    # The item's roadmap (where it is decided).
    document_id: uuid.UUID
    start_date: dt.date
    end_date: dt.date
    basis: str
    at: dt.datetime
    state: Literal["new", "open"]


class InboxSimpleTrackSuggestion(BaseModel):
    """tracks-goal (owner Nov 9): a newly accepted PRD of mine on no track. Oracle suggests
    the existing track that fits it best (``track``; none fits: null); Confirm puts the PRD
    on it, Pick a track on one of ``tracks``, New track starts one (each through the change
    engine: ``edit_track`` with ``add_prd_id``, ``add_track``)."""

    id: uuid.UUID
    prd: "SimplePrdRef"
    track: "SimpleTrackChoice | None" = None
    tracks: list["SimpleTrackChoice"] = []
    at: dt.datetime
    state: Literal["new", "open"]
    # A track someone else decides was asked for: it waits for them (no actions, not
    # counted) until they accept (the item leaves) or decline (the suggestion is back).
    proposed: "SimpleTrackProposed | None" = None


class SimpleTrackChoice(BaseModel):
    id: uuid.UUID
    title: str


class SimpleTrackProposed(BaseModel):
    """The open proposal a track suggestion waits for: which track (``title`` of a new
    one), and whom it waits for."""

    change_id: uuid.UUID
    track: SimpleTrackChoice | None = None
    title: str
    to_name: str | None = None


class InboxSimpleGoalSuggestion(BaseModel):
    """inbox-meeting-proposals fix: an open feature suggested for a goal whose suggestions
    I decide (``simple_goal_suggestions``, counted in ``total``)."""

    id: uuid.UUID
    goal: SimpleGoalBrief
    title: str
    outcome: str
    # Oracle suggested it; else a person did (``proposed_by_name``).
    from_oracle: bool
    proposed_by_name: str | None = None
    # The goal's roadmap, where its suggestions are decided (none: no roadmap yet).
    document_id: uuid.UUID | None = None
    at: dt.datetime
    state: Literal["new", "open"]
