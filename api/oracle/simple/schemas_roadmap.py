"""Simple S2 (#723): the company-wide roadmap read and the date suggestions; S3a: the
change engine's sessions and changes; S3b: working drafts."""

import datetime as dt
import uuid
from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from oracle.base_model import BaseModel

DateSource = Literal["typed", "accepted", "engineering", "tracker", "estimated"]
RoadmapGroup = Literal["goal", "track", "prd"]
PhaseKey = Literal["discover", "build", "beta", "launch"]
FlagKind = Literal[
    "dependency_order",
    "blocker_date",
    "outside_milestone",
    "cut_with_dependents",
    "draft_without_owner",
    "depends_on_draft",
]
FixKind = Literal[
    "shift_dependents", "move_dependency", "accept_risk", "restore", "remove_dependency"
]
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


class SimpleFlagDependent(BaseModel):
    """An item not cut or done that depends on a cut item, wherever the view's filters are."""

    id: uuid.UUID
    title: str
    # The reader decides that item (else its Remove the dependency is a proposal).
    can_decide: bool = False


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
    # qa-simple-home-1: the items "Move the dependents" (shift_dependents) moves, the
    # flagged item first, as the change engine moves them; empty for other flags.
    moves: list[uuid.UUID] = []
    # roadmap-decide review: cut_with_dependents' live dependents across the whole roadmap
    # (one a filter hides too), each with its own Remove the dependency; empty otherwise.
    dependents: list[SimpleFlagDependent] = []


class SimpleRoadmapWaiting(BaseModel):
    """roadmap-decide review: the light count the side menu reads: the broken links of the
    whole roadmap as the reader sees it (the working draft's to who sees it), and the dates
    the reader may confirm in it (Needs a decision's Dates to confirm)."""

    broken_links: int
    dates_to_confirm: int


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
    # goal-order: the goal's place (its attrs.position, 1 = first); none when unset.
    position: int | None = None
    # one-feature-panel: its target and date, as the goal bucket edit reads and writes them
    # (the panel edits how it is measured through that edit, which takes the whole goal).
    target: str | None = None
    due: dt.date | None = None
    # build-feature-panel (AN PR 1204): the goal's latest reading and its unit (attrs.current,
    # attrs.unit), for the panel's Reading row ("Today 61% · target 70% by Jun 30, 2027").
    current: float | None = None
    unit: str | None = None


class SimpleTrackRef(BaseModel):
    id: uuid.UUID
    title: str
    # tracks-goal: the company goal the track replaces as the Roadmap's band.
    goal_id: uuid.UUID | None = None
    goal_name: str | None = None
    # track-order (owner Nov 9): the track's place number in the company's track order (lower
    # first; none: after every numbered one), so a picker of tracks lists them in that order.
    order: int | None = None


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
    # item-milestone: the roadmap milestone picked for it in its panel (a goal milestone of its
    # roadmap, ``SimpleGoalMilestone.id``); it wins over the PRD plan's placement.
    id: uuid.UUID | None = None


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
    # prd-timeline: what kind of work it is ("New for people", "Behind the scenes"), a plain
    # one-line "what it does" and its flow's step names, when the PRD's features list says.
    kind: str | None = None
    what: str | None = None
    flow_steps: list[str] = []


class SimplePlanSpan(BaseModel):
    """plan-model: first milestone start to last milestone end, "Nov 2 - Feb 12"."""

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
    # prd-timeline: its open decisions and its risks in plain words, as the PRD states them.
    decisions: list["SimplePlanDecision"] = []
    risks: list["SimplePlanRisk"] = []
    # fidelity prd (the owner's pick D, 2026-10-28): why this milestone comes now, in the
    # PRD's words (null: the PRD does not say).
    why: str | None = None


class SimplePlanDecision(BaseModel):
    """prd-timeline: an open decision a milestone waits on ("Q7 Legal input"), with the
    PRD's recommendation and its due day (the PRD's, else the PRD question's as Oracle reads
    it; null: no day yet)."""

    code: str
    title: str
    recommendation: str | None = None
    due_on: dt.date | None = None


class SimplePlanRisk(BaseModel):
    """fidelity prd: a risk a milestone carries, as the PRD's risks table states it: its
    code ("R-3"), the risk in one sentence, how likely and how big (the PRD's words, "medium",
    "high") and what we do about it."""

    code: str | None = None
    title: str
    likelihood: str | None = None
    impact: str | None = None
    what_we_do: str | None = None


