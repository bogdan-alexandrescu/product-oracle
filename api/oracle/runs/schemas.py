import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from oracle.docs.schemas import DocumentKind, ImportProblem, VersionSource
from oracle.jobs.schemas import LlmJobsTick, SuggestionStatus
from oracle.priorities.schemas import PriorityCheck
from oracle.reports.schemas import InboxReport, InboxReportFailure
from oracle.review.schemas import FeedbackKind

Flow = Literal[
    "baseline_to_prd",
    "feedback_loop",
    "prd_to_roadmap",
    "prd_to_spec",
    "request_triage",
    "strategy_draft",
    "launch_kit",
    "baseline",
    "code_map",
    "update_draft",
]
Depth = Literal["quick", "standard", "deep"]
RunStatus = Literal[
    "draft",
    "awaiting_approval",
    "running",
    "awaiting_checkpoint",
    "paused_overrun",
    "succeeded",
    "failed",
    "cancelled",
]
# skipped: a Baseline to PRD run that used the current baseline (C4) never ran it.
SegmentStatus = Literal["pending", "running", "succeeded", "failed", "cancelled", "skipped"]
CheckpointKind = Literal[
    "baseline_confirm",
    "feature_set",
    "priority_order",
    "prd_review",
    "eng_review",
    "roadmap_items",
    "roadmap_review",
    "request_triage",
    "strategy_review",
    "launch_review",
    "update_review",
]
CheckpointStatus = Literal["pending", "approved", "changes_requested", "skipped"]
Role = Literal["viewer", "commenter", "approver", "owner"]


class KnobsIn(BaseModel):
    depth: Depth = "standard"
    # Segment name -> agent roles in step order; omitted segments use the flow's defaults.
    roles: dict[str, list[str]] = {}
    # Checkpoint kind -> on; omitted checkpoints are on.
    checkpoints: dict[str, bool] = {}
    budget_usd: float | None = Field(default=None, gt=0)
    # Baseline to PRD only (C4, B1 "Reuse base"): true skips the baseline segment and its
    # Confirm the baseline stop, reusing the last baseline review (409
    # ``baseline_not_reusable`` when it is not reusable). Omitted on create: false; on
    # PATCH: unchanged.
    reuse_baseline: bool | None = None
    # Baseline to PRD only (#260): the confirmed goals (keys or ids) the PRD serves; the
    # baseline proposal and feature set favour features that move them, and the PRD's
    # goal trace covers them (422 for a goal that is not confirmed, or another flow).
    # Omitted on create: none (a run from a brief: the brief's goals); on PATCH: unchanged.
    goals: list[str] | None = Field(default=None, max_length=10)


class ReusedBaseline(BaseModel):
    """The baseline review a run reuses: its Confirm the baseline checkpoint."""

    checkpoint_id: uuid.UUID
    approved_at: datetime


class TargetGoal(BaseModel):
    """A confirmed goal a PRD run serves (#260)."""

    id: uuid.UUID
    key: str
    title: str


class KnobsOut(BaseModel):
    depth: Depth
    roles: dict[str, list[str]]
    checkpoints: dict[str, bool]
    budget_usd: float | None = None
    # Set when the run reuses the current baseline (C4).
    reuse_baseline: ReusedBaseline | None = None
    # The goals the run serves, in the order named (#260).
    goals: list[TargetGoal] = []


class StrategyBriefIn(BaseModel):
    """strategy_draft: what the owner tells Oracle in Company › Strategy's sheet. A vision's
    horizon is in years; a product strategy's is the dates it covers."""

    changed: str | None = Field(default=None, max_length=4000)
    horizon_years: int | None = Field(default=None, ge=1, le=10)
    horizon_from: date | None = None
    horizon_to: date | None = None
    # Start from the last approved version instead of the latest one.
    from_approved: bool = False

    @model_validator(mode="after")
    def _horizon(self) -> "StrategyBriefIn":
        if self.horizon_from and self.horizon_to and self.horizon_to <= self.horizon_from:
            raise ValueError("the horizon ends before it starts")
        if self.changed is not None:
            self.changed = self.changed.strip() or None
        return self


class RunCreate(BaseModel):
    flow: Flow
    # The document the run writes: an existing document's slug or id, or a new slug
    # (baseline_to_prd and prd_to_roadmap; the document is created when the draft is
    # imported). prd_to_roadmap: a roadmap; omitted, "<prd slug>-roadmap".
    document: str | None = Field(default=None, min_length=1, max_length=200)
    # prd_to_roadmap: the approved PRD (slug or id) the roadmap is built from, and its
    # version (the latest approved version when omitted). Refused (422) when the PRD has
    # no approved version or the named version is not approved.
    source: str | None = Field(default=None, min_length=1, max_length=200)
    source_version: int | None = Field(default=None, ge=1)
    # prd_to_roadmap: the roadmap template (default now-next-later, or the existing
    # roadmap's) and theme (default roadmap-board, or the existing roadmap's).
    # baseline_to_prd (C4): the PRD template and theme (default: the existing PRD's, else
    # the company's new-draft default, else oracle-default and clean-document); the
    # draft prompt pastes the template's skeleton. Other flows refuse both (422).
    template: str | None = Field(default=None, min_length=1, max_length=100)
    theme: str | None = Field(default=None, min_length=1, max_length=100)
    knobs: KnobsIn = KnobsIn()
    # strategy_draft only: the brief from Company › Strategy (422 on any other flow).
    strategy_brief: StrategyBriefIn | None = None


