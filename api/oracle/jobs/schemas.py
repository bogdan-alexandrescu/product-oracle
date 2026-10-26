import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.docs.schemas import WordOp
from oracle.jobs.prompting import MAX_BODY_CHARS

JobKind = Literal[
    "review_comments", "reporting", "refinement", "quality_review", "refinement_batch"
]
# Every kind a job row may have: the document kinds and the intake's (oracle.intake.job).
AnyJobKind = Literal[
    "review_comments",
    "reporting",
    "refinement",
    "quality_review",
    "refinement_batch",
    "intake_analysis",
    "decision_options",
    "scope_enhance",
    "why_not_reply",
]
JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
Classification = Literal["question", "change_request", "factual_correction", "approval", "other"]
SuggestionKind = Literal["section_text", "answer", "none", "duplicate"]
SuggestionStatus = Literal["open", "accepted", "dismissed", "applied", "superseded"]
# Section text an approver sends: at most the spec's 200k characters (422 past it).
SectionText = Annotated[str, Field(max_length=MAX_BODY_CHARS)]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class LlmJobOut(ORM):
    id: uuid.UUID
    kind: AnyJobKind
    # Null for an intake job, which has intake_id instead.
    document_id: uuid.UUID | None = None
    intake_id: uuid.UUID | None = None
    # A decision's options job (H1) has decision_id instead.
    decision_id: uuid.UUID | None = None
    # A requirement's enhancement at a feature-set review (C7) has scope_id instead.
    scope_id: uuid.UUID | None = None
    # A declined request's why-not replies (H10) have request_id instead.
    request_id: uuid.UUID | None = None
    version_number: int | None = None
    section_key: str | None = None
    status: JobStatus
    input: dict[str, Any] = {}
    output: dict[str, Any] | None = None
    # The Claude account that ran it; null with ``via`` "fallback_plan" or
    # "fallback_api_key" when the fallback credential did, or before it ran.
    account_label: str | None = None
    via: str | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    attempts: int
    error: str | None = None
    # Set when no Claude account could take the call: the pool's reason
    # (pool_paused, no_account_available, no_recent_reading, no_accounts_registered,
    # unusable) and the earliest reset when one is known.
    error_reason: str | None = None
    next_reset_at: datetime | None = None
    requested_by: uuid.UUID | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class JobCreate(BaseModel):
    """Queue a job by hand. Refinement has its own route (``.../sections/{key}/refine``)."""

    kind: Literal["review_comments", "reporting"]
    # Defaults to the latest version.
    version: int | None = Field(default=None, ge=1)
    # Reporting: the earlier version "what changed" is measured from (default n - 1).
    since: int | None = Field(default=None, ge=1)


class JobSettings(BaseModel):
    """Which built-in jobs run on this document (all on by default)."""

    review_comments: bool = True
    reporting: bool = True
    refinement: bool = True
    # Only ever queued by a person (POST .../quality-review), never on its own.
    quality_review: bool = True


class RefineIn(BaseModel):
    # Accepted suggestions on this section to work in; default: all of them.
    suggestion_ids: list[uuid.UUID] | None = None
    instruction: str | None = Field(default=None, max_length=4000)


class RefinementApply(BaseModel):
    """Accept a refinement, optionally with the approver's own edit of it."""

    heading: str | None = Field(default=None, min_length=1, max_length=300)
    body_md: SectionText | None = None


class PushbackSource(BaseModel):
    ref: str
    kind: Literal["goal", "evidence"]
    title: str
    url: str | None = None
    excerpt: str | None = None
    confidence: float | None = None


class Pushback(BaseModel):
    reason: str
    sources: list[PushbackSource]