class SimplePlanGoalTarget(BaseModel):
    milestone: str
    target: str


class SimplePlanGoal(BaseModel):
    name: str
    targets: list[SimplePlanGoalTarget] = []
    # prd-timeline: what is measured now (null: nothing measures it yet) and whether that is
    # on track for the current milestone's target.
    measured: str | None = None
    on_track: bool | None = None


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
    # fidelity prd (the owner's pick B, the When strip): the PRD's summary lines (its
    # Summary section's bullets, "**Goal: ...** ..."), shown above the timeline.
    summary: list[str] = []


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
    # every-field-editable: where a code no one gives comes from: its Ground Truth feature
    # ("feature") or its PRD section ("prd"), so set_code refuses it; null for an item's own.
    code_from: Literal["feature", "prd"] | None = None
    # gt-proposed: its Ground Truth feature a run only proposed (or one confirmed while this item
    # waits for its own Confirm it): Confirm into the Ground Truth confirms it for this item and
    # gives it the next F-code; null when the item is in the Ground Truth or has no feature.
    confirm_feature_id: uuid.UUID | None = None
    # unique-codes (Nov 23): the Ground Truth feature it is part of, its code and name ("F-51
    # Alert routing"), when the item reads a code of its own; null otherwise.
    feature_name: str | None = None
    title: str
    outcome: str | None = None
    # build-feature-panel (AN PR 1204): the item's notes (op edit_note), the panel's Notes row.
    note: str | None = None
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
    # A re-plan resized it: its date waits on a new estimate from its owner.
    estimate_pending: bool = False
    # roadmap-dates: the first day of the quarter Quick Add put it in (an undated item is
    # estimated inside it until Oracle suggests dates); null: none picked.
    picked_quarter: dt.date | None = None
    # roadmap-dates (dates.Resolved.basis): where an estimate's dates come from, Oracle's
    # suggestion (open, or accepted into an open draft), the picked quarter, or what it depends
    # on (qa-nov17: a new dependency outdated the suggestion); null: its window, or dates a
    # source gives.
    estimate_basis: Literal["suggestion", "quarter", "dependencies"] | None = None
    # approved-roadmap-to-simple: the applied roadmap version's words for the dates
    # ("engineering estimate", "founder commitment", "set by <person>"); null when the
    # dates are not the version's (none applied, or a person changed them since).
    date_basis: str | None = None
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
    # one-feature-panel: the item's own owner (set_owner's ``before``; null: its track's
    # owner is shown) and the keys it depends on as stored (set_depends' ``before``).
    own_owner_id: str | None = None
    # one-feature-panel: the item's own decider (set_decider's ``before``; null: its
    # roadmap's decider decides).
    own_decider_id: str | None = None
    depends_keys: list[str] = []
    # roadmap-edit-fixes: the stored key (of depends_keys) that names each item of
    # depends_on, by item id (another PRD's feature key is neither its key nor its code);
    # and Oracle's ideas of what a new item depends on (keys), a person's to add.
    depends_key_of: dict[str, str] = {}
    # roadmap-edit-fixes round 1: every stored key that names each item of depends_on (its key
    # and its feature's key, say), by item id: the panel's x drops them all.
    depends_keys_of: dict[str, list[str]] = {}
    suggested_depends: list[str] = []
    # timeline-order: the item's place in the one feature order (its feature's Priorities rank,
    # whole numbers; null: no ranked feature) and its feature's pin as override_priority's
    # ``before.override`` wants it (null: none).
    position: int | None = None
    before_override: dict[str, Any] | None = None
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
    # feature-parts: the key of the item this one is part of as stored (set_parent's
    # ``before``), that item (null: none, or not on the roadmap; in_trash: in Trash), the
    # path to it from the top (top first, the parent last), and the item's parts (open or
    # cut, never merged) in the roadmap's order. Any depth; never a loop.
    parent_key: str | None = None
    part_of: "SimplePartRef | None" = None
    part_path: list["SimplePartRef"] = []
    parts: list["SimplePartRef"] = []
    drafting: bool = Field(
        default=False, description="S7: Oracle's drafting job for this draft is queued or running."
    )
    flow: "SimpleFlow | None" = None
    goal_ids: list[str] = Field(
        default=[], description="S7: the goals the item is linked to directly."
    )

    # S8: the decided decisions that changed the item (newest first; the Decisions page).
    decided_in: list["SimpleDecidedRef"] = []
    # walkc-roadmap-tasks: the work under the item (not dropped), in order.
    tasks: list["SimpleItemTask"] = []
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


