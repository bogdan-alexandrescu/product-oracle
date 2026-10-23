import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from oracle.baseline.goals import GoalCheck, goal_check

EntityType = Literal[
    "goal",
    "product",
    "feature",
    "requirement",
    "constraint",
    "decision",
    "person",
    "outcome",
    "acceptance_criterion",
    "assumption",
    "risk",
    "strategy_choice",
]
EdgeType = Literal[
    "supports",
    "depends_on",
    "blocks",
    "part_of",
    "owned_by",
    "derived_from",
    "verifies",
    "affects",
    "mitigates",
]
NodeStatus = Literal["proposed", "confirmed", "rejected"]
Origin = Literal["user", "agent", "import"]
# Who a write comes from. "user" (a person, or an API token acting as one) locks what
# it touches; "agent" writes to a locked item become proposals.
WriteOrigin = Literal["user", "agent"]
ProposalStatus = Literal["open", "accepted", "rejected"]
ConflictStatus = Literal["open", "resolved", "logged"]
# Public-link evidence is scored like a source of this kind.
LinkKind = Literal["notion", "google_docs", "web"]

KEY_PATTERN = r"^[a-z0-9][a-z0-9._-]*$"


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- entities and edges -----------------------------------------------------------


class EntityCreate(BaseModel):
    type: EntityType
    key: str = Field(min_length=1, max_length=120, pattern=KEY_PATTERN)
    title: str = Field(min_length=1)
    body: str | None = None
    attrs: dict[str, Any] = {}
    # Goals always start proposed and go through POST .../confirm.
    status: NodeStatus | None = None
    # #345: a goal's parent goal (a subgoal); goals only, one level.
    parent_id: uuid.UUID | None = None
    origin: WriteOrigin = "user"
    run_id: uuid.UUID | None = None
    reason: str | None = None


class EntityPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    body: str | None = None
    # Merged into the current attrs; a null value removes the key.
    attrs: dict[str, Any] | None = None
    status: NodeStatus | None = None
    # #345: move a subgoal to another parent goal; null promotes it to a goal.
    parent_id: uuid.UUID | None = None
    origin: WriteOrigin = "user"
    run_id: uuid.UUID | None = None
    reason: str | None = None


class Lock(BaseModel):
    locked: bool
    locked_by: uuid.UUID | None = None
    locked_at: datetime | None = None


class GoalProgress(BaseModel):
    """#345: a goal's progress, 0 to 1: its own measurement ("own") when it has one, else
    the weighted progress of its subgoals ("subgoals"); null source without either."""

    value: float | None = None
    source: Literal["own", "subgoals"] | None = None
    # Its subgoals, archived ones left out.
    subgoals: int = 0


class EntityOut(ORM):
    id: uuid.UUID
    type: EntityType
    key: str
    title: str
    body: str | None = None
    attrs: dict[str, Any]
    status: NodeStatus
    origin: Origin
    locked: bool
    locked_by: uuid.UUID | None = None
    locked_at: datetime | None = None
    confidence: float | None = None
    run_id: uuid.UUID | None = None
    evidence_count: int = 0
    created_at: datetime
    updated_at: datetime
    # B5: whether a goal is measurable, what it misses and its warnings; null otherwise.
    goal_check: GoalCheck | None = None
    # #345: the goal this one is a subgoal of, and a goal's progress with its roll-up.
    parent_id: uuid.UUID | None = None
    progress: GoalProgress | None = None

    @model_validator(mode="after")
    def _check_goal(self) -> "EntityOut":
        if self.type == "goal" and self.goal_check is None:
            self.goal_check = GoalCheck(**goal_check(self.attrs, status=self.status))
        return self


class EdgeCreate(BaseModel):
    src_id: uuid.UUID
    dst_id: uuid.UUID
    type: EdgeType
    # "supports" carries {"contribution": 0-3}.
    attrs: dict[str, Any] = {}
    status: NodeStatus | None = None
    origin: WriteOrigin = "user"
    run_id: uuid.UUID | None = None
    reason: str | None = None