class SuggestionOut(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    feedback_item_id: uuid.UUID
    job_id: uuid.UUID | None = None
    version_number: int
    classification: Classification
    group_key: str | None = None
    duplicate_of: uuid.UUID | None = None
    kind: SuggestionKind
    section_key: str | None = None
    text: str | None = None
    edited_text: str | None = None
    rationale: str | None = None
    pushback: Pushback | None = None
    status: SuggestionStatus
    override_reason: str | None = None
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    applied_in_version: int | None = None
    created_at: datetime
    updated_at: datetime


class SuggestionPatch(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_BODY_CHARS)


class SuggestionAccept(BaseModel):
    # Accept with this text instead of the suggestion's (an edit at the same time).
    text: str | None = Field(default=None, min_length=1, max_length=MAX_BODY_CHARS)
    # Required when Oracle pushed back: why the approver keeps their call (C1b).
    reason: str | None = None


class SuggestionDismiss(BaseModel):
    reason: str | None = None
    # Also decline the feedback item (taking Oracle's pushback, for instance).
    decline: bool = False


class ReportItem(BaseModel):
    feedback_id: uuid.UUID
    summary: str
    section_key: str | None = None
    status: str
    resolution_note: str | None = None
    addressed_in_version: int | None = None
    explanation: str = ""


class ResolutionNarrative(BaseModel):
    summary: str
    counts: dict[str, int]
    items: list[ReportItem]


class ChangedSection(BaseModel):
    section_key: str
    status: Literal["added", "removed", "changed"]
    heading: str
    summary: str = ""


class NewSource(BaseModel):
    title: str
    kind: str
    about: str | None = None
    url: str | None = None
    added_at: datetime


class ChangesReport(BaseModel):
    since: int | None = None
    summary: str
    sections: list[ChangedSection]
    new_sources: list[NewSource]


class VersionReports(BaseModel):
    document_id: uuid.UUID
    version: int
    # The reporting job the reports come from (the latest that succeeded), and the
    # latest reporting job whatever its state.
    report_job_id: uuid.UUID | None = None
    generated_at: datetime | None = None
    resolution: ResolutionNarrative | None = None
    changes: ChangesReport | None = None
    latest_job: LlmJobOut | None = None


class RefinementPreview(BaseModel):
    """What accepting a refinement would change: a word diff of the section."""

    section_key: str
    heading: str
    body_md: str
    words: list[WordOp]


class LlmJobsTick(BaseModel):
    ran: int
    succeeded: int
    failed: int
    retried: int
    errors: list[str]


# --- C1e: staged changes and the next draft ---------------------------------------------


class StagedChange(BaseModel):
    """An accepted section-text suggestion not applied in any draft yet."""

    suggestion_id: uuid.UUID
    feedback_item_id: uuid.UUID
    section_key: str
    # The heading in the latest version, else the one in the draft it was raised on.
    section_heading: str
    feedback_summary: str
    # The accepted text (the approver's edit when there is one).
    text: str
    accepted_by: uuid.UUID | None = None
    accepted_by_name: str | None = None
    accepted_at: datetime | None = None
    # The draft the reviewer read, and the one Oracle's suggestion was written against.
    raised_on_version: int
    suggested_on_version: int
    # The section is not in the latest version: not built (excluded by default).
    section_gone: bool = False
    # The section is approved (locked) in the latest version: building it is refused.
    section_locked: bool = False


class AgentItem(BaseModel):
    """D12: a feedback item an approver staged for the agents (no section text to accept)."""

    feedback_id: uuid.UUID
    summary: str
    # None: a remark about the whole draft (General).
    section_key: str | None = None
    staged_by_name: str | None = None
    staged_at: datetime | None = None


class StagedDiscussionChange(BaseModel):
    """G4: a discussion's section change staged for the next draft (``next_draft_changes``)."""

    id: uuid.UUID
    source: Literal["next_draft_change"] = "next_draft_change"
    section_key: str
    section_heading: str
    instruction: str
    # A proposed section body, when the discussion settled on one.
    text: str | None = None
    reason: str | None = None
    # "From discussion <title>", or "From a private discussion" to a reader not in it.
    origin_line: str
    discussion_id: uuid.UUID | None = None
    discussion_title: str | None = None
    from_private: bool = False
    staged_by_name: str | None = None
    staged_at: datetime | None = None
    raised_on_version: int
    section_gone: bool = False
    section_locked: bool = False
    lock_version: int


class NextDraftRun(BaseModel):
    """#574 review: the agents' run under way on a document (Build next draft sent it the
    items below): what it was sent is not staged for another build until it ends, and no
    other build of the document starts meanwhile."""

    id: uuid.UUID
    flow: str
    flow_title: str
    status: str
    created_at: datetime
    # What it was sent that is still staged: back in the lists if the run ends without
    # a draft (failed, cancelled); applied when its draft is imported.
    items: list[StagedChange] = []
    agent_items: list[AgentItem] = []
    next_draft_changes: list[StagedDiscussionChange] = []


class StagedChanges(BaseModel):
    document_id: uuid.UUID
    slug: str
    latest_version: int | None = None
    # The draft a build would make (latest + 1).
    next_version: int
    items: list[StagedChange]
    # Staged items whose section is gone (listed only with include_gone).
    gone_count: int = 0
    # A typical cost of building these sections, from earlier refinements; None
    # without history.
    estimate_usd: float | None = None
    # The current next-draft build (queued, running, failed, or ready to preview), if any.
    draft_job: LlmJobOut | None = None
    # D12: feedback items staged for the agents, oldest first.
    agent_items: list[AgentItem] = []
    # G4: section changes staged from discussions, oldest first (gone ones only with
    # include_gone).
    next_draft_changes: list[StagedDiscussionChange] = []
    # #574 review: the agents' run under way on the document, with what it was sent (left
    # out of the lists above).
    agents_run: NextDraftRun | None = None


class NextDraftIn(BaseModel):
    # The staged suggestions to build; default: every staged one whose section exists.
    suggestion_ids: list[uuid.UUID] | None = None
    # D12: the items staged for the agents to build with; default: every one.
    feedback_ids: list[uuid.UUID] | None = None
    # G4: the discussions' section changes to build; default: every staged one whose
    # section exists.
    next_draft_change_ids: list[uuid.UUID] | None = None


class NextDraftPlanIn(NextDraftIn):
    # The depth of the agents' run (its estimate); ignored when Oracle builds.
    depth: Literal["quick", "standard", "deep"] = "standard"


class NextDraftRunIn(NextDraftPlanIn):
    pass


class NextDraftReason(BaseModel):
    """Why the agents write the next draft, in plain words, with the items it is about."""

    code: Literal["whole_draft", "structure", "section_gone", "roadmap_items"]
    text: str
    feedback_ids: list[uuid.UUID] = []
    suggestion_ids: list[uuid.UUID] = []


class NextDraftPlan(BaseModel):
    """D12: which engine builds the chosen staged items, and why.

    ``oracle``: Oracle's own refinement batch rewrites the sections and shows a preview.
    ``agents``: a feedback-loop run writes the draft (``why`` says why)."""

    engine: Literal["oracle", "agents"]
    why: list[NextDraftReason] = []
    text_changes: int
    agent_items: int
    # The sections the chosen text changes touch.
    sections: int
    next_version: int
    # The agents' run: its estimate, and whether it is over the owner-approval threshold.
    needs_owner_approval: bool = False
    estimate_usd: float | None = None
    # Why a build cannot start (a locked section, the Refinement job switched off).
    refused: str | None = None


class NextDraftFeedback(BaseModel):
    id: uuid.UUID
    summary: str


class NextDraftResolution(BaseModel):
    feedback_id: uuid.UUID
    status: Literal["addressed", "declined"]
    note: str | None = None


class NextDraftDataPoint(BaseModel):
    value: str
    as_of: str = ""
    source: str = ""


class NextDraftInstruction(BaseModel):
    """G4: a discussion's change the section was built with."""

    next_draft_change_id: uuid.UUID
    instruction: str
    text: str | None = None
    # "From discussion <title>" or "From a private discussion".
    origin: str


class NextDraftSection(BaseModel):
    section_key: str
    heading: str
    before_heading: str
    before_body_md: str
    body_md: str
    words: list[WordOp]
    notes: str = ""
    o1c_fixes: list[str] = []
    data_points: list[NextDraftDataPoint] = []
    resolutions: list[NextDraftResolution] = []
    suggestion_ids: list[uuid.UUID] = []
    feedback: list[NextDraftFeedback] = []
    next_draft_change_ids: list[uuid.UUID] = []
    instructions: list[NextDraftInstruction] = []


class SkippedSection(BaseModel):
    section_key: str | None = None
    suggestion_ids: list[uuid.UUID] = []
    reason: str


class NextDraftPreview(BaseModel):
    """The combined preview of a next-draft build: one entry per revised section.

    Sections are empty until the job has succeeded (``job.status`` says where it is)."""

    job: LlmJobOut
    base_version: int | None = None
    next_version: int | None = None
    latest_version: int | None = None
    # A newer version appeared since the build started: it can no longer be applied.
    stale: bool = False
    applied_version: int | None = None
    discarded: bool = False
    notes: str = ""
    sections: list[NextDraftSection] = []
    skipped: list[SkippedSection] = []


class NextDraftApply(BaseModel):
    # Sections not to change in this draft; their suggestions stay staged.
    drop_sections: list[str] = []
    # The approver's own body for a kept section (house rules applied).
    edits: dict[str, SectionText] = {}
