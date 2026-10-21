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


class MessageIn(BaseModel):
    # The 8,000-character limit answers its own copy (oracle.discussions.service).
    body: str
    mentions: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    mention_oracle: bool = False
    reply_to: uuid.UUID | None = None


class MessageEdit(BaseModel):
    body: str


class DiscussionCreate(BaseModel):
    subject_kind: SubjectKind
    subject: dict[str, Any] = Field(default_factory=dict)
    # Defaults to the subject's label.
    title: str | None = Field(default=None, max_length=200)
    visibility: Visibility = "open"
    # The starter's pick for a private discussion; treated as mentions on an open one.
    participants: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    message: MessageIn | None = None


class Exposure(BaseModel):
    """What making a private discussion open exposes: the messages not deleted (people's
    and Oracle's, system lines excluded) and the distinct people who wrote them."""

    messages: int = Field(ge=0)
    people: int = Field(ge=0)


class DiscussionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    visibility: Visibility | None = None
    # The counts the Make open warning showed; required to make a private discussion open.
    exposes: Exposure | None = None
    status: Status | None = None
    # The 1,200-character limit answers its own copy (oracle.discussions.service).
    summary: str | None = None
    summary_status: Literal["confirmed"] | None = None
    summary_shared: bool | None = None
    lock_version: int


class ParticipantsIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


class ReadIn(BaseModel):
    message_id: uuid.UUID


class PersonRef(BaseModel):
    user_id: uuid.UUID
    name: str


class Starter(PersonRef):
    role: Role


class ParticipantOut(BaseModel):
    user_id: uuid.UUID
    name: str
    role: Role
    # Commenter or above, and active: posts and suggests.
    can_write: bool
    added_via: AddedVia


class ChangeCounts(BaseModel):
    proposed: int = 0
    suggested: int = 0
    staged: int = 0


class MeSummary(BaseModel):
    participant: bool
    can_write: bool
    unread: int


class Me(MeSummary):
    can_manage: bool


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
    started_by: Starter
    # The version it was started on (document, section, roadmap item): "Started on v3".
    started_on_version: int | None = None
    message_count: int
    last_message_at: datetime | None
    summary: str | None
    summary_status: SummaryStatus
    summary_shared: bool
    changes: ChangeCounts
    me: MeSummary
    lock_version: int
    created_at: datetime
    updated_at: datetime


class DiscussionOut(DiscussionSummary):
    subject: dict[str, Any]
    participants: list[ParticipantOut]
    me: Me  # type: ignore[assignment]
    # The starter of a private discussion only: what Make open would expose now.
    exposure: Exposure | None = None


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


class MessageOut(BaseModel):
    id: uuid.UUID
    discussion_id: uuid.UUID
    author_kind: Literal["person", "oracle", "system"]
    author: PersonRef | None
    via: Literal["web", "mcp", "slack"]
    body: str
    mentions: list[PersonRef]
    mentions_oracle: bool
    reply_to: uuid.UUID | None
    status: Literal["pending", "streaming", "complete", "failed", "cancelled"]
    citations: list[dict[str, Any]]
    created_at: datetime
    edited_at: datetime | None
    deleted: bool


class MessagePage(BaseModel):
    items: list[MessageOut]
    has_more: bool


class ChangeOut(BaseModel):
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


class ExposureConflict(BaseModel):
    """409: the counts the warning showed are not the discussion's now."""

    detail: str
    messages: int
    people: int