class RunPatch(BaseModel):
    """A draft run's new choices. ``template``/``theme``: as on RunCreate (prd_to_roadmap
    and, since C4, baseline_to_prd)."""

    document: str | None = Field(default=None, min_length=1, max_length=200)
    source: str | None = Field(default=None, min_length=1, max_length=200)
    source_version: int | None = Field(default=None, ge=1)
    template: str | None = Field(default=None, min_length=1, max_length=100)
    theme: str | None = Field(default=None, min_length=1, max_length=100)
    knobs: KnobsIn | None = None


class AgentRoleOut(BaseModel):
    key: str
    title: str
    description: str
    base_usd: float


class FlowSegmentOut(BaseModel):
    name: str
    title: str
    roles: list[str]
    scopes: list[str]
    outputs: list[str]
    # None: the segment opens no stop (the code_map flow's index).
    checkpoint: CheckpointKind | None
    approver_role: Role


class FlowStart(BaseModel):
    label: str
    href: str | None = None


class FlowOut(BaseModel):
    key: Flow
    title: str
    description: str
    requires_document: bool
    # The kind of document the run writes; None: the existing document's kind.
    target_kind: DocumentKind | None = None
    # The kind of approved document the run reads (prd_to_roadmap: a PRD).
    source_kind: DocumentKind | None = None
    # The route that starts runs of this flow (prd_to_spec: POST /v1/spec-requests); None:
    # POST /v1/runs.
    entry: str | None = None
    segments: list[FlowSegmentOut]
    # D12: the New run dialog offers this flow (one rule for every flow).
    in_new_run_dialog: bool = False
    # Where a flow with its own door starts: a pointer line under the dialog's list.
    starts_from: FlowStart | None = None
    # False: the run writes no document (launch_kit, baseline).
    writes_document: bool = True


class FlowCatalog(BaseModel):
    flows: list[FlowOut]
    roles: list[AgentRoleOut]
    depths: dict[str, float]
    approval_threshold_usd: float
    overrun_factor: float
    runtime: str
    runtime_notes: list[str]


class SegmentEstimate(BaseModel):
    seq: int
    name: str
    title: str
    roles: list[str]
    estimate_usd: float
    # C4: the baseline segment of a run that uses the current baseline: $0.00, with the
    # note "Current baseline, approved Oct 12".
    reused: bool = False
    note: str | None = None


class EstimateOut(BaseModel):
    run_id: uuid.UUID
    depth: Depth
    total_usd: float
    segments: list[SegmentEstimate]
    approval_threshold_usd: float
    needs_approval: bool
    budget_usd: float | None = None
    within_budget: bool


class SegmentAttempt(BaseModel):
    attempt: int
    workflow_id: str | None = None
    submitted_at: datetime | None = None
    cost_usd: float = 0
    # The reviewer's note this attempt applied: for a wait answered in SwarmCloud, the
    # findings SwarmCloud recorded, by whom (``note_by``); an Inbox note that SwarmCloud
    # did not record (it already held an answer) is ``not_applied``.
    note: str | None = None
    note_by: str | None = None
    not_applied: str | None = None
    state: str | None = None


class PrdLinks(BaseModel):
    """Cross-document links from a roadmap draft to its PRD version's sections."""

    resolved: int = 0
    # Links to a section the PRD version does not have, or to another version.
    unresolved: list[str] = []


class DraftImport(BaseModel):
    document_id: uuid.UUID | None = None
    slug: str | None = None
    kind: DocumentKind | None = None
    version: int | None = None
    created: bool | None = None
    warnings: list[str] = []
    error: str | None = None
    # A refused draft (owner, 2026-10-20): the parser's problems, and one plain line
    # grouped by cause (oracle.runs.rejection), the same on the run page, Inbox and MCP.
    problems: list[ImportProblem] = []
    summary: str | None = None
    # Provenance recorded on the version (a roadmap's PRD version).
    source: VersionSource | None = None
    prd_links: PrdLinks | None = None


class ItemsProblem(BaseModel):
    code: str
    message: str
    item: str | None = None


class FixAction(BaseModel):
    """What a fix does to one item. ``edit`` sets ``field`` (``horizon``,
    ``milestone_date``, ``milestone_name``, ``depends_on``, ``outcome``, ``title``,
    ``prd_section``, ``order``, ``clear:<field>``) to ``value``."""

    kind: Literal["accept", "edit", "drop", "restore", "waive"]
    item: str
    field: str | None = None
    value: Any = None


class ReasonFix(BaseModel):
    label: str
    action: FixAction


