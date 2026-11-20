"""Simple S2 (#723): the company-wide roadmap read and the date suggestions; S3a: the
change engine's sessions and changes; S3b: working drafts."""

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import ConfigDict, Field, field_validator, model_validator

from oracle.base_model import BaseModel
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
    SimpleDraftOut,
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
    SimpleNotApproved,
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
    SimpleTaskWaiting,
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
    # The presenter's roll call: false once marked away.
    present: bool = True
    # walkc-meeting r2 (5a): false while an invited attendee has not pressed Join.
    joined: bool = True


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


DeliveryStatus = Literal["queued", "sent", "retrying", "failed"]


class SimpleEmailDelivery(BaseModel):
    """One attendee's minutes email: queued, sent, retrying (a try failed, another is due
    on the tick) or failed (three tries failed; Retry requeues it)."""

    person: SimplePersonRef
    status: DeliveryStatus


class SimpleDelivery(BaseModel):
    decisions: bool = True
    inbox: bool = True
    # chosen by whoever ended the meeting; email_status: queued, sent, retrying (some
    # attendee's is tried again), failed (some attendee's did not go) or unavailable.
    email: bool = False
    email_status: str | None = None
    # Each attendee's email, and how many went.
    emails: list[SimpleEmailDelivery] = []
    email_sent: int = 0
    slack: bool = False
    # queued, sent, retrying or failed.
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
    # Whoever ended the meeting or an owner retries a failed email or Slack post.
    retry_delivery: bool = False
    # agenda-sheet: an owner or the PRD's decider changes the agenda; an approver who is
    # not the decider proposes; others read.
    edit_agenda: bool = False
    propose_agenda: bool = False


class SimpleMeetingNote(BaseModel):
    """chat-actions: a minutes note or open question added during the meeting; also a
    comment (qa-simple-decide-1), which is not a meeting decision and stays out of
    minutes."""

    id: str
    kind: Literal["note", "question", "comment"]
    text: str
    by_name: str
    at: dt.datetime | None = None
    card_id: uuid.UUID | None = None


class SimpleAgendaItem(BaseModel):
    id: uuid.UUID
    title: str


class SimpleAgendaRow(BaseModel):
    """agenda-sheet: one row of the meeting's agenda: a feature of its PRD or a topic a
    person typed, with its minutes; ``state`` reads the chat's next and skip."""

    id: str
    kind: Literal["feature", "topic"]
    feature_id: uuid.UUID | None = None
    title: str
    mins: int
    by_name: str | None = None
    state: Literal["done", "now", "next", "skipped"]


class SimpleAgendaProposal(BaseModel):
    """agenda-sheet: an approver's agenda changes waiting for the meeting's decider."""

    by: SimplePersonRef
    decider: SimplePersonRef | None = None
    words: list[str] = []
    # The proposer's earlier ops whose item is gone since, as words: dropped, not proposed.
    dropped: list[str] = []


class SimpleAgenda(BaseModel):
    """chat-actions: the item the meeting takes next and the items it skips.
    agenda-sheet: the rows in order, the PRD's features not on it yet, what the last batch
    of the sheet did (for its Undo line) and an approver's waiting proposal."""

    next: SimpleAgendaItem | None = None
    skipped: list[SimpleAgendaItem] = []
    items: list[SimpleAgendaRow] = []
    addable: list[SimpleAgendaItem] = []
    batch: str | None = None
    words: list[str] = []
    # The accepted proposal's ops whose item was gone, as words: left out of the batch.
    left_out: list[str] = []
    # port-an-decisions: the batch removed items that wait in Settings › Trash (Open Trash).
    in_trash: bool = False
    proposal: SimpleAgendaProposal | None = None
    # Who decides what an approver proposes: the PRD's decider (none: an owner).
    decider: SimplePersonRef | None = None


class SimpleAgendaEditIn(BaseModel):
    """agenda-sheet: one op of the Agenda sheet. ``batch`` names the sheet's opening, so
    Undo puts back the agenda as it was when that batch began."""

    op: Literal["add", "rename", "move", "remove", "undo", "accept", "withdraw"]
    item_id: str | None = Field(default=None, max_length=64)
    feature_id: uuid.UUID | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)
    to: int | None = Field(default=None, ge=0, le=200)
    batch: str | None = Field(default=None, max_length=64)