class SimplePartRef(SimpleMergedInto):
    """feature-parts: a parent or a part, by its display code ("" when none) and name."""

    cut: bool = False
    in_trash: bool = False


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
    # roadmap-milestone-codes: its one code across the read (M1, M2 ... by date;
    # oracle.simple.roadmap_codes); null when dropped or a PRD plan's own.
    roadmap_code: str | None = None


class SimpleAppliedVersion(BaseModel):
    """approved-roadmap-to-simple: the approved roadmap version a roadmap's shown items were
    applied from (oracle.simple.approved_roadmap): ``matches`` when nothing changed since,
    else ``differences`` in words; the items it took off the plan; ``can_apply``: the
    reader may apply it again (an approver and up)."""

    roadmap: "SimpleDocRef"
    version: int
    approved_at: dt.datetime
    href: str
    matches: bool
    differences: list[str] = []
    shipped: list[str] = []
    moved_out: list[str] = []
    can_apply: bool = False


# milestone-kinds (owner): every roadmap milestone is one of six kinds, with a status.
MilestoneKind = Literal["sub_goal", "goal", "delivery", "decision", "outside", "handoff"]
MilestoneStatus = Literal["on_track", "at_risk", "hit", "missed"]
# A milestone's baseline, target or reading: fits its Numeric(20, 6) column (14 digits before
# the point), never NaN or infinity.
MilestoneNumber = Annotated[float, Field(gt=-1e14, lt=1e14, allow_inf_nan=False)]


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
    # roadmap-keydates (the owner, Nov 1): a milestone of a PRD on the roadmap, read from the
    # PRD's plan (its latest approved version): read-only, changed in the PRD. None: the
    # roadmap's own key date.
    prd: "SimpleDocRef | None" = None
    # milestone-kinds: its kind and status (a person's, else on track), and why.
    kind: MilestoneKind = "delivery"
    status: MilestoneStatus = "on_track"
    status_reason: str | None = None


class SimpleKeyDateRoadmap(BaseModel):
    """A roadmap whose key dates the reader reads; ``applies``: their change applies (an
    owner, the decider, with none its owner), ``can_change``: they may change or propose."""

    roadmap: "SimpleDocRef"
    applies: bool = False
    can_change: bool = False


class SimpleMilestonePending(BaseModel):
    """build-milestones-on-roadmap: an edit to a PRD's milestone, waiting on its owner's
    decision through the change engine (the milestone's date and ``counts_when`` stay as
    the PRD has them until it is accepted)."""

    date: dt.date | None = None
    counts_when: str | None = None
    # milestone-rename: the name asked for (None: the name stays).
    name: str | None = None
    asked_of: str | None = None
    change_id: uuid.UUID | None = None
    # roadmap-decide: the viewer is the PRD's owner (or a company owner) and decides it.
    can_decide: bool = False


MilestoneProgress = Literal["on_track", "at_risk", "not_started", "met"]


