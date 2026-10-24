"""Shapes of the requests routes (C1)."""

import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from oracle.runs.schemas import RunStatus

Channel = Literal[
    "support", "sales", "team", "interview", "slack", "meeting", "doc", "other", "in_app"
]
RequesterKind = Literal["customer", "team", "unknown"]
State = Literal["new", "qualified", "merged", "disqualified"]
Origin = Literal["person", "oracle", "interview"]
DisqualifyReason = Literal[
    "no_goal",
    "out_of_scope",
    "duplicate",
    "not_a_request",
    "wont_do",
    "other",
    "strategy_stop",
    "already_exists",
    "few_customers",
]
BasisKind = Literal["goal", "strategy_choice", "feature", "none"]
ReplyKind = Literal["no", "reopened"]
ReplyStatus = Literal["drafted", "sent", "notified", "skipped", "withdrawn"]
ReplyChannel = Literal["email", "slack", "call", "in_app", "other"]
ProblemState = Literal["none", "suggested", "confirmed"]
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


class BasisIn(_In):
    """The record a no cites (H10): required for On the stop list (a confirmed stop
    choice) and Already possible (a feature)."""

    kind: BasisKind
    id: uuid.UUID | None = None


class DisqualifyIn(_In):
    lock_version: int
    reason: DisqualifyReason
    note: Note | None = None
    basis: BasisIn | None = None


class ReopenIn(_In):
    lock_version: int
    # H10: why, on the reversed decision's review ("Request reopened: <reason>").
    reason: Note | None = None


class KeepNoIn(_In):
    """Keep the no (H10): a reaffirmed review on the decision; asked again counts anew."""

    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


ReplyBody = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]


class ReplyPatch(_In):
    lock_version: int
    body: ReplyBody


class ReplySent(_In):
    channel: ReplyChannel
    # Default: today in the Company time zone.
    sent_on: date | None = None


class ReplySkip(_In):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class ReplyOut(BaseModel):
    """One reply to one person who asked (H10)."""

    id: uuid.UUID
    request_id: uuid.UUID
    root_request_id: uuid.UUID
    kind: ReplyKind
    decision_number: int | None
    # The name as given, the member's name, or "Unnamed asker"; never an id.
    asker: str
    asker_kind: RequesterKind
    member_id: uuid.UUID | None
    # How they asked (their request's channel).
    channel_asked: Channel | None
    asked: str | None
    body: str | None
    draft_source: Literal["oracle", "template", "person"] | None
    warnings: list[Literal["sounds_like_a_promise"]]
    status: ReplyStatus
    channel: ReplyChannel | None
    sent_on: date | None
    sent_by_name: str | None
    skip_reason: str | None
    notified_at: datetime | None
    # Oracle's job is drafting it ("Drafting the replies…").
    drafting: bool
    lock_version: int


class DraftJobOut(BaseModel):
    job_id: uuid.UUID


class DeclineSuggestionIn(_In):
    lock_version: int


class AcceptSuggestionIn(_In):
    lock_version: int
    parts: Annotated[list[SuggestionPart], Field(min_length=1, max_length=4)]


class RequestThemeRef(BaseModel):
    id: uuid.UUID
    title: str


class RequestDocumentRef(BaseModel):
    id: uuid.UUID
    slug: str
    title: str


class RequestDocumentProgress(RequestDocumentRef):
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


class SuggestedProblem(BaseModel):
    problem: str | None = None
    success: str | None = None
    constraints: str | None = None


class SuggestedBasis(BaseModel):
    kind: BasisKind = "none"
    id: uuid.UUID | None = None


class SuggestedDecline(BaseModel):
    """ "Oracle suggests saying no": shown only; nothing is disqualified until an
    approver submits the Disqualify form (H10)."""

    reason: DisqualifyReason
    basis: SuggestedBasis = SuggestedBasis()
    why: str | None = None


class Suggestion(BaseModel):
    """Oracle's triage proposal for a New request; nothing changes until accepted."""

    theme_id: uuid.UUID | None = None
    theme_title: str | None = None
    goal_ids: list[uuid.UUID] = []
    duplicate_of: uuid.UUID | None = None
    feature_id: uuid.UUID | None = None
    confidence: float | None = None
    rationale: str | None = None
    # H10: saying no, when the request serves no confirmed goal, names a feature a stop
    # choice affects, or asks for an existing feature. Shown at H11 requests Recommend
    # and above.
    decline: SuggestedDecline | None = None
    # H10: the problem for a new theme Oracle suggests, stored on it when accepted.
    problem: SuggestedProblem | None = None
    run_id: uuid.UUID | None = None
    at: datetime | None = None
    # Parts an approver accepted so far.
    accepted: list[SuggestionPart] = []
    # When and by whom an approver declined it; a declined suggestion is not offered again
    # and triage leaves it.
    declined_at: datetime | None = None
    declined_by: uuid.UUID | None = None
    declined_by_name: str | None = None


class BasisOut(BaseModel):
    kind: BasisKind
    id: uuid.UUID | None = None
    title: str | None = None