class SimpleDraftRoadmapItem(BaseModel):
    """An item of the run's draft roadmap with its dates: not on the roadmap yet."""

    id: uuid.UUID
    key: str
    title: str
    horizon: str
    start: dt.date
    end: dt.date


class SimpleDraftRoadmap(BaseModel):
    """The run's draft roadmap of the meeting's PRD (RP2, 'Meeting step as draft'): its
    dated items, shown hatched in the Roadmap step until the meeting approves the dates."""

    items: list[SimpleDraftRoadmapItem]
    # Once this meeting approved the dates (no draft left): how many items it put on the
    # roadmap, so the step says so after a reload too; null while the dates are draft.
    approved: int | None = None


class SimpleRoadmapDraftItem(SimpleDraftRoadmapItem):
    """A dated item of a draft PRD on the Simple roadmap's draft layer, with its owner."""

    owner_name: str | None = None


class SimpleRoadmapDraftPrd(BaseModel):
    """RP2 'Draft layer on roadmap': a PRD whose run's draft roadmap holds dated items not
    approved yet, shown hatched over the roadmap until the PRD is approved."""

    prd: SimpleDocRef
    run_id: uuid.UUID | None = None
    items: list[SimpleRoadmapDraftItem]
    # The reader may Change dates and Leave out (approvers and up).
    can_change: bool = False


class SimpleDraftDatesIn(BaseModel):
    """Change dates on a draft item: it stays draft."""

    start: dt.date
    end: dt.date

    @model_validator(mode="after")
    def _ordered(self) -> "SimpleDraftDatesIn":
        if self.end < self.start:
            raise ValueError("the end comes before the start")
        return self


class SimpleMeetingOut(SimpleMeetingBrief):
    session_id: uuid.UUID
    occurrence_id: uuid.UUID | None = None
    change_mode: ChangeMode
    change_people: list[SimplePersonRef] = []
    roadmap_ids: list[uuid.UUID] = []
    meeting_decisions: list[SimpleMeetingDecision] = []
    open_decisions: list[SimpleOpenDecision] = []
    # prd-questions: the agenda's "Decisions due": the PRD's open questions that block the
    # milestone the soonest one blocks, soonest first, with those decided in this meeting.
    decisions_due: "list[SimpleQuestion]" = []
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
    # RP2: the run's draft roadmap of the PRD (dated, not approved); None without one.
    draft_roadmap: SimpleDraftRoadmap | None = None


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
    # What the ritual reviews when all of it is in Trash ("roadmap": a roadmap refresh while
    # every roadmap is in Trash); Home says so and links the ritual's settings.
    reviews_in_trash: Literal["roadmap"] | None = None
    # What the ritual reviews when all of it was deleted for good (purged from Trash, none
    # left); Home says "Its roadmap was deleted" and links the ritual's settings.
    reviews_deleted: Literal["roadmap"] | None = None
    # home-deleted-roadmap: when it was deleted for good (its last purge); Home shows the day.
    reviews_deleted_at: dt.datetime | None = None


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


class SimpleStartMember(SimplePersonRef):
    # qa4-simple-decide-14: whether this person's role may change things in a review's
    # chat in any mode (a viewer never may), so the sheet offers only them.
    can_change: bool


class SimpleStartOptions(BaseModel):
    prds: list[SimpleStartPrd]
    members: list[SimpleStartMember]
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
    # meeting-changes-only-its-agenda: the roadmap it reviews (slug or id), when the PRD's
    # items are on several; else the one they are on.
    roadmap: str | None = Field(default=None, max_length=200)
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


class SimpleRetryDeliveryIn(BaseModel):
    what: Literal["email", "slack"]


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
    # prd-questions: a PRD's question keeps its code ("Q10"); a decided one, its answer.
    code: str | None = None
    # QA (unique codes): a PRD's question names its PRD (one the reader reads).
    prd_title: str | None = None
    chosen: str | None = None
    # edit-decisions (ec1 b): every field the sheet shows and changes, what the reader may
    # do there, and the last change made from it.
    question: str | None = None
    context: str | None = None
    options: list["SimpleQuestionOption"] = []
    review_at: dt.date | None = None
    can: "SimpleDecisionCan | None" = None
    edited_at: dt.datetime | None = None
    edited_by: SimplePersonRef | None = None


