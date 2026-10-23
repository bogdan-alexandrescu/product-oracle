import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from oracle.auth.models import Role

SubjectKind = Literal[
    "document",
    "section",
    "checkpoint",
    "checkpoint_item",
    "roadmap_item",
    "entity",
    "conflict",
    "intake",
    "gap",
    "track",
    "priorities",
    "screen",
]
Visibility = Literal["open", "private"]
Status = Literal["open", "closed"]
Origin = Literal["discuss", "panel", "slack"]
SummaryStatus = Literal["none", "draft", "confirmed"]
AddedVia = Literal["started", "mention", "added", "followed", "posted"]
ChangeStatus = Literal["proposed", "suggested", "staged", "done", "dismissed", "superseded"]


class DiscussionMessageIn(BaseModel):
    # The 8,000-character limit answers its own copy (oracle.discussions.service).
    body: str
    mentions: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    mention_oracle: bool = False
    reply_to: uuid.UUID | None = None


class DiscussionMessageEdit(BaseModel):
    body: str


class DiscussionCreate(BaseModel):
    subject_kind: SubjectKind
    subject: dict[str, Any] = Field(default_factory=dict)
    # Defaults to the subject's label.
    title: str | None = Field(default=None, max_length=200)
    visibility: Visibility = "open"
    # The starter's pick for a private discussion; treated as mentions on an open one.
    participants: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    message: DiscussionMessageIn | None = None


class DiscussionExposure(BaseModel):
    """What making a private discussion open exposes: the messages not deleted (people's
    and Oracle's, system lines excluded) and the distinct people who wrote them."""

    messages: int = Field(ge=0)
    people: int = Field(ge=0)


class DiscussionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    visibility: Visibility | None = None
    # The counts the Make open warning showed; required to make a private discussion open.
    exposes: DiscussionExposure | None = None
    status: Status | None = None
    # The 1,200-character limit answers its own copy (oracle.discussions.service).
    summary: str | None = None
    summary_status: Literal["confirmed"] | None = None
    summary_shared: bool | None = None
    lock_version: int


class DiscussionParticipantsIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


class DiscussionReadIn(BaseModel):
    message_id: uuid.UUID


class DiscussionPerson(BaseModel):
    user_id: uuid.UUID
    name: str


class DiscussionStarter(DiscussionPerson):
    role: Role


class DiscussionParticipantOut(BaseModel):
    user_id: uuid.UUID
    name: str
    role: Role
    # Commenter or above, and active: posts and suggests.
    can_write: bool
    added_via: AddedVia


class DiscussionChangeCounts(BaseModel):
    proposed: int = 0
    suggested: int = 0
    staged: int = 0


class DiscussionMeSummary(BaseModel):
    participant: bool
    can_write: bool
    unread: int


class PrivateFindings(BaseModel):
    """G1 §3.4.6: the caller's own findings below Summary that bear on the subject."""

    count: int = Field(ge=1)
    intake_id: uuid.UUID


class DiscussionMe(DiscussionMeSummary):
    can_manage: bool
    # The author of the subject's intake only; the key is absent for anyone else.
    private_findings: PrivateFindings | None = Field(default=None, exclude_if=lambda v: v is None)


class DiscussionSummary(BaseModel):
    """A discussion as a list shows it to someone who can read it."""

    id: uuid.UUID
    subject_kind: SubjectKind
    subject_key: str
    subject_label: str
    subject_url: str
    title: str
    visibility: Visibility
    author_only: bool
    status: Status
    origin: Origin
    started_by: DiscussionStarter
    # The version it was started on (document, section, roadmap item): "Started on v3".
    started_on_version: int | None = None
    message_count: int
    last_message_at: datetime | None
    summary: str | None
    summary_status: SummaryStatus
    summary_shared: bool
    changes: DiscussionChangeCounts
    me: DiscussionMeSummary
    lock_version: int
    created_at: datetime
    updated_at: datetime


class DiscussionSlackIn(BaseModel):
    channel_id: str = Field(min_length=1, max_length=40)


class DiscussionSlackOut(BaseModel):
    """G8: the Slack thread an open discussion is mirrored to."""

    channel_name: str
    # Slack's link to the thread, once the root message is posted.
    thread_url: str | None
    status: Literal["posting", "live", "failing", "failed"]
    # The last error while ``failing`` ("Slack mirror failing: <error>"), or Slack's reason
    # when it gave up on the root message (``failed``).
    error: str | None = None


class DiscussionOut(DiscussionSummary):
    subject: dict[str, Any]
    # G8 Slack bridge: the live mirror, if any.
    slack: DiscussionSlackOut | None = None
    participants: list[DiscussionParticipantOut]
    me: DiscussionMe  # type: ignore[assignment]
    # The starter of a private discussion only: what Make open would expose now.
    exposure: DiscussionExposure | None = None


class HiddenDiscussion(BaseModel):
    """A private discussion the caller is not in: only that it exists, and its summary
    when the starter shared it."""

    id: uuid.UUID
    visibility: Literal["private"]
    hidden: Literal[True]
    summary: str | None


class DiscussionPage(BaseModel):
    items: list[DiscussionSummary | HiddenDiscussion]
    next: str | None = None


class DiscussionMessageOut(BaseModel):
    id: uuid.UUID
    discussion_id: uuid.UUID
    author_kind: Literal["person", "oracle", "system"]
    author: DiscussionPerson | None
    via: Literal["web", "mcp", "slack"]
    body: str
    mentions: list[DiscussionPerson]
    mentions_oracle: bool
    reply_to: uuid.UUID | None
    status: Literal["pending", "streaming", "complete", "failed", "cancelled"]
    citations: list[dict[str, Any]]
    created_at: datetime
    edited_at: datetime | None
    deleted: bool
    # Oracle's replies (G2): why one failed, and what it says to this reader.
    error_reason: str | None = None
    error: str | None = None
    # C1b: {"reason", "sources": [n]}.
    pushback: dict[str, Any] | None = None
    # Owners only (P3d: no screen shows cost).
    usage: "ReplyUsage | None" = None


class ReplyUsage(BaseModel):
    model: str | None
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    account_label: str | None
    llm_via: str | None
    attempts: int


class DiscussionMessagePosted(BaseModel):
    """A person's message, and Oracle's ``pending`` reply when the rule calls for one
    (``complete`` or ``failed`` with ``wait``)."""

    message: DiscussionMessageOut
    reply: DiscussionMessageOut | None = None


class DiscussionMessagePage(BaseModel):
    items: list[DiscussionMessageOut]
    has_more: bool


class DiscussionChangeOut(BaseModel):
    id: uuid.UUID
    kind: str
    # The plain sentence from the registry (oracle.discussions.kinds).
    label: str
    target: dict[str, Any]
    payload: dict[str, Any]
    edited_payload: dict[str, Any] | None
    rationale: str | None
    proposed_by_kind: Literal["oracle", "person"]
    proposed_by: uuid.UUID | None
    suggested_by: uuid.UUID | None
    status: ChangeStatus
    created_at: datetime
    lock_version: int


class DiscussionExposureConflict(BaseModel):
    """409: the counts the warning showed are not the discussion's now."""

    detail: str
    messages: int
    people: int
