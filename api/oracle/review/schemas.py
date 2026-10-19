import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.docs.schemas import DocumentStatus, Layer, Verdict, VersionSummary, WordOp
from oracle.jobs.schemas import SuggestionOut

FeedbackStatus = Literal["open", "addressed", "declined", "superseded"]
FeedbackKind = Literal["comment", "section_review", "general"]
# A change request's severity (v2, §9).
Severity = Literal["critical", "major", "minor"]


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
    # Classify the comment as a change request of this severity (its feedback item).
    severity: Severity | None = None


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
    # The section revision (content hash) the reviewer read. When given and the
    # document's latest version has another revision of the section, the verdict is
    # refused with a 409 SectionConflict: an approval binds to the exact revision.
    revision: str | None = None
    # Severity of the change request a non-approved verdict opens.
    severity: Severity | None = None


class SectionReviewOut(ORM):
    id: uuid.UUID
    version_id: uuid.UUID
    section_key: str
    verdict: Verdict
    note: str | None = None
    reviewer_id: uuid.UUID | None = None
    created_at: datetime
    # The section revision (content hash) the verdict binds to.
    section_hash: str | None = None
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
    severity: Severity | None = None
    created_at: datetime
    updated_at: datetime
    # What Oracle's review-comments job suggests for this item (not superseded), if any.
    suggestion: SuggestionOut | None = None


class FeedbackPatch(BaseModel):
    status: FeedbackStatus | None = None
    resolution_note: str | None = None
    addressed_in_version: int | None = None
    severity: Severity | None = None


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


# --- v2: section review state, assignments, policy (CR-06) ------------------------------

SectionStatus = Literal[
    # No verdict on this section yet.
    "unreviewed",
    # Approved on its current revision.
    "approved",
    # Was approved, then the text changed (or a change invalidated the approval).
    "approval_stale",
    "changes_requested",
    "rejected",
    # A change was requested on an earlier revision; the text changed since.
    "revised",
]
SectionApprovalPolicy = Literal["required_sections", "all_sections", "none"]
PolicySource = Literal["document", "company", "default"]


class SectionApproval(BaseModel):
    """The approval a section's current revision holds (or held, when stale)."""

    review_id: uuid.UUID
    reviewer_id: uuid.UUID | None = None
    # The version the verdict was given on; it holds in later versions with the same
    # revision.
    version: int
    revision: str | None = None
    approved_at: datetime


class SectionInvalidation(BaseModel):
    at: datetime
    change_id: uuid.UUID | None = None
    # The revision the invalidated approval was given on.
    revision: str | None = None


class MandatoryApproval(BaseModel):
    reviewer_id: uuid.UUID
    approved: bool


class SectionStateOut(BaseModel):
    """Review status of one section of a version, for the document views."""

    section_key: str
    heading: str
    ordinal: int
    layer: Layer
    # The section's revision: its content hash. Send it back as ``base_revision`` when
    # saving and as ``revision`` with a verdict.
    revision: str
    # The first version (counting back without a change) that has this revision.
    revision_since_version: int
    status: SectionStatus
    approval: SectionApproval | None = None
    invalidated: SectionInvalidation | None = None
    rereview_requested: bool = False
    # A required section (template, composition or policy).
    required: bool = False
    # Whether a publish needs an approval of this section's current revision.
    approval_required: bool = False
    mandatory_approvals: list[MandatoryApproval] = []
    owner_id: uuid.UUID | None = None
    reviewer_ids: list[uuid.UUID] = []
    due_at: datetime | None = None
    overdue: bool = False
    open_feedback: int = 0
    open_by_severity: dict[str, int] = {}
    # The assignment row's lock_version (null when nothing is assigned yet).
    lock_version: int | None = None


class SectionStatesOut(BaseModel):
    document_id: uuid.UUID
    version: int
    latest_version: int
    sections: list[SectionStateOut]
    counts: dict[SectionStatus, int]


class SectionAssignmentIn(BaseModel):
    owner_id: uuid.UUID | None = None
    reviewer_ids: list[uuid.UUID] = Field(default=[], max_length=50)
    due_at: datetime | None = None
    # The lock_version last read; null when the section has no assignment yet. A stale
    # value is a 409.
    lock_version: int | None = None


