import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

Flow = Literal["baseline_to_prd", "feedback_loop"]
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
    "baseline_confirm", "feature_set", "priority_order", "prd_review", "eng_review"
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
    # The PRD: an existing document's slug or id, or a new slug (baseline_to_prd only;
    # the document is created when the draft is imported).
    document: str | None = Field(default=None, min_length=1, max_length=200)
    knobs: KnobsIn = KnobsIn()


class RunPatch(BaseModel):
    document: str | None = Field(default=None, min_length=1, max_length=200)
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
    note: str | None = None
    state: str | None = None


class DraftImport(BaseModel):
    document_id: uuid.UUID | None = None
    slug: str | None = None
    version: int | None = None
    created: bool | None = None
    warnings: list[str] = []
    error: str | None = None


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
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None


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


class RunSummary(BaseModel):
    id: uuid.UUID
    flow: Flow
    flow_title: str
    status: RunStatus
    document_id: uuid.UUID | None = None
    document_slug: str | None = None
    estimate_usd: float | None = None
    spent_usd: float
    created_by: uuid.UUID | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    # The kind of the checkpoint the run waits on, if any.
    waiting_on: CheckpointKind | None = None
    error: str | None = None


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


class CheckpointDecision(BaseModel):
    decision: Literal["approved", "changes_requested"]
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
    # "ran", "skipped" (another sweep holds the lease) or "error".
    lease: str = "ran"
    errors: list[str] = []


class TickOut(BaseModel):
    runs_checked: int
    segments_finished: int
    runs_advanced: int
    runs_paused: int
    errors: list[str]
    claude_accounts: ClaudeSweepSummary | None = None


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
    # Approvers and owners: open feedback on documents they can approve.
    feedback: list[InboxDocument]
    total: int
