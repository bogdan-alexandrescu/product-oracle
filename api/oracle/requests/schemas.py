"""Shapes of the requests routes (C1)."""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Channel = Literal["support", "sales", "team", "interview", "slack", "meeting", "doc", "other"]
RequesterKind = Literal["customer", "team", "unknown"]
State = Literal["new", "qualified", "merged", "disqualified"]
Origin = Literal["person", "oracle", "interview"]
DisqualifyReason = Literal[
    "no_goal", "out_of_scope", "duplicate", "not_a_request", "wont_do", "other"
]
SuggestionPart = Literal["theme", "goals", "duplicate", "feature"]

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Body = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
ThemeTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
GoalIds = Annotated[list[uuid.UUID], Field(max_length=20)]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- requests ------------------------------------------------------------------------


class RequestCreate(_In):
    title: Title
    body: Body | None = None
    channel: Channel
    requester_name: Name | None = None
    requester_kind: RequesterKind = "unknown"
    goal_ids: GoalIds = []
    theme_id: uuid.UUID | None = None
    # One of the filer's own source items: filing shares its title, link and a
    # 400-character excerpt with everyone who can see Requests (C1 "Found items").
    source_item_id: uuid.UUID | None = None


class RequestPatch(_In):
    lock_version: int
    # The filer, while the request is New (never an interview's words).
    title: Title | None = None
    body: Body | None = None
    # Approvers and owners.
    goal_ids: GoalIds | None = None
    theme_id: uuid.UUID | None = None
    feature_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None


class QualifyIn(_In):
    lock_version: int
    goal_ids: GoalIds | None = None
    note: Note | None = None


class MergeIn(_In):
    lock_version: int
    into_id: uuid.UUID


class DisqualifyIn(_In):
    lock_version: int
    reason: DisqualifyReason
    note: Note | None = None


class ReopenIn(_In):
    lock_version: int


class AcceptSuggestionIn(_In):
    lock_version: int
    parts: Annotated[list[SuggestionPart], Field(min_length=1, max_length=4)]


class ThemeRef(BaseModel):
    id: uuid.UUID
    title: str


class DocumentRef(BaseModel):
    id: uuid.UUID
    slug: str
    title: str


class DocumentProgress(DocumentRef):
    """The linked PRD on the inspector: its latest version and review progress."""

    latest_version: int | None
    reviewed_sections: int
    sections: int


class SourceCopy(BaseModel):
    """What filing shared of the source item, copied onto the request."""

    item_id: uuid.UUID | None
    title: str | None
    url: str | None
    kind: str | None
    # The item is gone from the source (deleted there, or removed from Oracle).
    removed: bool
    excerpt: str | None


class Suggestion(BaseModel):
    """Oracle's triage proposal for a New request; nothing changes until accepted."""

    theme_id: uuid.UUID | None = None
    theme_title: str | None = None
    goal_ids: list[uuid.UUID] = []
    duplicate_of: uuid.UUID | None = None
    feature_id: uuid.UUID | None = None
    confidence: float | None = None
    rationale: str | None = None
    run_id: uuid.UUID | None = None
    at: datetime | None = None
    # Parts an approver accepted so far.
    accepted: list[SuggestionPart] = []


class RequestOut(BaseModel):
    id: uuid.UUID
    title: str
    body: str | None
    channel: Channel
    origin: Origin
    requester_name: str | None
    requester_kind: RequesterKind
    verified: bool
    state: State
    merged_into_id: uuid.UUID | None
    disqualify_reason: DisqualifyReason | None
    decision_note: str | None
    theme: ThemeRef | None
    goal_ids: list[uuid.UUID]
    feature_id: uuid.UUID | None
    document: DocumentRef | None
    intake_id: uuid.UUID | None
    interview_id: uuid.UUID | None
    source: SourceCopy | None
    # 1 plus every request merged into it, through chains of merges.
    mentions: int
    suggestion: Suggestion | None
    filed_by: uuid.UUID | None
    decided_by: uuid.UUID | None
    decided_at: datetime | None
    created_at: datetime
    updated_at: datetime
    lock_version: int


class RequestDetail(RequestOut):
    # Requests merged into this one, directly or through a chain.
    merged: list[RequestOut]
    document: DocumentProgress | None


class StateCounts(BaseModel):
    all: int
    new: int
    qualified: int
    merged: int
    disqualified: int


class RequestList(BaseModel):
    items: list[RequestOut]
    # Rows matching every filter.
    total: int
    # Per state, under every filter but state (the tabs).
    counts: StateCounts
    # Per channel, under every filter but channel (the Sources facet).
    by_channel: dict[str, int]
    # Requests filed in the last seven days, company-wide.
    new_this_week: int


# --- themes ---------------------------------------------------------------------------


class ThemeCreate(_In):
    title: ThemeTitle
    description: Note | None = None
    goal_ids: GoalIds = []


class ThemePatch(_In):
    lock_version: int
    title: ThemeTitle | None = None
    description: Note | None = None
    goal_ids: GoalIds | None = None
    archived: bool | None = None


class ThemeOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    goal_ids: list[uuid.UUID]
    origin: Literal["person", "oracle"]
    archived: bool
    archived_at: datetime | None
    # Requests in the theme, merged ones aside.
    request_count: int
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    lock_version: int