class ItemReason(BaseModel):
    """Why a roadmap item needs a person (oracle.runs.reasons): ``blocking`` (a rule
    problem) or ``confirm`` (advisory), with a chip label, one sentence and its fixes."""

    item: str
    # The item's title (a dropped item's, from the comparison base).
    item_title: str | None = None
    code: str
    severity: Literal["blocking", "confirm"]
    label: str
    text: str
    data: dict[str, Any] = {}
    fixes: list[ReasonFix] = []


class ReasonBase(BaseModel):
    """What moved, new and dropped compare with: the previous attempt or roadmap version."""

    kind: Literal["attempt", "roadmap_version"]
    label: str
    version: int | None = None
    attempt: int | None = None


class ItemsCheck(BaseModel):
    """The check of roadmap_items.yaml (oracle.runs.roadmap) and every item's reasons
    (oracle.runs.reasons). Checks stored before reasons existed read with none."""

    items: int
    by_horizon: dict[str, int]
    problems: list[ItemsProblem]
    reasons: list[ItemReason] = []
    blocking: int = 0
    to_confirm: int = 0
    # Problems of the whole file (no item): it needs a send-back.
    file_problems: int = 0
    base: ReasonBase | None = None
    # The advisory reasons could not be loaded: only the blocking ones are listed.
    reasons_partial: bool = False


class PreviousAttempt(BaseModel):
    """The attempt before the current one, kept when a person sent the segment back (D5):
    its number and file names (read with ``?attempt=``)."""

    attempt: int
    artifacts: list[str]


class FeatureSetProblem(BaseModel):
    """One problem of feature_set.yaml or of the stored scope (oracle.runs.feature_set). A
    blocking one refuses Approve until it is fixed (call c3)."""

    code: str
    blocking: bool = True
    feature: str | None = None
    requirement: str | None = None
    message: str


class FeatureSetCheck(BaseModel):
    """The check of feature_set.yaml (C6): counts, every problem, and the advisory flags
    per feature key (serves_no_goal, low_confidence, linked_blocker, new_feature,
    duplicate_of_existing)."""

    features: int
    requirements: int
    excluded: int
    problems: list[FeatureSetProblem]
    flags: dict[str, list[str]] = {}


class ScopeGoal(BaseModel):
    goal_id: uuid.UUID | None = None
    key: str
    contribution: int | None = None