class SectionAssignmentOut(BaseModel):
    document_id: uuid.UUID
    section_key: str
    owner_id: uuid.UUID | None = None
    reviewer_ids: list[uuid.UUID] = []
    due_at: datetime | None = None
    overdue: bool = False
    lock_version: int
    updated_at: datetime


class ReviewQueueItem(BaseModel):
    """A section the caller owns or reviews, in the latest version of its document."""

    document_id: uuid.UUID
    slug: str
    title: str
    version: int
    section_key: str
    heading: str
    role: Literal["owner", "reviewer"]
    status: SectionStatus
    rereview_requested: bool = False
    due_at: datetime | None = None
    overdue: bool = False


class ReviewPolicyIn(BaseModel):
    decider_id: uuid.UUID | None = None
    mandatory_reviewer_ids: list[uuid.UUID] = Field(default=[], max_length=20)
    required_section_keys: list[str] = Field(default=[], max_length=200)
    section_approval: SectionApprovalPolicy = "required_sections"
    rereview_on_change: bool = True
    # The lock_version last read; null when the document has no policy of its own yet.
    lock_version: int | None = None


class ReviewPolicyOut(BaseModel):
    document_id: uuid.UUID
    decider_id: uuid.UUID | None = None
    mandatory_reviewer_ids: list[uuid.UUID] = []
    required_section_keys: list[str] = []
    section_approval: SectionApprovalPolicy = "required_sections"
    rereview_on_change: bool = True
    # Where it comes from: the document's own policy, the company setting
    # ``review_policy``, or the built-in default.
    source: PolicySource = "default"
    lock_version: int | None = None


# --- v2: concurrency conflicts ----------------------------------------------------------


class ConflictSection(BaseModel):
    section_key: str
    # The revision the edit started from, the revision now in the latest version, and
    # the edit's own (None where a side has no such section).
    base_revision: str | None = None
    current_revision: str | None = None
    your_revision: str | None = None
    current_heading: str | None = None
    current_body_md: str | None = None


class ConflictResponse(BaseModel):
    """409: the save started from an older state. Reload ``latest_version``, merge the
    listed sections and save again with the new base."""

    detail: str
    code: Literal["version_conflict", "section_conflict", "stale_lock_version"]
    base_version: int | None = None
    latest_version: int | None = None
    sections: list[ConflictSection] = []
    # The front matter (title, template, citations, brief...) changed between the base
    # and the latest version, and the draft does not have the latest's.
    front_matter_changed: bool = False
    current_lock_version: int | None = None


class SectionEditIn(BaseModel):
    """Save one section: the next version is the latest with this section replaced."""

    # The version and the section revision the editor loaded.
    base_version: int = Field(ge=1)
    base_revision: str = Field(min_length=1)
    heading: str | None = Field(default=None, min_length=1, max_length=300)
    body_md: str
    # Feedback items this edit addresses (the draft format's ``resolutions``).
    resolutions: list[Resolution] = []


# --- v2: section patches ----------------------------------------------------------------

PatchOrigin = Literal["run", "llm_job", "agent", "person"]
PatchStatus = Literal["open", "accepted", "rejected", "superseded"]
PatchAction = Literal["replace", "remove"]