class SimpleGoalMilestone(BaseModel):
    """build-milestones-on-roadmap: a milestone on the Simple roadmap, per goal. ``prd``
    set: read from that PRD's own milestones (read-only except through ``pending``);
    ``prd_owner``: its display name. ``date`` null: no date yet."""

    id: uuid.UUID
    roadmap_id: uuid.UUID
    code: str
    name: str
    date: dt.date | None = None
    goal_id: uuid.UUID | None = None
    item_ids: list[uuid.UUID] = []
    counts_when: str = ""
    progress: MilestoneProgress = "not_started"
    prd: "SimpleDocRef | None" = None
    prd_owner: str | None = None
    pending: SimpleMilestonePending | None = None
    can_change: bool = False
    # milestone-rights: a roadmap's own milestone the reader may not change but may propose
    # a change to (op edit_goal_milestone, routed to who decides the roadmap).
    can_propose: bool = False
    # old-milestones: the older per-PRD roadmap it was brought over from, if it was.
    carried_from: "SimpleDocRef | None" = None
    # roadmap-milestone-codes: its one code across the roadmap read (M1, M2 ... by date;
    # oracle.simple.roadmap_codes), the code every page shows; null outside a roadmap read.
    roadmap_code: str | None = None
    # milestone-kinds (owner): its kind, its one "done when" line, and its status: a person's
    # (``status_set``, by ``status_set_by_name``, why: ``status_reason``), else computed
    # (oracle.simple.goal_milestones.status_of) with a short reason.
    kind: MilestoneKind = "delivery"
    done_when_line: str = ""
    status: MilestoneStatus = "on_track"
    status_reason: str | None = None
    status_set: MilestoneStatus | None = None
    status_set_by_name: str | None = None
    # A measured (sub-)goal's numbers.
    measure: str | None = None
    baseline: float | None = None
    target: float | None = None
    current: float | None = None
    # A sub-goal: the measured-goal milestone it builds toward; a goal: its sub-goals.
    sub_goal_of_id: uuid.UUID | None = None
    sub_goal_ids: list[uuid.UUID] = []
    # tb-mk: the track it sits on (the panel's Track).
    home_track_id: uuid.UUID | None = None
    home_track_name: str | None = None
    # A hand-off: from one track to another.
    from_track_id: uuid.UUID | None = None
    to_track_id: uuid.UUID | None = None
    from_track_name: str | None = None
    to_track_name: str | None = None
    # A company goal's own target date (id: the goal's), shown while the goal is on the
    # roadmap (``on_roadmap``); changed on the goal, not here.
    goal_target: bool = False


class SimpleGoalMilestoneIn(BaseModel):
    roadmap_id: uuid.UUID
    name: str = Field(min_length=1, max_length=120)
    date: dt.date
    goal_id: uuid.UUID | None = None
    item_ids: list[uuid.UUID] = []
    counts_when: str = ""
    kind: MilestoneKind = "delivery"
    done_when_line: str = Field(default="", max_length=300)
    status_set: MilestoneStatus | None = None
    status_reason: str | None = Field(default=None, max_length=300)
    measure: str | None = Field(default=None, max_length=120)
    baseline: MilestoneNumber | None = None
    target: MilestoneNumber | None = None
    current: MilestoneNumber | None = None
    sub_goal_of_id: uuid.UUID | None = None
    home_track_id: uuid.UUID | None = None
    from_track_id: uuid.UUID | None = None
    to_track_id: uuid.UUID | None = None


class SimpleGoalMilestonePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    date: dt.date | None = None
    goal_id: uuid.UUID | None = None
    item_ids: list[uuid.UUID] | None = None
    counts_when: str | None = None
    # milestone-kinds: only the fields sent change; ``status_set`` null clears the override.
    kind: MilestoneKind | None = None
    done_when_line: str | None = Field(default=None, max_length=300)
    status_set: MilestoneStatus | None = None
    status_reason: str | None = Field(default=None, max_length=300)
    measure: str | None = Field(default=None, max_length=120)
    baseline: MilestoneNumber | None = None
    target: MilestoneNumber | None = None
    current: MilestoneNumber | None = None
    sub_goal_of_id: uuid.UUID | None = None
    home_track_id: uuid.UUID | None = None
    from_track_id: uuid.UUID | None = None
    to_track_id: uuid.UUID | None = None


class SimplePrdRef(BaseModel):
    id: uuid.UUID
    title: str


class SimpleRoadmapTrack(BaseModel):
    """milestone-kinds: a track band on the roadmap read, in the Tracks order, with its
    health: ``at_risk`` (a feature ends after a milestone it serves), ``stale`` (not checked
    in 14 days) or ``on_track``, and a short reason."""

    id: uuid.UUID
    title: str
    goal_id: uuid.UUID | None = None
    goal_name: str | None = None
    owner_name: str | None = None
    prds: list[SimplePrdRef] = []
    health: Literal["on_track", "at_risk", "stale"] = "on_track"
    health_reason: str = ""
    # track-order (owner Nov 9): its place number in the company's track order (lower first;
    # none: after every numbered one, oldest first). The list comes in that order.
    order: int | None = None