class ScopeRequirementOut(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    text: str | None = None
    acceptance: list[str] = []
    # keep | cut
    decision: Literal["keep", "cut"]
    decision_reason: str | None = None
    origin: Literal["agent", "person"]
    entity_id: uuid.UUID | None = None
    proposal_id: uuid.UUID | None = None


class ScopeFeatureOut(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    # include | exclude | defer
    decision: Literal["include", "exclude", "defer"]
    decision_reason: str | None = None
    origin: Literal["agent", "person"]
    goals: list[ScopeGoal] = []
    depends_on: list[str] = []
    blocker_keys: list[str] = []
    confidence: float | None = None
    flags: list[str] = []
    entity_id: uuid.UUID | None = None
    proposal_id: uuid.UUID | None = None
    requirements: list[ScopeRequirementOut] = []


class PrdScopeOut(BaseModel):
    """A PRD scope (C6): the features and requirements a feature-set stop approves for one
    PRD, in file order. Later segments and the document's next drafts read the approved
    one."""

    id: uuid.UUID
    run_id: uuid.UUID
    document_id: uuid.UUID | None = None
    segment_seq: int
    attempt: int
    status: Literal["proposed", "approved", "superseded"]
    check: FeatureSetCheck
    features: list[ScopeFeatureOut]
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    lock_version: int


class SegmentOut(BaseModel):
    id: uuid.UUID
    seq: int
    name: str
    title: str
    status: SegmentStatus
    roles: list[str]
    scopes: list[str]
    # The checkpoint this segment ends at (None: it has none), and whether it is on.
    checkpoint: CheckpointKind | None
    checkpoint_on: bool
    estimate_usd: float | None = None
    cost_usd: float
    workflow_id: str | None = None
    artifacts: list[str]
    attempts: list[SegmentAttempt]
    draft_import: DraftImport | None = None
    # The draft's import was refused and Oracle sent it back to the writer itself (its own
    # NOT_YET, owner 2026-10-20): the revision runs and is not imported yet. The run page
    # reads "Revising: sent back by Oracle", not "Draft rejected"; nothing waits for a
    # person. Cleared once the revision is imported, or still refused (then its review
    # waits in the Inbox), or the run ends.
    sent_back: bool = False
    # C4: a baseline segment the run skipped, reusing this review; ``note`` reads
    # "Reused the baseline approved Oct 12".
    reused: ReusedBaseline | None = None
    note: str | None = None
    # Retry import (owner, 2026-10-20): the draft's import was refused and its file is
    # kept, and either its review is still open and I have the review's approver role or
    # above, or the run finished with no version imported and I am an owner.
    can_retry_draft_import: bool = False
    items_check: ItemsCheck | None = None
    previous_attempt: PreviousAttempt | None = None
    # The feature-set segment's check of feature_set.yaml (C6).
    feature_set_check: FeatureSetCheck | None = None
    # The priority segment's check of priority.yaml (C8).
    priority_check: PriorityCheck | None = None
    # H11: the baseline's level changed this segment's merge (skipped at observe, or
    # every change a proposal): one line saying so, else None.
    autonomy_note: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None


class ConsoleAnswer(BaseModel):
    """What SwarmCloud's console recorded for a checkpoint still open in the Inbox (W5):
    an answer that does not count (its answerer is not an Oracle member with the
    checkpoint's role), a counted change request the workflow had no revision step for,
    an answer Oracle could not read, or one it has not read yet (``unread``: SwarmCloud
    errors, a 404 or a lagging record; read again on every tick)."""

    answered_by: str | None = None
    on_behalf_of: str | None = None
    answered_at: str | None = None
    via: str | None = None
    verdict: Literal["MERGE", "NOT_YET"] | None = None
    findings: list[str] = []
    # None when the verdict could not be read.
    counted: bool | None = None
    # Why it does not count, or why it cannot be read.
    reason: str | None = None
    # What an approver does: confirm it (or approve / request changes), choose Redo from
    # the segment or Continue, or decide over an answer Oracle cannot read (or has not
    # read yet: the run's token is read-only until it is).
    needs: Literal["confirm", "redo_or_continue", "unreadable", "unread"]
    # The workflow has a revision step for a change request here.
    revise: bool = False
    # Redo: the segment that runs again as a new workflow, and its estimate (one more).
    redo_segment: str | None = None
    redo_cost_usd: float | None = None
    # Redo carries the console's findings; without any, it needs a note (the API refuses
    # a Redo without either, and the web disables the button).
    can_redo: bool = False


class CheckpointDelivery(BaseModel):
    """A decision recorded in Oracle that has not reached the run's workflow yet (owner,
    2026-10-20: a recorded decision is final; Oracle sends it again on every tick until
    SwarmCloud takes it). The decision is the checkpoint's ``status``, ``decided_by`` and
    ``decided_at``. None once delivered: the checkpoint then shows its decided state."""

    # Who decided: their email, or the API token's name.
    decided_by_name: str | None = None
    # When Oracle recorded it.
    since: datetime | None = None
    # Tries that did not deliver it (0 while the first is under way).
    tries: int = 0
    # What SwarmCloud answered the last of them (redacted, at most 200 characters).
    last_error: str | None = None
    last_tried_at: datetime | None = None


class CheckpointOut(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID
    kind: CheckpointKind
    status: CheckpointStatus
    approver_role: Role
    segment_seq: int | None = None
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    note: str | None = None
    payload: dict[str, Any]
    created_at: datetime
    # Whether the caller's role may decide it (pending checkpoints only).
    can_decide: bool = False
    # Why approving it is refused now (owner, 2026-10-20): the draft its segment left was
    # not imported (Request changes, or Retry import on the segment, first), or the feature
    # set has blocking problems (C6: Request changes).
    cannot_approve: str | None = None
    # An open checkpoint answered in SwarmCloud's console, waiting on an approver (W5).
    console: ConsoleAnswer | None = None
    # A decided checkpoint whose decision Oracle has not delivered to the run yet.
    delivery: CheckpointDelivery | None = None


class RunDecision(BaseModel):
    """A decided checkpoint of a run, as its agents read it (``get_checkpoint_review``):
    who decided by role only (no names reach the agents), when, and what. A console
    answer is a decision once it is followed: one held for an approver is still pending
    and not listed."""

    checkpoint_id: uuid.UUID
    kind: CheckpointKind
    segment_seq: int | None = None
    segment_title: str | None = None
    attempt: int | None = None
    status: Literal["approved", "changes_requested", "skipped"]
    decided_at: datetime | None = None
    decided_by_role: Role | None = None
    # oracle: the Inbox, the web app or MCP; swarmcloud_console: SwarmCloud's console.
    via: Literal["oracle", "swarmcloud_console"] = "oracle"
    note: str | None = None
    # The edits Oracle applied with an approval (D7) and the structured review sent back
    # (D4); None until those are recorded.
    edits: dict[str, Any] | None = None
    review: dict[str, Any] | None = None
    # False while the decision is recorded in Oracle and not delivered to the run yet.
    delivered: bool = True
    # The decision in one line, as the run page shows it:
    # "Feature set · approved by an approver · note: Keep bulk import out of v1".
    summary: str


class RunProgress(BaseModel):
    """Segments done of the run's total, and what it does now: Home's In flight row."""

    done: int
    total: int
    # The segment under way, else the next to run; None once every segment is done.
    now: str | None = None


class RunSummary(BaseModel):
    id: uuid.UUID
    flow: Flow
    flow_title: str
    status: RunStatus
    document_id: uuid.UUID | None = None
    document_slug: str | None = None
    # The kind of document the run writes (feedback loop: the document's kind).
    document_kind: DocumentKind | None = None
    # prd_to_roadmap: the approved PRD version it reads, and the roadmap's template and
    # theme; baseline_to_prd: the PRD's template and theme (C4).
    source: VersionSource | None = None
    template: str | None = None
    theme: str | None = None
    estimate_usd: float | None = None
    spent_usd: float
    created_by: uuid.UUID | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    # The kind of the checkpoint the run waits on, if any.
    waiting_on: CheckpointKind | None = None
    error: str | None = None
    # What the Inbox says of a run waiting for its owner or creator: a lost submission
    # Oracle could neither find nor rule out past the lookup cap (Retry and Cancel;
    # ``can_retry``), a cancel SwarmCloud keeps answering with a 404 that proves nothing
    # (Stop cancelling: ``can_stop_cancelling``; Cancel on a run not ended), an answer
    # post answered so (Cancel), a workflow whose cost is unknown because its status does
    # not read (Retry lookup: ``can_retry_lookup``), or an ended run's spend over its
    # ceiling while a workflow it stopped cancelling still runs (shown).
    stuck: str | None = None
    can_retry: bool = False
    # Stop cancelling: Oracle stops the cancel calls, and keeps reading the workflow's
    # status and cost until it ends, counted on the run; a run that has not ended ends
    # (P3d).
    can_stop_cancelling: bool = False
    # Retry lookup: read a workflow whose cost is unknown now, not at its next rest.
    can_retry_lookup: bool = False
    # An ended run's spend over its ceiling (P3d, shown in ``stuck`` with the spend and
    # the ceiling): the workflows an approver stopped cancelling that still run, each
    # with Cancel again (Oracle's cancel calls back on; nothing restarts), and whether
    # Dismiss clears the item (once nothing of the run is left to read).
    cancel_again: list[str] = []
    can_dismiss_overrun: bool = False
    # Work given up on that Oracle still checks: submissions it looks for (Retry, or
    # Cancel past the lookup cap), to cancel them and count their cost if they landed,
    # and workflows it stopped cancelling, whose cost it reads until they end.
    searching: str | None = None
    # Owners: Oracle stopped trying to import the output of a step whose advance kept
    # failing (the error's class, never what the agents wrote); Retry tries again.
    import_failed: str | None = None
    can_retry_import: bool = False
    # A draft one of its segments left that Oracle refused to import: its summary
    # (``segments[].draft_import.summary``, else the error). Set where ``progress`` is.
    # None while Oracle has that draft back with the writer (``sent_back``).
    draft_rejected: str | None = None
    # Waiting on its checkpoint, the run delivers a decision recorded there that SwarmCloud
    # has not taken yet (owner, 2026-10-20: shown as "Delivering decision"; the status
    # stays awaiting_checkpoint): that checkpoint's kind. Set where ``progress`` is.
    delivering: CheckpointKind | None = None
    # A refused draft Oracle sent back to the writer itself, being revised
    # (``segments[].sent_back``): its summary, as ``draft_rejected``. The runs list and
    # the Inbox read "Revising: sent back by Oracle"; nothing waits for a person. Set
    # where ``progress`` is, and on the Inbox's ``revising`` rows.
    sent_back: str | None = None
    # Set by GET /v1/runs and GET /v1/runs/{id}; None where a summary is embedded (inbox).
    progress: RunProgress | None = None


class CancelAgain(BaseModel):
    # The stopped workflow whose cancel calls Oracle turns back on.
    workflow_id: str = Field(min_length=1, max_length=200)


class RunOut(RunSummary):
    knobs: KnobsOut
    snapshot_id: uuid.UUID | None = None
    snapshot_as_of: datetime | None = None
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    needs_approval: bool
    # Spend above this pauses the run (1.5x the estimate, raised when an owner resumes).
    overrun_ceiling_usd: float | None = None
    runtime: str
    notes: list[str]
    segments: list[SegmentOut]
    checkpoints: list[CheckpointOut]
    # W5: while a console answer that did not count waits for an approver, the run's
    # token is read-only (its agents' writes are refused "waiting for approval").
    token_read_only: bool = False
    # The baseline proposals this run made that wait for a person (B3).
    open_proposals: int = 0


class CheckpointDecision(BaseModel):
    # confirm, redo and continue answer what SwarmCloud's console recorded (W5, see
    # CheckpointOut.console): confirm takes an answer that did not count as the decision;
    # redo re-runs the segment as a new workflow with the console's findings (one more
    # segment); continue follows the workflow, which went on regardless.
    decision: Literal["approved", "changes_requested", "confirm", "redo", "continue"]
    # Required with changes_requested: it goes to the agents re-running the segment.
    note: str | None = Field(default=None, max_length=10_000)
    # D8: the draft revision the decider saw (``GET .../review``). When given and the draft
    # changed since, the decision is refused (409 ``review_changed``) and nothing changes.
    expected_revision: int | None = None


class ClaudeSweepSummary(BaseModel):
    """What the Claude account pool's sweep did on this tick (oracle.claude_accounts)."""

    # Abandoned holds reclaimed.
    reclaimed: int = 0
    # Credentials examined and exchanged.
    examined: int = 0
    refreshed: int = 0
    # Accounts marked REAUTH_REQUIRED this tick.
    reauth_required: list[str] = []
    # Usage readings taken.
    polled: int = 0
    # "ran", "skipped" (another sweep holds the lease), "not_due" (the company's last
    # sweep completed under the sweep interval ago, at least 5 minutes) or "error".
    lease: str = "ran"
    errors: list[str] = []


class TickOut(BaseModel):
    runs_checked: int
    segments_finished: int
    runs_advanced: int
    runs_paused: int
    errors: list[str]
    claude_accounts: ClaudeSweepSummary | None = None
    llm_jobs: LlmJobsTick | None = None
    # Calls a member's disable still owed (a provider revoke, a runtime cancel), retried.
    member_follow_ups: int = 0


class InboxCheckpoint(CheckpointOut):
    flow: Flow
    flow_title: str
    document_slug: str | None = None
    segment_title: str | None = None


# C1e Inbox states: new (open, raised after my last Inbox visit), open, staged (accepted,
# waiting for the next draft), declined, done (addressed or applied).
InboxState = Literal["new", "open", "staged", "declined", "done"]


class InboxFeedbackItem(BaseModel):
    id: uuid.UUID
    summary: str
    kind: FeedbackKind
    section_key: str | None = None
    raised_on_version: int
    created_at: datetime
    document_id: uuid.UUID | None = None
    slug: str | None = None
    title: str | None = None
    # The document's latest version: where its actions open.
    latest_version: int | None = None
    state: InboxState = "open"
    updated_at: datetime | None = None
    # Declined: why; done: the version that addressed it.
    resolution_note: str | None = None
    addressed_in_version: int | None = None
    staged_for_version: int | None = None
    # D12: staged for the agents (no section text): the next draft goes to the agents.
    staged_for_agents: bool = False
    # The status of Oracle's live suggestion on the item, if it has one (open: "Review
    # suggestions").
    suggestion_status: SuggestionStatus | None = None
    suggestion_kind: str | None = None
    # D14: what the row's Accept / Decline act on, when the suggestion is open (else null):
    # its id, its text (the approver's edit when there is one) and rationale cut to 280
    # characters, and whether Oracle pushed back (Accept then needs a reason).
    suggestion_id: uuid.UUID | None = None
    suggestion_text: str | None = None
    suggestion_pushback: bool | None = None
    suggestion_rationale: str | None = None


class InboxFeedbackCounts(BaseModel):
    """What a document's open items wait for; the five add up to ``open_count``."""

    # Oracle suggestions to accept or dismiss.
    suggestions: int = 0
    # Accepted suggestions on open items (C1e: staged section text is not open feedback,
    # so this is zero unless an item stays open for another reason).
    accepted: int = 0
    # Comments to resolve.
    comments: int = 0
    # Section verdicts (changes requested, rejected) to address.
    verdicts: int = 0
    # General items.
    other: int = 0


class InboxDocument(BaseModel):
    document_id: uuid.UUID
    slug: str
    title: str
    latest_version: int | None = None
    open_count: int
    counts: InboxFeedbackCounts = Field(default_factory=InboxFeedbackCounts)
    # The section of the first open item in the review panel's order (raised on, created),
    # so the Inbox can link straight to it.
    first_section_key: str | None = None
    items: list[InboxFeedbackItem]


class InboxRevokeFailure(BaseModel):
    """A provider revoke a member's disable still owes, whose last attempt did not
    revoke (C2): retried by the tick for 24 hours, then waiting for an owner."""

    id: uuid.UUID
    member_id: uuid.UUID
    member_email: str | None = None
    provider: str | None = None
    provider_name: str | None = None
    # "Couldn't revoke <member>'s <provider> access at <provider>"
    title: str
    # pending: still retried (next_attempt_at); failed: retries stopped (retry_until).
    status: Literal["pending", "failed"]
    outcome: str | None = None
    last_error: str | None = None
    attempts: int
    created_at: datetime
    next_attempt_at: datetime | None = None
    retry_until: datetime


class InboxAccessFailure(BaseModel):
    """A change to someone's Google IAP access still failing after 24 hours of retries
    (#245): retried once a day until it is done or no longer needed; Retry runs it now."""

    id: uuid.UUID
    kind: Literal["iap_revoke", "iap_grant"]
    email: str
    # What was owed: "Access not removed" or "Access not granted".
    owed: str
    # Oracle's own short reason ("Google returned 403 (permission denied)"), never
    # Google's response body.
    last_error: str | None = None
    attempts: int
    # Failing since.
    created_at: datetime
    next_attempt_at: datetime | None = None


class InboxStaged(BaseModel):
    """'N changes staged for draft N+1' on one document, with the build action."""

    document_id: uuid.UUID
    slug: str
    title: str
    latest_version: int | None = None
    next_version: int
    count: int
    # Staged items whose section is gone from the latest version (not built).
    gone_count: int = 0
    # The build in progress or waiting for its preview, if any.
    draft_job_id: uuid.UUID | None = None
    draft_job_status: str | None = None


class InboxOracleAction(BaseModel):
    """ "Oracle did": what Oracle did on its own account (H11, ``oracle.autonomy.acted``),
    for one of the people it notified. Counted until that person opens it."""

    id: uuid.UUID
    responsibility: str
    responsibility_title: str
    summary: str
    subject: dict[str, Any] = {}
    # {method, path, body} of the route that reverses it, when the behaviour gave one.
    undo: dict[str, Any] | None = None
    # open: not opened by me yet; done: opened (or undone).
    state: Literal["open", "done"]
    counts: bool
    created_at: datetime
    undone_at: datetime | None = None


class InboxCounts(BaseModel):
    new: int = 0
    open: int = 0
    staged: int = 0
    declined: int = 0
    done: int = 0


class InboxDecision(BaseModel):
    """A decision row (H1): a proposal I decide, a review that came due (both counted),
    a decision made that I am informed of, or one I just handled (shown only)."""

    id: uuid.UUID
    number: int
    # "D-12"
    ref: str
    title: str
    reason: Literal["needs_decision", "review_due", "oracle_decided", "informed"]
    review_at: date | None = None
    # When it reached me (proposed, came due, decided): what "new" is measured against.
    since: datetime
    state: Literal["new", "open", "done"]
    # False for "informed" and done rows: they add to neither needs_me nor total.
    counts: bool


class InboxStrategy(BaseModel):
    """Owners: open strategy drift findings (H4), one Inbox row however many."""

    new_findings: int
    high: int
    # Where the findings are read and waived (Company › Strategy).
    href: str
    # When the newest open finding was first seen.
    since: datetime


from oracle.launches.schemas import InboxLaunch  # noqa: E402


class InboxOut(BaseModel):
    checkpoints: list[InboxCheckpoint]
    # Those with the checkpoint's approver role: decisions recorded and not delivered to
    # the run yet (``delivery``), until SwarmCloud takes them. Shown only: nothing to
    # decide, not in ``total``.
    deliveries: list[InboxCheckpoint] = []
    # Owners only: runs waiting for cost approval, and runs paused on overrun.
    approvals: list[RunSummary]
    overruns: list[RunSummary]
    # Owners and the run's creator: runs whose lost submission is past the lookup cap
    # (RunSummary.stuck), to Retry or Cancel.
    lookups: list[RunSummary] = []
    # Owners and the run's creator: runs looking for an earlier submission given up on
    # (RunSummary.searching); shown only, nothing to decide, not in ``total``.
    searches: list[RunSummary] = []
    # Those with a review's approver role or above: runs whose refused draft Oracle sent
    # back to the writer itself, being revised (RunSummary.sent_back). Shown only, the
    # review's state instead of a decision request: not in ``total``.
    revising: list[RunSummary] = []
    # Owners only: runs whose output Oracle stopped trying to import
    # (RunSummary.import_failed), to Retry.
    imports: list[RunSummary] = []
    # Approvers and owners: open feedback (not staged) on documents they can approve.
    feedback: list[InboxDocument]
    # Owners only: provider revokes a member's disable could not make (Retry, Dismiss).
    revoke_failures: list[InboxRevokeFailure] = []
    # Owners only (#245): access changes still failing after 24 hours.
    access_failures: list[InboxAccessFailure] = []
    # Owners only (F6): the newest weekly alignment reports, unread ones in ``total``; and
    # the reports Slack refused for 24 hours (Retry, Dismiss), in ``total`` too.
    reports: list[InboxReport] = []
    report_failures: list[InboxReportFailure] = []
    # Owners only: open strategy drift findings (H4); null when none or not an owner.
    strategy: InboxStrategy | None = None
    # Those it notified: what Oracle did on its own (H11), newest first; open ones count.
    oracle_actions: list[InboxOracleAction] = []
    total: int
    # Approvers and owners: feedback in every state, newest first (declined and done
    # capped to the most recent), the counts per state, and the staged rows.
    items: list[InboxFeedbackItem] = []
    counts: InboxCounts = InboxCounts()
    staged: list[InboxStaged] = []
    # H1: decision rows (proposals I decide, reviews due, informed, just handled).
    decisions: list[InboxDecision] = []
    # Feedback and decisions that need me: new + open (staged, declined and done do not).
    needs_me: int = 0
    # Launch rows (H6): Ready to launch and Notes to send (the launch's owner), Set tier
    # (approvers), counted in ``total``; Shipped (a member's personal note), shown only.
    launches: list[InboxLaunch] = []
    # My previous Inbox visit (what 'new' is measured from); None before the first.
    last_seen_at: datetime | None = None


FeatureState = Literal["on", "off", "unknown"]


class RuntimeFeatures(BaseModel):
    """Adapter v2's switches in the runtime: caller MCP (#1433), waits for a person
    (#1436), and Oracle's principal answering them."""

    mcp: FeatureState = "unknown"
    await_input: FeatureState = "unknown"
    service_answer: FeatureState = "unknown"


class RuntimeStatusOut(BaseModel):
    """Whether Oracle reaches its agent runtime, and as which tenant (owner only)."""

    runtime: str
    # How Oracle authenticates to SwarmCloud; None for other runtimes.
    auth: str | None = None
    reachable: bool
    tenant_id: str | None = None
    can_reach_oracle: bool
    features: RuntimeFeatures = RuntimeFeatures()
    # Why a feature is off or unknown, by feature.
    feature_reasons: dict[str, str] = {}
    notes: list[str] = []
    error: str | None = None


class McpServerRegistration(BaseModel):
    """Oracle's MCP server in the runtime (``oracle``, at ORACLE_PUBLIC_URL + /mcp)."""

    name: str
    url: str
    # created | updated (the URL changed) | unchanged
    result: Literal["created", "updated", "unchanged"]


# --------------------------------------------------------------------------- D8 shared draft


class ActionIn(BaseModel):
    """One action on one item of a pending checkpoint's shared draft (D8). ``kind``,
    ``field`` and ``value`` are checked against the checkpoint kind's vocabulary
    (oracle.runs.actions.VOCABULARY); a wrong one is 422 naming the rule."""

    # The item's id in the reviewed file; "*" for the whole file.
    item_key: str = Field(min_length=1, max_length=200)
    # accept | edit | drop | restore | split | merge | question | waive | look_again | add
    kind: str = Field(min_length=1, max_length=40)
    field: str | None = Field(default=None, max_length=80)
    value: Any = None
    # The reason codes (D2) this action answers.
    answers: list[str] = Field(default=[], max_length=20)
    note: str | None = Field(default=None, max_length=2000)


class DraftNoteIn(BaseModel):
    note: str | None = Field(default=None, max_length=10_000)


class WaitInfo(BaseModel):
    """The SwarmCloud wait of the checkpoint: ``open`` (``ends_at``, ``seconds_left``),
    ``ended`` (deciding continues the run as a new workflow) or ``none`` (one workflow per
    segment: the checkpoint waits in the Inbox with no end)."""

    state: Literal["open", "ended", "none"]
    ends_at: datetime | None = None
    seconds_left: int | None = None


class ReviewFile(BaseModel):
    name: str
    seq: int


class ReviewPerson(BaseModel):
    id: uuid.UUID | None = None
    name: str
    # Their role now; None for someone no longer found.
    role: str | None = None


class ReviewAnswerer(BaseModel):
    id: uuid.UUID | None = None
    name: str


class ReviewAnswer(BaseModel):
    kind: str
    body: str | None = None
    answered_by: ReviewAnswerer | None = None


class ReviewQuestion(BaseModel):
    """The stakeholder question a ``question`` action asked (C2), with its latest answer."""

    id: uuid.UUID
    status: str
    text: str
    asked_to: ReviewAnswerer | None = None
    answer: ReviewAnswer | None = None


class ReviewAction(BaseModel):
    id: uuid.UUID
    item_key: str
    kind: str
    field: str | None = None
    value: Any = None
    answers: list[str] = []
    state: Literal["staged", "suggested"]
    note: str | None = None
    created_by: ReviewPerson | None = None
    updated_by: ReviewPerson | None = None
    updated_at: datetime
    question: ReviewQuestion | None = None


class ReviewMilestone(BaseModel):
    name: str | None = None
    date: str | None = None


class ReviewItem(BaseModel):
    """One item of the reviewed file, its reasons (recomputed on every read) and its
    actions. ``state``: ``needs_you`` (an open reason no staged action answers),
    ``handled`` (every reason answered by a staged action), ``waiting`` (only open
    questions) or ``fine`` (no reasons). An item only the reasons or the actions name (a
    dropped item, the whole file "*") has no ``position``."""

    key: str
    position: int | None = None
    title: str | None = None
    horizon: str | None = None
    milestone: ReviewMilestone | None = None
    confidence: str | None = None
    rank: int | None = None
    outcome: str | None = None
    depends_on: list[str] = []
    prd_section: str | None = None
    reasons: list[ItemReason] = []
    actions: list[ReviewAction] = []
    state: Literal["needs_you", "handled", "waiting", "fine"]


class WaitingOn(BaseModel):
    user_id: uuid.UUID
    name: str
    count: int


class ReviewTally(BaseModel):
    need_you: int = 0
    handled: int = 0
    blocking_open: int = 0
    to_confirm_open: int = 0
    # Open questions per person asked.
    waiting_on: list[WaitingOn] = []
    suggested: int = 0


class CheckpointReview(BaseModel):
    """A checkpoint's shared draft decision (D8): its items with their reasons and actions,
    the note to the agents, the revision a decision is sent with, the wait's time left and
    what the reader may do. Checkpoint kinds with no item file serve ``items: []``."""

    checkpoint_id: uuid.UUID
    run_id: uuid.UUID
    kind: CheckpointKind
    status: Literal["pending", "approved", "changes_requested", "skipped"]
    approver_role: str
    attempt: int | None = None
    revision: int
    wait: WaitInfo
    file: ReviewFile | None = None
    file_problems: list[ItemsProblem] = []
    items: list[ReviewItem] = []
    tally: ReviewTally
    note: str | None = None
    can_read: bool = True
    can_suggest: bool = False
    can_stage: bool = False
    can_decide: bool = False
