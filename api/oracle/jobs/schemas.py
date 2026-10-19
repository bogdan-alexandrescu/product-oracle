import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.docs.schemas import WordOp

JobKind = Literal["review_comments", "reporting", "refinement"]
# Every kind a job row may have: the document kinds and the intake's (oracle.intake.job).
AnyJobKind = Literal["review_comments", "reporting", "refinement", "intake_analysis"]
JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
Classification = Literal["question", "change_request", "factual_correction", "approval", "other"]
SuggestionKind = Literal["section_text", "answer", "none", "duplicate"]
SuggestionStatus = Literal["open", "accepted", "dismissed", "applied", "superseded"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class LlmJobOut(ORM):
    id: uuid.UUID
    kind: AnyJobKind
    # Null for an intake job, which has intake_id instead.
    document_id: uuid.UUID | None = None
    intake_id: uuid.UUID | None = None
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


class RefineIn(BaseModel):
    # Accepted suggestions on this section to work in; default: all of them.
    suggestion_ids: list[uuid.UUID] | None = None
    instruction: str | None = Field(default=None, max_length=4000)


class RefinementApply(BaseModel):
    """Accept a refinement, optionally with the approver's own edit of it."""

    heading: str | None = Field(default=None, min_length=1, max_length=300)
    body_md: str | None = None


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
    text: str = Field(min_length=1)


class SuggestionAccept(BaseModel):
    # Accept with this text instead of the suggestion's (an edit at the same time).
    text: str | None = Field(default=None, min_length=1)
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