class EdgePatch(BaseModel):
    attrs: dict[str, Any] | None = None
    status: NodeStatus | None = None
    origin: WriteOrigin = "user"
    run_id: uuid.UUID | None = None
    reason: str | None = None


class EdgeOut(ORM):
    id: uuid.UUID
    src_id: uuid.UUID
    dst_id: uuid.UUID
    type: EdgeType
    attrs: dict[str, Any]
    status: NodeStatus
    origin: Origin
    locked: bool
    locked_by: uuid.UUID | None = None
    locked_at: datetime | None = None
    confidence: float | None = None
    run_id: uuid.UUID | None = None
    evidence_count: int = 0
    created_at: datetime
    updated_at: datetime


class OriginIn(BaseModel):
    origin: WriteOrigin = "user"
    run_id: uuid.UUID | None = None
    reason: str | None = None


class RevisionOut(ORM):
    id: uuid.UUID
    entity_id: uuid.UUID | None = None
    edge_id: uuid.UUID | None = None
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    actor: str
    reason: str | None = None
    created_at: datetime


# --- evidence ----------------------------------------------------------------------


class EvidenceCreate(BaseModel):
    """Evidence from one of your own source items (url, ref and an excerpt are copied
    from it unless given), or free-standing (url / ref / excerpt only)."""

    source_item_id: uuid.UUID | None = None
    url: str | None = None
    excerpt: str | None = None
    ref: str | None = None
    retrieved_at: datetime | None = None


class SourceItemRef(BaseModel):
    """The item behind a piece of evidence. Only its owner ever sees this."""

    id: uuid.UUID
    source_id: uuid.UUID
    source_kind: str
    kind: str
    title: str | None = None
    url: str | None = None


class LinkTarget(BaseModel):
    """Exactly one of entity_id or edge_id."""

    entity_id: uuid.UUID | None = None
    edge_id: uuid.UUID | None = None
    # https only: a public Notion page, a Google Doc shared with anyone with the link,
    # or a public web page. Fetched without any credential.
    url: str = Field(min_length=1, max_length=2048)


class EvidenceLinkCreate(LinkTarget):
    note: str | None = Field(default=None, max_length=2000)


class LinkSnapshotOut(BaseModel):
    """The public page behind a piece of evidence, as last fetched. Everyone sees it."""

    kind: LinkKind
    final_url: str
    title: str | None = None
    fetched_at: datetime
    # When the page says it last changed; freshness uses it, else fetched_at.
    last_modified: datetime | None = None
    text_chars: int = 0


class LinkPreviewOut(BaseModel):
    """What adding the link would save: its title, excerpt and confidence."""

    url: str
    kind: LinkKind
    final_url: str
    title: str | None = None
    excerpt: str
    fetched_at: datetime
    last_modified: datetime | None = None
    confidence: float
    confidence_factors: dict[str, Any] = {}
    # True when the entity or edge already cites this link (refresh it instead).
    already_cited: bool = False


class LinkErrorOut(BaseModel):
    """A link that cannot be used: ``not_public``, ``blocked_address``, ``not_https``..."""

    detail: str
    code: str


class EvidenceOut(BaseModel):
    id: uuid.UUID
    entity_id: uuid.UUID | None = None
    edge_id: uuid.UUID | None = None
    url: str | None = None
    excerpt: str | None = None
    ref: str | None = None
    retrieved_at: datetime | None = None
    # Kind of source it came from ("slack", "github:issue", "manual" when free-standing).
    source_kind: str
    # The source item, for its owner only.
    source_item: SourceItemRef | None = None
    # True when the evidence comes from someone else's source item: you see the
    # excerpt, url and ref, never the item.
    source_item_private: bool = False
    # The source item it came from was removed (a narrowed source, or deleted
    # upstream: S5): show 'source removed'. The copied excerpt, url and ref stay.
    source_removed: bool = False
    confidence: float | None = None
    # {"inputs": {...}, "breakdown": {factor: {value, weight}}, "weights": {...}}
    confidence_factors: dict[str, Any] = {}
    scored_at: datetime | None = None
    created_at: datetime
    # Public-link evidence: its kind, the note it was added with and its page.
    kind: LinkKind | None = None
    note: str | None = None
    link: LinkSnapshotOut | None = None