class SimpleOldMilestone(BaseModel):
    """old-milestones (owner, Nov 4): a goal milestone still on an older per-PRD roadmap
    (history) that is not on the company roadmap yet. ``items``: the titles of the items
    it gates that are on the company roadmap (it would gate those there); none left: it
    waits on an owner's Keep or Drop."""

    id: uuid.UUID
    name: str
    date: dt.date | None = None
    goal_id: uuid.UUID | None = None
    goal_title: str | None = None
    from_roadmap: "SimpleDocRef"
    items: list[str] = []


class SimpleOldMilestones(BaseModel):
    """What "Bring old milestones over" would do: ``moves`` are copied (items re-pointed),
    ``needs_call`` have no items left and wait on Keep or Drop. An owner's alone: anyone
    else reads both empty and ``can_act`` false."""

    can_act: bool = False
    moves: list[SimpleOldMilestone] = []
    needs_call: list[SimpleOldMilestone] = []


class SimpleOldMilestonesResult(BaseModel):
    """After a carry-over, Keep or Drop: the ids of the company roadmap's new milestones
    and what is left."""

    carried: list[uuid.UUID] = []
    old_milestones: SimpleOldMilestones


class SimpleRoadmapOut(BaseModel):
    today: dt.date
    group: RoadmapGroup
    windows: SimpleWindows
    groups: list[SimpleGroup]
    items: list[SimpleRoadmapItem]
    milestones: list[SimpleMilestone]
    # build-milestones-on-roadmap: each shown roadmap's milestones per goal (its own, and
    # those read from the PRDs its items come from).
    goal_milestones: list[SimpleGoalMilestone] = []
    # old-milestones: the older roadmaps' goal milestones an owner may bring over.
    old_milestones: SimpleOldMilestones = SimpleOldMilestones()
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
    # The items' decided decisions left out as no longer standing (about something in
    # Trash), named in one line; null when none was.
    left_out: "SimpleLeftOut | None" = None
    # approved-roadmap-to-simple: one line per shown roadmap applied from an approved version.
    applied_versions: list[SimpleAppliedVersion] = []
    # milestone-kinds: every live track, in the Tracks order, with its health.
    tracks: list[SimpleRoadmapTrack] = []


class DateSuggestionEdit(BaseModel):
    start_date: dt.date
    end_date: dt.date

    @model_validator(mode="after")
    def _span(self) -> "DateSuggestionEdit":
        if self.end_date < self.start_date:
            raise ValueError("end_date must not be before start_date")
        return self


# --------------------------------------------------------------------------- S3a changes

