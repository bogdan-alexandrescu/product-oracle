"""Requests and responses of the intake routes, shaped for the screens that follow:
"New product idea" (IntakeCreate), "Opportunity and Gaps" (IntakeSummary), the
question batch view (QuestionBatch) and the Inbox's questions (C2: QuestionCreate,
QuestionPatch, InboxQuestion).
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field, field_validator, model_validator

from oracle.runs.schemas import KnobsIn
from oracle.templates.schemas import PrdAnswers
from oracle.v2.schemas import (
    ORM,
    AnswerKind,
    AssumptionDecisionKind,
    AssumptionDecisionOut,
    GapCategory,
    Importance,
    KnowledgeGapOut,
    KnowledgeState,
    ProductIntakeOut,
    StakeholderAnswerOut,
    StakeholderQuestionOut,
)

ProposalKind = Literal["research_run", "prd_patch"]
ProposalStatus = Literal["proposed", "accepted", "dismissed"]
ExtractedField = Literal[
    "users", "problem", "outcomes", "scope", "non_goals", "dependencies", "blockers"
]
ActionKind = Literal[
    "answer", "research", "delegate", "accept_assumption", "accept_risk", "validate"
]
AnswerPath = Literal["answer", "dont_know", "defer", "delegate", "research"]
# S6: what others see of a finding drawn from its author's own sources.
SharingLevel = Literal["private", "counts", "summary", "full"]
FindingKind = Literal["item", "gap", "conflict", "stale"]
ANSWER_PATHS: list[AnswerPath] = ["answer", "dont_know", "defer", "delegate", "research"]


# --- requests ----------------------------------------------------------------------------


def _line(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("an out-of-scope line needs some words")
    return value


# One out-of-scope line of a brief (C4).
OutOfScopeLine = Annotated[str, Field(min_length=1, max_length=300), AfterValidator(_line)]


class IntakeCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    # A couple of sentences is enough (§5).
    brief: str = Field(min_length=20, max_length=4000)
    # One of your snapshots to read; omitted: Oracle pins one now.
    snapshot_id: uuid.UUID | None = None
    # Your sources to read; empty: all of your sources.
    source_ids: list[uuid.UUID] = Field(default=[], max_length=50)
    # An existing PRD (slug or id) this intake informs.
    document: str | None = Field(default=None, min_length=1, max_length=200)
    # Queue light extraction on Oracle's built-in model jobs (Claude account pool).
    ai_extraction: bool = True
    # Questions in the first batch, asked at once.
    batch_size: int = Field(default=5, ge=1, le=10)
    # C4 One New PRD door. The confirmed goals the idea serves (422 if one is not a
    # confirmed goal): they answer the goal_alignment question as yours.
    goal_ids: list[uuid.UUID] = Field(default=[], max_length=10)
    # What is out of scope, one line each: they answer the non_goals question as yours.
    out_of_scope: list[OutOfScopeLine] = Field(default=[], max_length=20)
    # The PRD template and theme the draft uses (422 if unknown, archived or not for a
    # PRD); omitted: the company default, else Oracle's built-in default, at the run.
    template: str | None = Field(default=None, min_length=1, max_length=100)
    theme: str | None = Field(default=None, min_length=1, max_length=100)
    # The O1d answers that suggested the template (as POST /v1/drafts/recommend).
    prd_answers: PrdAnswers | None = None

    @field_validator("brief")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 20:
            raise ValueError("a brief needs at least a sentence")
        return value

    @field_validator("goal_ids")
    @classmethod
    def _unique_goals(cls, value: list[uuid.UUID]) -> list[uuid.UUID]:
        return list(dict.fromkeys(value))


class IntakePatch(BaseModel):
    lock_version: int
    title: str | None = Field(default=None, min_length=1, max_length=200)
    document: str | None = Field(default=None, min_length=1, max_length=200)
    status: Literal["archived", "awaiting_answers"] | None = None
    # C4: the brief's fields (the author or an approver; 409 once converted, that is once
    # its draft run started). Goals and out-of-scope lines answer their questions again
    # (a new answer; the latest wins).
    goal_ids: list[uuid.UUID] | None = Field(default=None, max_length=10)
    out_of_scope: list[OutOfScopeLine] | None = Field(default=None, max_length=20)
    template: str | None = Field(default=None, min_length=1, max_length=100)
    theme: str | None = Field(default=None, min_length=1, max_length=100)
    prd_answers: PrdAnswers | None = None

    @field_validator("goal_ids")
    @classmethod
    def _unique_goals(cls, value: list[uuid.UUID] | None) -> list[uuid.UUID] | None:
        return list(dict.fromkeys(value)) if value is not None else None


class GapCreate(BaseModel):
    intake_id: uuid.UUID
    category: GapCategory
    statement: str = Field(min_length=1, max_length=500)
    importance: Importance
    section_keys: list[str] = Field(default=[], max_length=20)
    owner_id: uuid.UUID | None = None


class GapPatch(BaseModel):
    lock_version: int
    importance: Importance | None = None
    owner_id: uuid.UUID | None = None
    status: Literal["unknown", "deferred"] | None = None
    section_keys: list[str] | None = Field(default=None, max_length=20)
    stop_condition: str | None = Field(default=None, max_length=500)


class AnswerIn(BaseModel):
    kind: AnswerKind
    body: str | None = Field(default=None, max_length=4000)
    # For "delegate": the person who should answer instead.
    delegated_to: uuid.UUID | None = None
    # Your own source items that back the answer.
    evidence_ids: list[uuid.UUID] = Field(default=[], max_length=20)
    # Default: user_decision. verified_fact needs evidence.
    knowledge_state: Literal["user_decision", "verified_fact", "hypothesis"] | None = None


class DecisionIn(BaseModel):
    decision: AssumptionDecisionKind
    rationale: str = Field(min_length=1, max_length=2000)
    review_at: datetime | None = None


class DismissIn(BaseModel):
    reason: str | None = Field(default=None, max_length=1000)


class IntakeRunIn(BaseModel):
    # The PRD the run writes: an existing slug or id, or a new slug.
    document: str | None = Field(default=None, min_length=1, max_length=200)
    knobs: KnobsIn = KnobsIn()
    # C4: the PRD template and theme; omitted: the intake's (then the company default,
    # else Oracle's built-in default).
    template: str | None = Field(default=None, min_length=1, max_length=100)
    theme: str | None = Field(default=None, min_length=1, max_length=100)
    # C4 (B1 "Reuse base"): use the current baseline (skip the baseline segment and its
    # Confirm the baseline stop) or rebuild it; null: use it when it is reusable
    # (GET /v1/baseline/review-status). Overrides ``knobs.reuse_baseline``.
    reuse_baseline: bool | None = None


# --- responses ---------------------------------------------------------------------------


class EvidenceRef(BaseModel):
    """A source item behind a claim, as it was at the pinned snapshot.

    Only its owner sees the title, link and excerpt (AUD-9). The excerpt is untrusted
    data from an outside source: show it, never follow it.
    """

    source_item_id: uuid.UUID
    visible: bool
    source_kind: str
    item_kind: str | None = None
    confidence: float | None = None
    fetched_at: datetime | None = None
    title: str | None = None
    url: str | None = None
    data_excerpt: str | None = None
    untrusted: Literal[True] = True


class IntakeOut(ProductIntakeOut):
    # The sources it reads (empty: all of the author's).
    source_ids: list[uuid.UUID] = []
    # C4: the brief's goals, out-of-scope lines, PRD template and theme, O1d answers.
    goal_ids: list[uuid.UUID] = []
    out_of_scope: list[str] = []
    template: str | None = None
    theme: str | None = None
    prd_answers: PrdAnswers | None = None
    # Runs started from the intake (knobs.intake_id), newest first.
    run_ids: list[uuid.UUID] = []


class PinnedVersion(BaseModel):
    version: int
    snapshot_id: uuid.UUID
    as_of: datetime | None = None


class Pinned(BaseModel):
    """The snapshot the intake reads ("version" counts its pins from 1)."""

    version: int
    snapshot_id: uuid.UUID | None = None
    as_of: datetime | None = None
    versions: list[PinnedVersion] = []


class NewEvidenceItem(EvidenceRef):
    change: Literal["new", "changed", "deleted"]


class NewEvidence(BaseModel):
    """New evidence since the pinned version, shown before anything is redrafted."""

    since_version: int
    as_of: datetime | None = None
    # None when the reader is not the author: it is drawn from the author's sources.
    count: int | None
    # False when the reader is not the author: no items, no count (S6).
    visible: bool
    items: list[NewEvidenceItem] = []


class ExtractedItem(BaseModel):
    field: ExtractedField
    # Oracle's summary instead of the model's sentence when shared at "summary".
    text: str
    knowledge_state: KnowledgeState
    origin: Literal["brief", "source", "baseline", "llm"]
    evidence: list[EvidenceRef] = []
    # Set when the item is a finding drawn from the author's sources (S6).
    finding_id: uuid.UUID | None = None
    sharing: SharingLevel | None = None


class Coverage(BaseModel):
    category: GapCategory
    state: Literal["covered", "partial", "missing"]
    knowledge_state: KnowledgeState
    reason: str
    entity_ids: list[uuid.UUID] = []
    gap_id: uuid.UUID | None = None


class GoalLink(BaseModel):
    entity_id: uuid.UUID
    key: str
    title: str
    status: str
    knowledge_state: KnowledgeState
    matched_on: Literal["brief", "feature"]


class FeatureTrace(BaseModel):
    """A feature the intake touches: from the baseline (``key``) or the brief."""

    title: str
    entity_id: uuid.UUID | None = None
    key: str | None = None
    knowledge_state: KnowledgeState
    goals: list[GoalLink] = []
    # serves_no_goal, no_evidence, low_confidence (the baseline traceability flags).
    flags: list[str] = []
    rationale: str


class ClaimOut(BaseModel):
    value: Any
    source_kind: str | None = None
    source_class: str | None = None
    observed_at: str | None = None
    confidence: float | None = None
    evidence: list[EvidenceRef] = []


class ConflictRecommendation(BaseModel):
    winner: int | None = None
    reason: str


class ConflictView(BaseModel):
    kind: Literal["source", "baseline"]
    # A source conflict shared at "summary": Oracle's summary, no values, no excerpts.
    topic: str
    claims: list[ClaimOut]
    recommendation: ConflictRecommendation
    material: bool
    conflict_id: uuid.UUID | None = None
    finding_id: uuid.UUID | None = None
    sharing: SharingLevel | None = None
    summary_only: bool = False


class StaleEvidence(BaseModel):
    evidence: EvidenceRef
    reason: str
    finding_id: uuid.UUID | None = None
    sharing: SharingLevel | None = None


class RankedGap(KnowledgeGapOut):
    rank: int
    score: float
    rank_reason: str
    evidence: list[EvidenceRef] = []
    # Set when the gap (model-written) or its evidence (rule-made) is a finding (S6).
    finding_id: uuid.UUID | None = None
    sharing: SharingLevel | None = None


class FindingCount(BaseModel):
    """Findings shared as counts and categories only (S6)."""

    kind: FindingKind
    category: str | None = None
    count: int
    label: str


class FindingOut(BaseModel):
    """A finding drawn from the author's own sources and what others see of it (S6).

    The author sees every finding. Anyone else sees those shared at "counts" or above:
    the kind and category; from "summary" its line and the gap; at "full" the source
    items it cites. ``summary``: the line the summary level shows, the one its author
    confirmed or wrote, else Oracle's fixed category line. ``draft_summary``: Oracle's
    draft, for the author only. At "full", others see the items it released when it was
    shared; ``unshared_item_ids`` (the author only): what it cites now that sharing did
    not release (a later analysis added them; "N new sources since you shared", share
    it in full again to release them)."""

    id: uuid.UUID
    kind: FindingKind
    origin: Literal["model", "rules"]
    category: str | None = None
    sharing: SharingLevel
    summary: str | None = None
    summary_confirmed: bool | None = None
    draft_summary: str | None = None
    gap_id: uuid.UUID | None = None
    source_item_ids: list[uuid.UUID] = []
    unshared_item_ids: list[uuid.UUID] = []


class SharingIn(BaseModel):
    sharing: SharingLevel


class FindingSummaryIn(BaseModel):
    """The line others see at the summary level: omit ``text`` to confirm Oracle's draft
    as it stands."""

    text: str | None = Field(default=None, max_length=240)


class SharingChange(BaseModel):
    finding_id: uuid.UUID
    sharing: SharingLevel


class SharingBulkIn(BaseModel):
    changes: list[SharingChange] = Field(min_length=1, max_length=500)


class NextAction(BaseModel):
    gap_id: uuid.UUID
    kind: ActionKind
    label: str
    # The lowest role that may take it.
    role: Literal["commenter", "approver", "owner"]


class ModuleHint(BaseModel):
    key: str
    policy: Literal["required", "conditional"]
    reason: str
    gap_ids: list[uuid.UUID] = []


class TemplateHint(BaseModel):
    """An existing PRD template (O1d picker) and module hints for the composer."""

    key: str
    name: str
    reason: str
    theme: str | None = None
    modules: list[ModuleHint]


class GateView(BaseModel):
    """The review gate as everyone sees it. ``private_blocking_gap_ids``: for the author
    only, their private critical blockers, which gate nothing until shared at counts or
    above (S6)."""

    open_critical: int
    blocking_gap_ids: list[uuid.UUID]
    gate: Literal["clear", "blocked"]
    private_blocking_gap_ids: list[uuid.UUID] = []


class BatchState(BaseModel):
    current: int | None
    asked: int
    answered: int
    remaining: int


class IntakeProposalOut(ORM):
    id: uuid.UUID
    intake_id: uuid.UUID
    gap_id: uuid.UUID | None = None
    question_id: uuid.UUID | None = None
    answer_id: uuid.UUID | None = None
    kind: ProposalKind
    title: str
    detail: dict[str, Any]
    status: ProposalStatus
    result: dict[str, Any]
    created_by: uuid.UUID | None = None
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    decision_note: str | None = None
    created_at: datetime
    updated_at: datetime


class AiReadCount(BaseModel):
    items: int
    gaps: int


class AiReadNote(BaseModel):
    code: str
    message: str


class AiReadOut(BaseModel):
    """INT2 Oracle's read of the intake, the author's only (``IntakeSummary.ai_read`` is
    null for anyone else). ``path``: what produced or is producing the read, a SwarmCloud
    run or Oracle's built-in job (the fallback, with ``fallback`` saying why, or the
    rollback); ``off_reason``: ``company`` (the switch on Settings › Company is off) or
    ``intake`` (no read was asked for this intake)."""

    state: Literal["off", "queued", "running", "done", "failed"]
    path: Literal["swarmcloud", "job"] | None = None
    off_reason: Literal["company", "intake"] | None = None
    run_id: uuid.UUID | None = None
    job_id: uuid.UUID | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    # The author's pinned source excerpts the read was given.
    sources: int = 0
    added: AiReadCount | None = None
    # Evidence refs the answer gave outside its input, dropped.
    dropped_refs: int = 0
    error: AiReadNote | None = None
    fallback: AiReadNote | None = None
    note: str | None = None
    # Failed reads in a row (two or more: one Inbox row until a read succeeds).
    failures: int = 0


class IntakeSummary(BaseModel):
    """The Opportunity and Gaps summary, as the reader may see it (S6)."""

    intake: IntakeOut
    pinned: Pinned
    new_evidence: NewEvidence
    extracted: list[ExtractedItem]
    coverage: list[Coverage]
    goals: list[GoalLink]
    missing_goals: bool
    features: list[FeatureTrace]
    conflicts: list[ConflictView]
    stale: list[StaleEvidence]
    # Open gaps resting on the brief's word or Oracle's inference.
    assumptions: list[RankedGap]
    top_uncertainties: list[RankedGap]
    gaps: list[RankedGap]
    next_actions: list[NextAction]
    template: TemplateHint
    readiness: GateView
    batch: BatchState
    proposals: list[IntakeProposalOut]
    # Findings the author shared as counts and categories only.
    shared_counts: list[FindingCount] = []
    # Whether the reader is the intake's author (sees every finding, sets sharing).
    is_author: bool = False
    # The latest draft run made from the intake (C5): what "Drafting" links to.
    draft_run_id: uuid.UUID | None = None
    # Answers given after that run started (it reads the ones before, C5); 0 unless
    # the intake is converted. The next draft takes them as feedback.
    answers_since_run: int = 0
    # INT2: Oracle's read, for the author only (null for anyone else).
    ai_read: AiReadOut | None = None


class QuestionCard(BaseModel):
    question: StakeholderQuestionOut
    gap: KnowledgeGapOut | None
    evidence: list[EvidenceRef]
    answer_paths: list[AnswerPath]
    answers: list[StakeholderAnswerOut]


class QuestionBatch(BaseModel):
    intake_id: uuid.UUID
    batch: int | None
    questions: list[QuestionCard]
    # Questions not asked yet.
    remaining: int


class NextBatch(BaseModel):
    """The next batch as it would be asked (C5): each question with the person it would
    be asked of, in order; asking it asks exactly these."""

    questions: list[QuestionCard]
    # Questions not asked yet, these included.
    remaining: int


class DraftGateClosedOut(BaseModel):
    """409: drafting waits until each shared critical question is answered or decided."""

    detail: str
    blocking_gap_ids: list[uuid.UUID]


class AnswerResult(BaseModel):
    answer: StakeholderAnswerOut
    question: StakeholderQuestionOut
    gap: KnowledgeGapOut | None
    proposals: list[IntakeProposalOut]
    baseline_proposal_ids: list[uuid.UUID]
    change_event_id: uuid.UUID | None
    next_actions: list[NextAction]


class DecisionResult(BaseModel):
    decision: AssumptionDecisionOut
    gap: KnowledgeGapOut


class EvidenceHit(EvidenceRef):
    # None when the item is not shown to the caller (``visible`` false).
    snippet: str | None = None
    relevance: float


class EvidenceSearch(BaseModel):
    intake_id: uuid.UUID
    q: str
    pinned_version: int
    as_of: datetime | None
    hits: list[EvidenceHit]


# --- questions to people (C2) ------------------------------------------------------------

SubjectKind = Literal["intake", "document_section", "checkpoint_item", "entity"]


class IntakeSubject(BaseModel):
    kind: Literal["intake"]
    intake_id: uuid.UUID


class DocumentSectionSubject(BaseModel):
    kind: Literal["document_section"]
    document_id: uuid.UUID
    section_key: str = Field(min_length=1, max_length=200)


class CheckpointItemSubject(BaseModel):
    kind: Literal["checkpoint_item"]
    checkpoint_id: uuid.UUID
    # The item's ref in the checkpoint's payload.
    item_ref: str = Field(min_length=1, max_length=200)


class EntitySubject(BaseModel):
    kind: Literal["entity"]
    entity_id: uuid.UUID


QuestionSubject = Annotated[
    IntakeSubject | DocumentSectionSubject | CheckpointItemSubject | EntitySubject,
    Field(discriminator="kind"),
]


class QuestionCreate(BaseModel):
    """Ask a named teammate (commenter or above) a question about a subject."""

    prompt: str = Field(min_length=1, max_length=1000)
    asked_to: uuid.UUID
    # Why you ask: shown with the question.
    rationale: str | None = Field(default=None, max_length=500)
    subject: QuestionSubject

    @field_validator("prompt")
    @classmethod
    def _prompt(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("A question needs some words")
        return v.strip()

    @field_validator("rationale")
    @classmethod
    def _rationale(cls, v: str | None) -> str | None:
        return (v or "").strip() or None


class QuestionPatch(BaseModel):
    """Reassign (``asked_to``) or withdraw (``status``), one at a time."""

    asked_to: uuid.UUID | None = None
    status: Literal["withdrawn"] | None = None

    @model_validator(mode="after")
    def _one(self) -> "QuestionPatch":
        if (self.asked_to is None) == (self.status is None):
            raise ValueError("Give either asked_to (reassign) or status: withdrawn")
        return self


class QuestionBatchAsk(BaseModel):
    """Ask the next batch; ``assign``: question id -> the person to ask instead of the
    default (the gap's owner, else the intake's author)."""

    size: int = Field(default=5, ge=1, le=10)
    assign: dict[uuid.UUID, uuid.UUID] = Field(default={}, max_length=50)


class OracleAsker(BaseModel):
    """The intake engine's question: "Oracle asks"."""

    kind: Literal["oracle"] = "oracle"


class PersonAsker(BaseModel):
    """A person's question to a teammate: "<name> asks"."""

    kind: Literal["person"] = "person"
    id: uuid.UUID
    name: str


class TokenAsker(BaseModel):
    """A company API token's question: "<token name> asks" (no person asked it)."""

    kind: Literal["api_client"] = "api_client"
    # The token's name, or "An API token" once the token is gone.
    name: str


class InboxSubject(BaseModel):
    kind: SubjectKind
    # "Before drafting · <intake>", "<PRD> · <section heading>", "Roadmap items · <item>",
    # "Baseline · <entity>".
    title: str
    # Where Open goes; None while the subject has no page to open.
    href: str | None


class InboxQuestion(BaseModel):
    question: StakeholderQuestionOut
    asked_by: Annotated[OracleAsker | PersonAsker | TokenAsker, Field(discriminator="kind")]
    subject: InboxSubject
    # The gap as the reader may see it (S6); None for a question with no gap.
    gap: KnowledgeGapOut | None
    # "research" only on intake questions with a gap (it proposes a research run).
    answer_paths: list[AnswerPath]