class ReplyCounts(BaseModel):
    total: int = 0
    # Still Drafted.
    open: int = 0


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
    theme: RequestThemeRef | None
    goal_ids: list[uuid.UUID]
    feature_id: uuid.UUID | None
    document: RequestDocumentRef | None
    intake_id: uuid.UUID | None
    interview_id: uuid.UUID | None
    source: SourceCopy | None
    # 1 plus every request merged into it, through chains of merges.
    mentions: int
    suggestion: Suggestion | None
    filed_by: uuid.UUID | None
    decided_by: uuid.UUID | None
    decided_at: datetime | None
    # H10: the decision a no logged (D-number and title; null without one), what it
    # cites, how often it was asked again since, its replies and when every one was
    # done; and why a disqualified request has no decision and no replies ("no_note":
    # Won't do without a note; "housekeeping": Duplicate and Not a request).
    decision_number: int | None = None
    decision_title: str | None = None
    decision_status: str | None = None
    basis: BasisOut | None = None
    asked_again: int = 0
    replies: ReplyCounts = ReplyCounts()
    loop_closed_on: date | None = None
    no_reply_reason: Literal["no_note", "housekeeping"] | None = None
    created_at: datetime
    updated_at: datetime
    lock_version: int


class RequestDetail(RequestOut):
    # Requests merged into this one, directly or through a chain.
    merged: list[RequestOut]
    document: RequestDocumentProgress | None
    # H10: what the Disqualify form preselects per reason (the request's feature for
    # Already possible, the stop choice affecting it for On the stop list).
    suggested_basis: dict[str, BasisOut] = {}
    # Oracle's job is drafting this request's replies.
    drafting: bool = False


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


class RequestThemeCreate(_In):
    title: ThemeTitle
    description: Note | None = None
    goal_ids: GoalIds = []


ProblemText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class RequestThemePatch(_In):
    lock_version: int
    title: ThemeTitle | None = None
    description: Note | None = None
    goal_ids: GoalIds | None = None
    archived: bool | None = None
    # H10: the problem behind the theme. Saving it confirms it.
    problem: ProblemText | None = None
    success: ShortText | None = None
    constraints: ShortText | None = None


class ThemeProblemIn(_In):
    lock_version: int


class RequestThemeOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    goal_ids: list[uuid.UUID]
    origin: Literal["person", "oracle"]
    archived: bool
    archived_at: datetime | None
    # Requests in the theme, merged ones aside.
    request_count: int
    # H10: who has it, what they are trying to do, what stops them; how we would know it
    # is solved; limits set by others. Oracle's suggestion waits for an approver.
    problem: str | None = None
    success: str | None = None
    constraints: str | None = None
    problem_state: ProblemState = "none"
    problem_suggestion: SuggestedProblem | None = None
    problem_confirmed_at: datetime | None = None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    lock_version: int


# --- triage and found items (lane 3) -------------------------------------------------


class TriageStart(_In):
    depth: Literal["quick", "standard"] | None = None


class TriageStatus(BaseModel):
    """The latest triage run, for the Requests header. Empty before the first one."""

    run_id: uuid.UUID | None = None
    status: RunStatus | None = None
    # Under way: "Oracle is classifying · started 2 min ago".
    active: bool = False
    # Oracle's daily run (no starter).
    automatic: bool = False
    started_at: datetime | None = None
    finished_at: datetime | None = None
    # Requests holding this run's suggestion.
    suggestions: int = 0
    # What it found in the caller's own sources.
    found: int = 0
    error: str | None = None
    # Why Oracle's daily run did not start (no active member to run it as), until a
    # later run; None otherwise, and while the daily triage is off.
    daily_skipped: str | None = None
    # "Daily triage at 07:00 PT" (owner 2026-10-21: off by default). While on, the name of
    # the member the run acts as (None when there is none); who last turned it on or off,
    # and when.
    daily_on: bool = False
    daily_as: str | None = None
    daily_changed_by: str | None = None
    daily_changed_at: datetime | None = None


class TriageDailyIn(_In):
    """Turn "Daily triage at 07:00 PT" on or off."""

    on: bool


class CandidateFile(_In):
    """Filing a found item: its own words unless these say otherwise."""

    title: Title | None = None
    body: Body | None = None
    channel: Channel | None = None
    requester_name: Name | None = None
    requester_kind: RequesterKind | None = None
    goal_ids: GoalIds | None = None
    theme_id: uuid.UUID | None = None


class CandidateSource(BaseModel):
    """The item, as filing would share it: title, link, kind and excerpt."""

    item_id: uuid.UUID
    title: str | None
    url: str | None
    kind: str | None
    excerpt: str | None


class CandidateOut(BaseModel):
    """A possible request Oracle found in its owner's own source item (theirs alone)."""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    run_id: uuid.UUID | None
    title: str
    body: str | None
    requester_name: str | None
    channel: Literal["support", "sales", "team", "slack", "meeting", "doc", "other"]
    theme_title: str | None
    goal_ids: list[uuid.UUID]
    confidence: float | None
    rationale: str | None
    status: Literal["open", "filed", "dismissed"]
    request_id: uuid.UUID | None
    source: CandidateSource
    created_at: datetime
    updated_at: datetime