class SimpleMeetingGroup(BaseModel):
    meeting: SimpleMeetingBrief
    minutes: SimpleMinutes | None
    decisions: list[SimpleDecisionRow]
    # qa4-simple-decide-32: the meeting's notes and comments, as its minutes list them.
    notes: list[SimpleMeetingNote] = []
    # How the sent minutes went out (email, Slack), and whether the caller may Retry.
    delivery: SimpleDelivery | None = None
    can_retry_delivery: bool = False


class SimpleFilterOption(BaseModel):
    id: str
    title: str


QuestionColumn = Literal["needs_input", "recommended", "decided"]
DecisionsView = Literal["list", "board", "meetings"]


class SimpleQuestionOption(BaseModel):
    key: str
    label: str


class SimpleQuestionFeature(BaseModel):
    code: str
    title: str


class SimpleQuestionBlocks(BaseModel):
    """What the question blocks: a milestone of the PRD's plan and its features."""

    milestone: str | None = None
    milestone_name: str | None = None
    features: list[SimpleQuestionFeature] = []
    # "Blocks M1: F-03 Health log" (the owner's words).
    label: str


class SimpleQuestionPending(BaseModel):
    """A proposed answer waiting for the decider (a change through the engine)."""

    change_id: uuid.UUID
    by: SimplePersonRef
    answer: str


class SimpleQuestionCan(BaseModel):
    # Applies at once (owners and the decider, with Undo).
    decide: bool = False
    # Proposes to the decider (approvers and commenters).
    propose: bool = False
    # Names the decider (owners and the decider; others propose).
    name_decider: bool = False
    # edit-decisions (eq2 b): changes its text, recommendation and other answers at once
    # (owners and the decider; ``propose`` suggests the change instead); withdraws it (the
    # "not now", with Undo); deletes it to Trash.
    edit: bool = False
    withdraw: bool = False
    delete: bool = False


class SimpleDecisionCan(BaseModel):
    """edit-decisions (ec1 b): what the reader may do on an open decision's sheet, from
    the decision's own rights (its creator, its decider or an owner edits, withdraws and
    deletes; owners reassign; another commenter or approver proposes an edit)."""

    edit: bool = False
    propose: bool = False
    withdraw: bool = False
    delete: bool = False
    reassign: bool = False


class SimpleQuestionSource(BaseModel):
    """Where Oracle read the question: the PRD's approved version, and when."""

    version: int | None = None
    read_at: dt.datetime | None = None


class SimpleQuestion(BaseModel):
    """prd-questions: one of a PRD's open questions, read in as a decision (origin
    ``prd``): the PRD's code (Q7), its recommendation and alternatives, what it blocks,
    its due day and decider."""

    id: uuid.UUID
    number: int
    code: str
    title: str
    status: str
    column: QuestionColumn
    prd: SimpleDocRef
    decider: SimplePersonRef | None = None
    # What is missing for a "Needs input" question: "decider" or "recommendation".
    missing: Literal["decider", "recommendation"] | None = None
    due_on: dt.date | None = None
    # "Late · due Fri Nov 6" or "Due Fri Nov 27" (company days); None when decided.
    due_label: str | None = None
    late: bool = False
    blocks: SimpleQuestionBlocks | None = None
    recommendation: str | None = None
    alternatives: list[SimpleQuestionOption] = []
    chosen: str | None = None
    decided_at: dt.datetime | None = None
    decided_by: SimplePersonRef | None = None
    # "Decided on Fri Oct 23 by Ana Lee" or "Decided in the PRD on Fri Oct 23 by Ana Lee".
    decided_label: str | None = None
    waiting_for_me: bool = False
    pending: SimpleQuestionPending | None = None
    can: SimpleQuestionCan = SimpleQuestionCan()
    # "From Guided setup draft 3 · read Oct 22": the version it was read from.
    source: SimpleQuestionSource | None = None
    # A live review meeting's agenda: the change that decided it in this meeting, for its
    # Undo (only who made it, while the meeting runs).
    undo_id: uuid.UUID | None = None
    # edit-decisions: the last change made from the sheet, who and when ("Edited by you
    # just now").
    edited_at: dt.datetime | None = None
    edited_by: SimplePersonRef | None = None


class SimpleRunStepOut(BaseModel):
    """One decision at a run's stop: what was done ("Sent back", "Approved"), by whom, the
    day (the company's) and the note given."""

    what: str
    who: str | None = None
    day: dt.date | None = None
    note: str | None = None