ChangeOp = Literal[
    "move_dates",
    "change_horizon",
    "reorder",
    "cut",
    "restore",
    "edit_title",
    "edit_outcome",
    "edit_note",
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
    # A number inside a PRD section, the one-pager's "Needs a look" fix (owner, Nov 5).
    "set_section_number",
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
    # one-feature-panel: every field of an item, edited in its panel.
    "set_confidence",
    "set_track",
    "set_prd",
    "set_goal",
    "set_depends",
    "set_status",
    # lane-gt-ui: the Ground Truth feature the item is (Add to Ground Truth, Link to a feature).
    "set_feature",
    # feature-parts: the item made part of another (any depth, never a loop), or taken out.
    "set_parent",
    # every-field-editable: the item's feature code (F-31), carried in its stored title.
    "set_code",
    # panel-stages (#1815): the feature's code given to this item (oracle.simple.code_take).
    "take_feature_code",
    # one-feature-panel: how the goal the item serves is measured (its target and date).
    "set_goal_measure",
    # goal-buckets-tasks: the goals an item serves (into the working draft).
    "set_goals",
    # chat-actions: the item's own owner and decider (into the working draft).
    "set_owner",
    "set_decider",
    # prd-questions: a PRD's open question (a decision) answered, or its decider named
    # (oracle.simple.questions).
    "decide_question",
    "name_decider",
    # fix5-cut-dependents: an item cut with every item that waits on it (transitively), as
    # one change keyed by item id (oracle.simple.changes).
    "cut_with_dependents",
    # build-milestones-on-roadmap: a proposed date/counts_when on a PRD's own goal
    # milestone, on the PRD document, routed to its owner (oracle.simple.goal_milestones).
    "edit_goal_milestone",
    # trash-features-goals: a feature moved to Trash, proposed to its decider by who may
    # not decide on it (oracle.simple.trash_items).
    "delete_item",
    # trash-features-goals: a goal moved to Trash, proposed by a commenter to the company's
    # owners (oracle.simple.trash_items).
    "delete_goal",
    # edit-goals-prds: a goal archived or restored from the archive, asked of the company's
    # owners by who may not (oracle.simple.goal_asks).
    "archive_goal",
    "unarchive_goal",
    # goal-map-link-asks: a feature put on a goal milestone (or its link moved from another),
    # suggested by who may propose but not edit the Goal map, routed to the feature's
    # roadmap's decider (oracle.simple.goal_map_asks).
    "link_goal_map",
    # roadmap-decide: a dependent no longer depends on a cut item (its fix).
    "remove_dependency",
    # removed-tracks: a removed goal milestone put back; a track added, edited (title, owner,
    # status) or moved to Trash (oracle.simple.plan_changes).
    "restore_goal_milestone",
    "add_track",
    "edit_track",
    # track-order: a track moved one step up or down in the company's track order.
    "move_track",
    "delete_track",
    # edit-decisions (oracle.simple.decision_sheet): an open decision's or a PRD question's
    # fields, its withdrawal (the "not now"), and a question added to a PRD.
    "edit_decision",
    "edit_question",
    "withdraw_decision",
    "add_question",
    # prio-twin-propose: a same-name twin's Ground Truth feature merged into its row's
    # (oracle.simple.twin_merges; an approver's applies, a commenter's is proposed).
    "merge_twin",
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
    # item-chat-understands: an item already shipped (oracle.simple.shipped).
    "mark_shipped",
    # ask-oracle-actions: any action of the API's catalogue (oracle.simple.ask_actions).
    "api_action",
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


class SimpleMeetingRef(BaseModel):
    id: uuid.UUID
    title: str


class SimpleDecidedRef(SimpleOpenDecision):
    """A decided decision naming the item: who decided, when, and (decided in a meeting)
    the meeting and its minutes' page."""

    decided_by: SimplePersonRef | None = None
    decided_at: dt.datetime | None = None
    meeting: SimpleMeetingRef | None = None
    minutes_url: str | None = None


class SimpleLeftOut(BaseModel):
    """A read's sources entry: the decisions left out as no longer standing
    (decisions-reversed-or-trashed; oracle.decisions.standing.sources_entry)."""

    kind: Literal["left_out"] = "left_out"
    title: str
    decision_ids: list[uuid.UUID] = []


class SimpleItemTask(BaseModel):
    """A task under a roadmap item (oracle.simple.models.RoadmapItemTask): who does it, by
    when."""

    id: uuid.UUID
    title: str
    status: Literal["todo", "doing", "done", "dropped"]
    owner: SimplePersonRef | None = None
    due_date: dt.date | None = None
    # task-push (#1816): its record in the connected tracker (the issue key and link), and why
    # its last push failed (shown with Retry), None once a push lands.
    tracker_ref: str | None = None
    tracker_url: str | None = None
    tracker_error: str | None = None


class SimpleTaskWaiting(SimpleItemTask):
    """An open task waiting on the reader (Home's "Waiting for you"), with its item."""

    item_id: uuid.UUID | None = None
    item_title: str
    roadmap_id: uuid.UUID
    late: bool = False


class SimpleChangeMeeting(BaseModel):
    """meeting-changes-only-its-agenda: the meeting a change was made in."""

    id: uuid.UUID
    title: str


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
    # The walk (H2): the change in plain words, as Home's "Since your last visit" says it:
    # "Ana changed the estimate of F-08 Billing page · undone" (oracle.simple.change_words).
    words: str | None = None
    # meeting-changes-only-its-agenda: the meeting it was made in, and whether it is on an
    # item that meeting does not review (so a proposal for the item's owner, never applied
    # by the meeting): "Asked for by the meeting Payments review".
    # null: not made in a meeting.
    from_meeting: SimpleChangeMeeting | None = None
    off_agenda: bool | None = None
    # codes-at-write (Nov 23): the items this write gave their own number at once, because
    # another item of the plan showed the code they take from their feature (item id -> code);
    # null: none.
    numbered: dict[str, str] | None = None


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
    # inbox-codes (#1786): the item's code (codes.code_of: its title's, its feature's or its
    # PRD section's), so its row names it with its code; None for an item with none.
    item_code: str | None = None
    # meeting-changes-only-its-agenda: the meeting that asked for it.
    from_meeting: SimpleChangeMeeting | None = None
    # inbox-meeting-proposals: what was asked, in plain words, the item by its name
    # ("cut Delivery integrity"), and whether I may accept or decline it now.
    asked: str | None = None
    can_decide: bool = False
    # inbox-meeting-proposals owner: asked through Ask Oracle (by ``by_name``), not on the
    # page nor in a meeting.
    from_ask: bool = False
    # inbox-meeting-proposals fix: what a proposal on no item is on, so its row is named and
    # opens where it is decided: a PRD question ("Q3 Offline mode scope", ``question_id``) or
    # a one-pager line (as it reads, ``line_id``).
    subject: str | None = None
    question_id: uuid.UUID | None = None
    line_id: str | None = None
    # PR 1320 re-review: a one-pager number fix's PRD section (its key), where Open lands.
    section: str | None = None


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
    # fix5-cut-dependents: the titles of every item a cut_with_dependents cut (the item
    # first); roadmap-decide: every other op names its item (a fix: then what else moved).
    titles: list[str] = []


class SimpleSubmitIn(BaseModel):
    """Send for approval's optional body (build-review): people the sender adds as
    reviewers. The draft waits on them too, after the document's required reviewers; each
    must be an active member who may approve (commenter and up)."""

    reviewer_ids: list[uuid.UUID] = []


class SimpleDraftPrd(BaseModel):
    """approved-prd-roadmap: what an approved PRD put in the draft."""

    prd: SimpleDocRef
    version: int | None = None
    items: int
    key_dates: int


class SimpleDraftOut(BaseModel):
    """A working draft of one roadmap (S3b): its changes until submitted, then the version
    in review and who it waits on."""

    id: uuid.UUID
    document: SimpleDocRef
    status: DraftStatus
    # The version it was opened on, and the one submitting it imported.
    base_version: int | None
    version: int | None
    # The number it becomes (or became): the one after the roadmap's latest version (hotfix 4).
    next_version: int | None = None
    created_by: uuid.UUID
    # roadmap-decide review: the author's name, so the banner names whose draft it is at once.
    created_by_name: str | None = None
    created_at: dt.datetime
    participant_ids: list[uuid.UUID]
    # roadmap-decide review: the roadmap's set decider (who approves it), by name; none when
    # an owner decides.
    decider: SimplePersonRef | None = None
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
    # roadmap-decide (owner, Nov 4: draft, shown live): the decider's Approve and publish on a
    # working draft, in place of Send for review (POST .../approve sends it and approves it).
    can_publish: bool = False
    # roadmap-decide review: a working draft's required reviewers who still review it after
    # the decider's approval (the reader left out), named before Approve and publish.
    required_reviewers: list[uuid.UUID] = []
    # D-d: every applied change it holds, not undone, oldest first (one shared draft per
    # roadmap: approving it publishes them all).
    change_log: list[SimpleDraftChange] = []
    # walkb-roadmap review 5a: the roadmap has an approved version readers see; false for a
    # roadmap built from a PRD and not approved yet (the banner claims no approved roadmap).
    published: bool = True
    # The draft's author or the decider withdraws a submitted draft back to working.
    can_withdraw: bool = False
    # decisions-reversed-or-trashed: decisions this draft cited that were reversed since.
    decision_notes: list[str] = []
    # approved-prd-roadmap: the items and key dates approved PRDs put in it.
    from_prds: list[SimpleDraftPrd] = []


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
    # inbox-prd-approval-open: a PRD's draft opens on its one-pager, a roadmap's on the roadmap.
    document_kind: Literal["roadmap", "prd"] = "roadmap"
    version: int | None
    submitted_by: uuid.UUID | None
    # inbox-meeting-proposals fix: who submitted it, by name (or e-mail).
    submitted_by_name: str | None = None
    submitted_at: dt.datetime | None
    decider_approved: bool
    state: Literal["new", "open"]


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


SimpleRoadmapItem.model_rebuild()
SimpleRoadmapOut.model_rebuild()
