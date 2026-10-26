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
    # "panel": a G7 head-of-product panel chat, always private, just its starter and Oracle.
    origin: Literal["discuss", "panel"] = "discuss"


class DiscussionShareIn(BaseModel):
    """G7 Share as discussion: the new open discussion's title and first message (the
    chat's summary as the person edited it)."""

    title: str | None = Field(default=None, max_length=200)
    first_message: str


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
    # G2 §4 Research this: an approver or owner who can write in it, while it is open; the
    # run's estimated cost, shown before it starts (for them only).
    can_research: bool = False
    research_usd: float | None = None


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


class DiscussionStarted(DiscussionOut):
    """A new discussion, and Oracle's ``pending`` reply to its first message when the rule
    calls for one (``complete`` or ``failed`` with ``wait``)."""

    reply: "DiscussionMessageOut | None" = None


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
    # G2 §4: the research run this line started, or whose answer this is.
    research: "MessageResearch | None" = None


class MessageResearch(BaseModel):
    run_id: uuid.UUID
    status: Literal["running", "done", "failed"]
    # Why it failed, in words, when the run could not start (a budget, one build at a time).
    error: str | None = None


class ResearchIn(BaseModel):
    """Research this: the person's message to research."""

    message_id: uuid.UUID


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


DiscussionStarted.model_rebuild()


class DiscussionMessagePage(BaseModel):
    items: list[DiscussionMessageOut]
    has_more: bool


ChangeVerb = Literal["Stage", "Propose", "Resolve", "Use as answer", "Ask", "Record", "Apply"]


class ChangeAction(BaseModel):
    """The kind's action as the caller may take it (G3 3.2); ``why_not`` in 3.2's copy."""

    verb: ChangeVerb
    allowed: bool
    why_not: str | None = None


class ChangeCan(BaseModel):
    """What else the caller may do with the change."""

    suggest: bool = False
    edit: bool = False
    withdraw: bool = False
    dismiss: bool = False


class DiscussionChangeOut(BaseModel):
    id: uuid.UUID
    discussion_id: uuid.UUID
    kind: str
    # The plain sentence from the registry (oracle.discussions.kinds).
    label: str
    target: dict[str, Any]
    payload: dict[str, Any]
    edited_payload: dict[str, Any] | None
    rationale: str | None
    proposed_by_kind: Literal["oracle", "person"]
    proposed_by: DiscussionPerson | None
    suggested_by: DiscussionPerson | None
    status: ChangeStatus
    # None for a caller who can never act on it (viewers).
    action: ChangeAction | None = None
    can: ChangeCan = ChangeCan()
    # C1b: {"reason", "sources": [n]}; Stage asks "Why stage it anyway?".
    pushback: dict[str, Any] | None = None
    # A private discussion: Stage asks for the reason everyone will see (3.4).
    needs_reason: bool = False
    basis: list[dict[str, Any]] = Field(default_factory=list)
    # What acting created ({"proposal_id"} for a goal_measure, the staged row, the basis).
    result_ref: dict[str, Any] | None = None
    decision_note: str | None = None
    created_at: datetime
    lock_version: int
    # Why it was kept anyway, after C1b's pushback (B6's goal versions, G3's Stage).
    override_reason: str | None = None


class ChangeKindOut(BaseModel):
    """A kind "Propose a change" offers on this subject, with its payload's JSON schema."""

    kind: str
    verb: ChangeVerb
    schema_: dict[str, Any] = Field(alias="schema", serialization_alias="schema")


class ChangeIn(BaseModel):
    kind: str = Field(min_length=1, max_length=50)
    target: dict[str, Any] = Field(default_factory=dict)
    payload: dict[str, Any]
    rationale: str | None = Field(default=None, max_length=1000)


class ChangeEdit(BaseModel):
    payload: dict[str, Any]
    rationale: str | None = Field(default=None, max_length=1000)
    lock_version: int


class ChangeActIn(BaseModel):
    lock_version: int


class ChangeStageIn(ChangeActIn):
    # C1b: why stage it anyway, when Oracle pushed back.
    override_reason: str | None = Field(default=None, max_length=1000)
    # 3.4: the reason everyone will see; required from a private discussion.
    reason: str | None = Field(default=None, max_length=1000)


class ChangeProposeIn(ChangeActIn):
    # The person's Edit, proposed instead of the change's payload (B6's Edit then Propose);
    # saved only when it is used, so a refused edit changes nothing.
    payload: dict[str, Any] | None = None


class ChangeApplyIn(ChangeActIn):
    # C9: the reason the move or pin is logged with (the change's own when absent).
    reason: str | None = Field(default=None, max_length=500)
    # C9: keep it after Oracle's pushback (no second check), as on the Priorities screen.
    confirm: bool = False


class ChangeDismissIn(ChangeActIn):
    note: str | None = Field(default=None, max_length=1000)


class ChangeResult(BaseModel):
    """Every action's answer: the change, and what acting created (a staged change, a
    proposal, a resolved conflict, an answer), or None."""

    change: DiscussionChangeOut
    result: dict[str, Any] | None = None


class SummaryAsk(BaseModel):
    # The starter asks for a new draft over a confirmed summary.
    replace: bool = False


class DiscussionExposureConflict(BaseModel):
    """409: the counts the warning showed are not the discussion's now."""

    detail: str
    messages: int
    people: int


class RunStagedChange(BaseModel):
    """A change people staged from a discussion for this run (G5): a D8 action on one of the
    run's checkpoints (``staged`` while it waits, ``sent`` once the checkpoint was decided)
    or a ``next_draft_changes`` row for the document's next draft. The shape D4, D6 and D11
    share."""

    id: uuid.UUID
    kind: str
    label: str
    item_key: str | None = None
    section_key: str | None = None
    payload: dict[str, Any]
    # The reason the stager wrote when staging.
    reason: str | None = None
    status: Literal["staged", "sent"]
    target: dict[str, Any]


class RunDecidedChange(BaseModel):
    """A change already done (an answer, a verified basis, a baseline proposal)."""

    kind: str
    label: str


class RunDiscussion(BaseModel):
    """One discussion as a run sees it (G5): never its messages or people. A private one
    shows its title and summary only to the people in it; to agents, only its staged
    changes, and its summary when the starter shared it."""

    id: uuid.UUID
    visibility: Visibility
    title: str | None
    subject_label: str | None
    subject: dict[str, Any]
    # Opens the thread on the run page, for the people who may read it.
    link: str
    summary: str | None
    summary_status: SummaryStatus | None
    summary_withheld: bool
    staged_changes: list[RunStagedChange]
    decided: list[RunDecidedChange]


class RunDiscussionsOut(BaseModel):
    """The discussions about a run: its checkpoints', its intake's and, for a feedback
    loop, its document's with staged next-draft changes. Newest activity first, at most
    50 and 40,000 characters; ``omitted`` counts the rest."""

    run_id: uuid.UUID
    discussions: list[RunDiscussion]
    truncated: bool
    omitted: int = Field(ge=0)