class SimpleRunStopOut(BaseModel):
    """build-rundecide RD1 a: one stop of a run as a decision row: "Engineering check:
    approved after a change", the person's name, their role, the note and the day. `trail`
    lists every step when the stop was sent back before it was approved. `dates_changed`:
    how many dates the approver changed at a Dates stop (eng_dates) before approving it,
    "Approved with one date changed"; 0 for every other stop."""

    checkpoint_id: uuid.UUID
    kind: str
    stop: str
    outcome: str
    dates_changed: int = 0
    who: str | None = None
    role: str | None = None
    day: dt.date | None = None
    note: str | None = None
    trail: list[SimpleRunStepOut] = []


class SimpleRunGroup(BaseModel):
    """build-rundecide RD1 a: one run's decided stops, in order, under its name and PRD
    ("Usage alerts plan · Usage alerts PRD · 5 decisions")."""

    run_id: uuid.UUID
    name: str
    prd: SimpleFilterOption | None = None
    stops: list[SimpleRunStopOut]


class SimpleDecisionsOut(BaseModel):
    """Simple's Decisions (direction B "By meeting"): the meetings' decisions grouped under
    them, newest first, then the decisions taken outside meetings. prd-questions: the
    PRDs' open questions as decisions (List and Board), the person's remembered view and
    how many of Oracle's run approvals Simple leaves to Detailed."""

    meetings: list[SimpleMeetingGroup]
    other: list[SimpleDecisionRow]
    prds: list[SimpleFilterOption]
    goals: list[SimpleFilterOption]
    meeting_options: list[SimpleFilterOption]
    # Open first, soonest due first; decided after, newest first.
    questions: list[SimpleQuestion] = []
    waiting_count: int = 0
    late_count: int = 0
    # Oracle's own run approvals waiting for this person (shown in Detailed only).
    approvals_waiting: int = 0
    # One of them, for the page's foot ("D-12 Approve Baseline confirm").
    approvals_example: str | None = None
    view: DecisionsView = "list"
    # build-rundecide RD1 a: the runs' decided stops, one group per run, newest run first.
    runs: list[SimpleRunGroup] = []


class SimpleWaitingItem(BaseModel):
    """home-decisions-one-list: one thing waiting on the signed-in person
    (oracle.simple.waiting_list): what it is, its action in words and where it is done."""

    kind: Literal[
        "run_stop",
        "question",
        "decision",
        "broken_link",
        "date",
        "draft",
        "proposal",
        "goal_suggestion",
        "goal",
        # The Inbox's other counted "Needs you" rows (Add predictions, launches, rituals,
        # metrics, requests), opened where the Inbox opens them.
        "inbox",
    ]
    # Unique in the list (kind and id); ``ref_id`` is the id its own endpoint acts on (the
    # checkpoint, question, decision's number, item, date suggestion, draft, change, goal
    # suggestion or proposed goal).
    key: str
    ref_id: str
    title: str
    detail: str = ""
    action: str
    href: str
    at: dt.datetime | None = None
    # A proposal's change operation (Accept/Decline act on it through /v1/simple/changes).
    op: str | None = None


class SimpleDecisionsWaitingOut(BaseModel):
    """prd-questions: the one list Home's "Decisions waiting for you", the rail's count and
    the review meeting's "Decisions due" read: product decisions waiting for this person
    (the PRDs' open questions and other judgement calls), never Oracle's run approvals."""

    count: int
    late: int
    questions: list[SimpleQuestion] = []
    # Other product decisions (not a PRD's question) waiting for this person.
    others: int = 0
    approvals_waiting: int = 0
    # walkc-roadmap-tasks: the open item tasks this person owns (due first; not counted in
    # ``count``, which is decisions only).
    tasks: list[SimpleTaskWaiting] = []
    # home-decisions-one-list: everything waiting on this person (run stops, questions,
    # decision-log calls, broken links, dates, drafts, proposals, goal suggestions), each
    # with its action.
    items: list[SimpleWaitingItem] = []


class InboxSimpleMinutes(BaseModel):
    """A meeting's minutes, sent to each attendee (``simple_minutes``)."""

    meeting_id: uuid.UUID
    title: str
    ended_at: dt.datetime | None
    sent_at: dt.datetime | None
    decisions: int
    state: Literal["new", "open"]


SimpleRoadmapItem.model_rebuild()
OnePagerOut.model_rebuild()


SimpleMeetingOut.model_rebuild()
SimpleDecisionRow.model_rebuild()


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
