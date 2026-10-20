import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.docs.schemas import DocumentStatus, Layer, Verdict, VersionSummary
from oracle.jobs.schemas import SuggestionOut

FeedbackStatus = Literal["open", "addressed", "declined", "superseded"]
# C1e, derived for people: open (waiting for a decision), staged (its suggestion was
# accepted and waits for the next draft), declined, done (addressed or superseded).
FeedbackState = Literal["open", "staged", "declined", "done"]
FeedbackKind = Literal["comment", "section_review", "general"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class TextQuoteSelector(BaseModel):
    """W3C Web Annotation TextQuoteSelector, relative to the section's body_text."""

    exact: str = Field(min_length=1)
    prefix: str = ""
    suffix: str = ""


class CommentCreate(BaseModel):
    section_key: str
    anchor: TextQuoteSelector
    body: str = Field(min_length=1)


class ReplyCreate(BaseModel):
    body: str = Field(min_length=1)


class CommentPatch(BaseModel):
    resolved: bool | None = None
    body: str | None = Field(default=None, min_length=1)


class CommentOut(ORM):
    id: uuid.UUID
    version_id: uuid.UUID
    section_key: str
    anchor: TextQuoteSelector | None = None  # None on replies
    body: str
    author_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None
    resolved_at: datetime | None = None
    created_at: datetime
    replies: list["CommentOut"] = []
    feedback_item_id: uuid.UUID | None = None
    # O1f: the commented section's layer in this version (brief or detail).
    layer: Layer | None = None


class SectionReviewIn(BaseModel):
    verdict: Verdict
    note: str | None = None


class SectionReviewOut(ORM):
    id: uuid.UUID
    version_id: uuid.UUID
    section_key: str
    verdict: Verdict
    note: str | None = None
    reviewer_id: uuid.UUID | None = None
    created_at: datetime
    feedback_item_id: uuid.UUID | None = None  # None for "approved"
    # O1f: the reviewed section's layer in this version (brief or detail).
    layer: Layer | None = None


class FeedbackItemOut(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    raised_on_version: int
    kind: FeedbackKind
    comment_id: uuid.UUID | None = None
    section_review_id: uuid.UUID | None = None
    section_key: str | None = None
    summary: str
    # Copied from the comment / verdict so the agent track needs no extra calls.
    anchor: TextQuoteSelector | None = None
    verdict: Verdict | None = None
    status: FeedbackStatus
    addressed_in_version: int | None = None
    resolution_note: str | None = None
    created_at: datetime
    updated_at: datetime
    # What Oracle's review-comments job suggests for this item (not superseded), if any.
    suggestion: SuggestionOut | None = None
    state: FeedbackState = "open"
    # Staged: the draft the next build would make (the latest version + 1).
    staged_for_version: int | None = None


class FeedbackPatch(BaseModel):
    status: FeedbackStatus | None = None
    resolution_note: str | None = None
    addressed_in_version: int | None = None


class Resolution(BaseModel):
    """One entry of a draft's front-matter ``resolutions`` list."""

    feedback_id: uuid.UUID
    status: Literal["addressed", "declined"]
    note: str | None = None


class FeedbackPackage(BaseModel):
    """What the agent track pulls to write the next draft."""

    document_id: uuid.UUID
    slug: str
    title: str
    version: int
    markdown: str
    open_items: list[FeedbackItemOut]
    # Sections whose latest verdict in this version is "approved": do not change them.
    locked_section_keys: list[str]
    generated_at: datetime


class ResolutionReport(BaseModel):
    """How each feedback item raised on earlier versions was handled, as of ``version``."""

    document_id: uuid.UUID
    version: int
    items: list[FeedbackItemOut]
    counts: dict[FeedbackStatus, int]


class ApproveOut(BaseModel):
    document_id: uuid.UUID
    document_status: DocumentStatus
    version: VersionSummary


class PublishBlock(BaseModel):
    """One reason a publish is refused."""

    # The readiness check that refused it.
    key: str
    # The blocker's id for ``critical_blockers``; otherwise the check's key.
    id: str
    title: str
    rationale: str


class PublishBlockedOut(BaseModel):
    """409 from approve: the PRD version may not be published (T2 publish gate, C5)."""

    # "<N> blocks: <titles>", or "v<M> exists: ..." when the version is not the latest.
    detail: str
    blocking: list[PublishBlock]