class EntityDetail(EntityOut):
    evidence: list[EvidenceOut] = []
    edges_out: list[EdgeOut] = []
    edges_in: list[EdgeOut] = []
    open_proposals: int = 0


class EdgeDetail(EdgeOut):
    evidence: list[EvidenceOut] = []


class GraphOut(BaseModel):
    entities: list[EntityOut]
    edges: list[EdgeOut]


# --- proposals -----------------------------------------------------------------------


class ProposalCreate(BaseModel):
    """Suggest a change for an approver to accept: commenters and agents use this."""

    op: Literal["create", "update", "delete"]
    kind: Literal["entity", "edge"]
    # Target of an update or delete.
    entity_id: uuid.UUID | None = None
    edge_id: uuid.UUID | None = None
    # Entity or edge fields (as in EntityCreate / EdgeCreate / the patches).
    fields: dict[str, Any] = {}
    run_id: uuid.UUID | None = None
    reason: str | None = None


class ProposalRun(BaseModel):
    """The run that made a proposal, enough to name it and link to it."""

    id: uuid.UUID
    flow: str
    flow_title: str
    status: str
    created_at: datetime


class ProposalProposer(BaseModel):
    """Who made a proposal, in words (B4): a run, an intake answer (never the person, S6),
    a member, an API token, or Oracle itself."""

    kind: Literal["run", "intake", "person", "token", "oracle"]
    # "Baseline to PRD · Oct 16", "From an intake answer", "First Last", "API token “CI”", "Oracle"
    label: str
    run_id: uuid.UUID | None = None
    # A person's: the web says "You" when it is the signed-in member's.
    user_id: uuid.UUID | None = None
    email: str | None = None


class ProposalOverlap(BaseModel):
    """A field an open proposal would change that has changed since it was written (#268):
    by accepting another proposal, or by an edit."""

    # "title", "body", "status" or "attrs.<key>"
    field: str
    current: Any = None
    proposed: Any = None
    changed_at: datetime
    by: Literal["proposal", "edit"]


class ProposalOut(ORM):
    id: uuid.UUID
    entity_id: uuid.UUID | None = None
    edge_id: uuid.UUID | None = None
    # {"op", "kind", "fields", "reason", "origin"}
    payload: dict[str, Any]
    run_id: uuid.UUID | None = None
    # Null when no run made it, or the run was deleted.
    run: ProposalRun | None = None
    # The change as one plain sentence; a decided proposal keeps the one its decider read.
    summary: str
    proposer: ProposalProposer
    actor: str | None = None
    status: ProposalStatus
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    created_at: datetime
    # An open update's fields whose value changed since it was written; accepting it
    # would undo that change.
    overlaps: list[ProposalOverlap] = []


class ProposalDecision(BaseModel):
    note: str | None = None


class ProposalAccept(ProposalDecision):
    # Fields to keep as they are ("milestone" means "attrs.milestone"); the rest apply,
    # and the decision records them as payload.skipped_fields.
    skip_fields: list[str] = []


class EntityWriteOut(BaseModel):
    """A write either applied (``entity``) or became a proposal (the item is locked)."""

    applied: bool
    entity: EntityOut | None = None
    proposal: ProposalOut | None = None


class EdgeWriteOut(BaseModel):
    applied: bool
    edge: EdgeOut | None = None
    proposal: ProposalOut | None = None


# --- conflicts -------------------------------------------------------------------------


class ClaimIn(BaseModel):
    value: Any
    evidence_ids: list[uuid.UUID] = []
    # "github", "github:issue", "slack", ... or a class: "code", "tracker", "docs",
    # "meeting", "chat". Derived from the evidence when omitted.
    source_kind: str | None = None
    observed_at: datetime | None = None