class SectionPatchOut(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    section_key: str
    base_version: int
    base_hash: str
    heading: str
    body_md: str
    origin: PatchOrigin
    # "remove": accepting it drops the section (an agent's draft removed or renamed it).
    action: PatchAction = "replace"
    run_id: uuid.UUID | None = None
    rationale: str | None = None
    status: PatchStatus
    created_by: uuid.UUID | None = None
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    decision_note: str | None = None
    applied_version: int | None = None
    lock_version: int
    created_at: datetime
    updated_at: datetime


class SectionPatchDetail(SectionPatchOut):
    """A patch with its word diff against the section's text in the latest version."""

    latest_version: int
    current_revision: str | None = None
    current_heading: str | None = None
    current_body_md: str | None = None
    # True when the section changed since the patch was proposed.
    rebase_needed: bool = False
    words: list[WordOp] = []


class SectionPatchAccept(BaseModel):
    # The section revision the reviewer compared against (SectionPatchDetail).
    base_revision: str = Field(min_length=1)
    lock_version: int
    # Accept with the reviewer's own edit of the patch.
    heading: str | None = Field(default=None, min_length=1, max_length=300)
    body_md: str | None = None
    note: str | None = None


class SectionPatchReject(BaseModel):
    lock_version: int
    note: str | None = None


# --- v2: campaigns and notifications ----------------------------------------------------

CampaignStatus = Literal["open", "closed"]
NotificationKind = Literal[
    "comment",
    "reply",
    "assignment",
    "rereview_requested",
    "campaign",
    "patch_proposed",
    "published",
]


class CampaignCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    message: str | None = Field(default=None, max_length=4000)
    # The version to comment on; default the latest.
    version: int | None = Field(default=None, ge=1)
    due_at: datetime | None = None
    audience_roles: list[Literal["viewer", "commenter", "approver", "owner"]] = [
        "commenter",
        "approver",
        "owner",
    ]


class CampaignPatch(BaseModel):
    status: CampaignStatus
    lock_version: int


class CampaignOut(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    version_number: int
    title: str
    message: str | None = None
    due_at: datetime | None = None
    audience_roles: list[str] = []
    status: CampaignStatus
    created_by: uuid.UUID | None = None
    closed_by: uuid.UUID | None = None
    closed_at: datetime | None = None
    lock_version: int
    created_at: datetime
    updated_at: datetime
    # Live counts on the campaign's version since it opened.
    invited: int = 0
    comments: int = 0
    participants: int = 0
    open_change_requests: int = 0


class NotificationOut(ORM):
    id: uuid.UUID
    kind: NotificationKind
    title: str
    document_id: uuid.UUID | None = None
    version_number: int | None = None
    section_key: str | None = None
    comment_id: uuid.UUID | None = None
    campaign_id: uuid.UUID | None = None
    actor: str
    data: dict = {}
    read_at: datetime | None = None
    created_at: datetime


class NotificationsRead(BaseModel):
    marked: int


# --- v2: publish ------------------------------------------------------------------------

PublishProblemCode = Literal[
    "version_not_approved",
    "approval_not_by_decider",
    "missing_required_section",
    "stale_approval",
    "missing_approval",
    "mandatory_reviewer_pending",
    "readiness_critical",
    "source_permission_revoked",
    "already_published",
    "superseded_version",
    "template_unresolved",
    # Warnings only:
    "open_critical_change_request",
    "open_change_request",
    "readiness_warning",
    "approval_stale_optional",
    "review_overdue",
]


class PublishProblem(BaseModel):
    code: PublishProblemCode
    message: str
    section_keys: list[str] = []
    # A readiness check key, reviewer ids, source item ids, feedback item ids.
    check_key: str | None = None
    ids: list[uuid.UUID] = []


class ReadinessResultOut(BaseModel):
    key: str
    hard: bool
    status: Literal["pass", "warning", "critical", "not_applicable"]
    rationale: str
    evidence_ids: list[uuid.UUID] = []
    owner_id: uuid.UUID | None = None
    section_keys: list[str] = []
    error: str | None = None


class PublishCheckOut(BaseModel):
    """Whether a version can be published, and everything that blocks it."""

    document_id: uuid.UUID
    version: int
    content_hash: str
    can_publish: bool
    blockers: list[PublishProblem] = []
    warnings: list[PublishProblem] = []
    required_sections: list[str] = []
    approval_required_sections: list[str] = []
    decider_id: uuid.UUID | None = None
    approved_at: datetime | None = None
    approved_by: uuid.UUID | None = None
    readiness: list[ReadinessResultOut] = []


class PublishIn(BaseModel):
    # The version's content hash the publisher checked (PublishCheckOut); a mismatch
    # is a 409.
    content_hash: str | None = None
    note: str | None = Field(default=None, max_length=2000)


class PublishRefused(BaseModel):
    """409: the publish transaction refused; nothing was published."""

    detail: str
    check: PublishCheckOut


class PublicationSummary(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    number: int
    version_id: uuid.UUID
    version_number: int
    content_hash: str
    manifest_hash: str
    published_by: uuid.UUID | None = None
    created_at: datetime
    has_brief: bool = False


class PublicationOut(PublicationSummary):
    """A publication with everything it pinned (immutable)."""

    manifest: dict
    markdown: str
