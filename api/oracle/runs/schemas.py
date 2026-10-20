import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from oracle.docs.schemas import DocumentKind, VersionSource
from oracle.jobs.schemas import LlmJobsTick

Flow = Literal["baseline_to_prd", "feedback_loop", "prd_to_roadmap"]
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
SegmentStatus = Literal["pending", "running", "succeeded", "failed", "cancelled"]
CheckpointKind = Literal[
    "baseline_confirm",
    "feature_set",
    "priority_order",
    "prd_review",
    "eng_review",
    "roadmap_items",
    "roadmap_review",
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


class KnobsOut(BaseModel):
    depth: Depth
    roles: dict[str, list[str]]
    checkpoints: dict[str, bool]
    budget_usd: float | None = None


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
    template: str | None = Field(default=None, min_length=1, max_length=100)
    theme: str | None = Field(default=None, min_length=1, max_length=100)
    knobs: KnobsIn = KnobsIn()


class RunPatch(BaseModel):
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
    checkpoint: CheckpointKind
    approver_role: Role


class FlowOut(BaseModel):
    key: Flow
    title: str
    description: str
    requires_document: bool
    # The kind of document the run writes; None: the existing document's kind.
    target_kind: DocumentKind | None = None
    # The kind of approved document the run reads (prd_to_roadmap: a PRD).
    source_kind: DocumentKind | None = None
    segments: list[FlowSegmentOut]


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
    # Provenance recorded on the version (a roadmap's PRD version).
    source: VersionSource | None = None
    prd_links: PrdLinks | None = None


class ItemsProblem(BaseModel):
    code: str
    message: str
    item: str | None = None


class ItemsCheck(BaseModel):
    """The check of roadmap_items.yaml (oracle.runs.roadmap)."""

    items: int
    by_horizon: dict[str, int]
    problems: list[ItemsProblem]


class SegmentOut(BaseModel):
    id: uuid.UUID
    seq: int
    name: str
    title: str
    status: SegmentStatus
    roles: list[str]
    scopes: list[str]
    # The checkpoint this segment ends at, and whether it is on.
    checkpoint: CheckpointKind
    checkpoint_on: bool
    estimate_usd: float | None = None
    cost_usd: float
    workflow_id: str | None = None
    artifacts: list[str]
    attempts: list[SegmentAttempt]
    draft_import: DraftImport | None = None
    items_check: ItemsCheck | None = None
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
    # An open checkpoint answered in SwarmCloud's console, waiting on an approver (W5).
    console: ConsoleAnswer | None = None


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
    # theme.
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


class CheckpointDecision(BaseModel):
    # confirm, redo and continue answer what SwarmCloud's console recorded (W5, see
    # CheckpointOut.console): confirm takes an answer that did not count as the decision;
    # redo re-runs the segment as a new workflow with the console's findings (one more
    # segment); continue follows the workflow, which went on regardless.
    decision: Literal["approved", "changes_requested", "confirm", "redo", "continue"]
    # Required with changes_requested: it goes to the agents re-running the segment.
    note: str | None = Field(default=None, max_length=10_000)


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


class InboxCheckpoint(CheckpointOut):
    flow: Flow
    flow_title: str
    document_slug: str | None = None
    segment_title: str | None = None


class InboxFeedbackItem(BaseModel):
    id: uuid.UUID
    summary: str
    section_key: str | None = None
    raised_on_version: int
    created_at: datetime


class InboxDocument(BaseModel):
    document_id: uuid.UUID
    slug: str
    title: str
    latest_version: int | None = None
    open_count: int
    items: list[InboxFeedbackItem]


class InboxOut(BaseModel):
    checkpoints: list[InboxCheckpoint]
    # Owners only: runs waiting for cost approval, and runs paused on overrun.
    approvals: list[RunSummary]
    overruns: list[RunSummary]
    # Owners and the run's creator: runs whose lost submission is past the lookup cap
    # (RunSummary.stuck), to Retry or Cancel.
    lookups: list[RunSummary] = []
    # Owners and the run's creator: runs looking for an earlier submission given up on
    # (RunSummary.searching); shown only, nothing to decide, not in ``total``.
    searches: list[RunSummary] = []
    # Owners only: runs whose output Oracle stopped trying to import
    # (RunSummary.import_failed), to Retry.
    imports: list[RunSummary] = []
    # Approvers and owners: open feedback on documents they can approve.
    feedback: list[InboxDocument]
    total: int


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