class ConflictCreate(BaseModel):
    entity_id: uuid.UUID | None = None
    edge_id: uuid.UUID | None = None
    # "title", "body", "status" or "attrs.<key>" (a bare key means attrs.<key>).
    field: str = Field(min_length=1)
    claims: list[ClaimIn] = Field(min_length=2)
    run_id: uuid.UUID | None = None


class ConflictResolve(BaseModel):
    # Index of the winning claim, or a value of your own.
    claim: int | None = None
    value: Any = None
    note: str | None = None


class ConflictOut(ORM):
    id: uuid.UUID
    entity_id: uuid.UUID | None = None
    edge_id: uuid.UUID | None = None
    field: str
    claims: list[dict[str, Any]]
    resolution: dict[str, Any] | None = None
    material: bool
    status: ConflictStatus
    created_at: datetime


# --- traceability --------------------------------------------------------------------


class TraceGoalLink(BaseModel):
    goal_id: uuid.UUID
    key: str
    title: str
    contribution: int


class TraceFeature(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    status: NodeStatus
    confidence: float | None = None
    evidence_count: int
    goals: list[TraceGoalLink]
    # "serves_no_goal", "no_evidence", "low_confidence"
    flags: list[str]


class TraceGoalFeature(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    contribution: int


class TraceGoal(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    status: NodeStatus
    weight: float | None = None
    confidence: float | None = None
    features: list[TraceGoalFeature]
    # Sum of the supporting features' contributions.
    coverage: int


class TraceSummary(BaseModel):
    features: int
    flagged: int
    serves_no_goal: int
    weak_evidence: int
    goals: int
    confirmed_goals: int
    uncovered_goals: int


class TraceReport(BaseModel):
    low: float
    features: list[TraceFeature]
    flagged: list[TraceFeature]
    goals: list[TraceGoal]
    summary: TraceSummary


# --- yaml / rescore ---------------------------------------------------------------------


class ImportIssue(BaseModel):
    code: str
    message: str
    where: str | None = None


class YamlImportResult(BaseModel):
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    proposals: int = 0
    evidence_added: int = 0
    notes: list[ImportIssue] = []


class YamlImportError(BaseModel):
    detail: str
    errors: list[ImportIssue]


class RescoreResult(BaseModel):
    evidence: int
    entities: int
    edges: int


class BaselineSegmentUsd(BaseModel):
    quick: float
    standard: float
    deep: float


class ReviewStatusOut(BaseModel):
    """Whether a new PRD run may use the current baseline (B1 "Reuse base"): the last
    baseline review (the newest approved Confirm the baseline) was approved in the past
    30 days and no baseline build is under way."""

    last_approved_at: datetime | None = None
    checkpoint_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    age_days: int | None = None
    build_under_way: bool
    reusable: bool
    # When not reusable: too_old, never_reviewed or build_under_way.
    reason: Literal["too_old", "never_reviewed", "build_under_way"] | None = None
    # The baseline segment's estimate per depth: what Rebuild adds to a run.
    baseline_segment_usd: BaselineSegmentUsd


# --- goals (B5) ----------------------------------------------------------------------------


class MeasurementCreate(BaseModel):
    value: float = Field(allow_inf_nan=False)
    measured_on: date
    note: str | None = Field(None, max_length=500)
    evidence_id: uuid.UUID | None = None


class MeasurementOut(ORM):
    id: uuid.UUID
    entity_id: uuid.UUID
    value: float
    measured_on: date
    note: str | None = None
    evidence_id: uuid.UUID | None = None
    recorded_by: uuid.UUID | None = None
    created_at: datetime


class FilledText(BaseModel):
    entity_id: uuid.UUID
    field: str
    text: str


class FillFromTextResult(BaseModel):
    applied: int
    proposed: int
    left_as_text: list[FilledText]
