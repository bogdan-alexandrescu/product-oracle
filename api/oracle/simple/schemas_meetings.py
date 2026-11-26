"""Simple S8 meetings: the meeting, its minutes and decisions, and the decisions page."""

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import Field, model_validator

from oracle.base_model import BaseModel
from oracle.simple.schemas_roadmap import (
    SimpleChangeOut,
    SimpleDocRef,
    SimpleDraftOut,
    SimpleFlow,
    SimpleNotApproved,
    SimpleOpenDecision,
    SimplePersonRef,
    SimpleTaskWaiting,
)

# --------------------------------------------------------------------------- S8 meetings

ChangeMode = Literal["everyone", "presenter", "named"]
MeetingOrigin = Literal["one_pager", "roadmap", "ritual"]
MeetingStatus = Literal["live", "ended"]
MinutesState = Literal["drafting", "ready", "sent"]
# The ``meeting_minutes`` job while the minutes are drafting: running, past
# meetings.MINUTES_SLOW ("slow": send what is written), or failed (draft again).
MinutesJobState = Literal["drafting", "slow", "failed"]


class SimpleAttendee(BaseModel):
    id: uuid.UUID
    name: str
    # What the person is to the PRD: decider, required reviewer, owner (its tracks').
    roles: list[Literal["decider", "reviewer", "owner", "presenter"]] = []
    # The presenter's roll call: false once marked away.
    present: bool = True
    # walkc-meeting r2 (5a): false while an invited attendee has not pressed Join.
    joined: bool = True


class SimpleDecidedFlow(BaseModel):
    """The new flow or feature a meeting decision decided (a draft item) and its flow
    (oracle.simple.visuals, S10); ``flow`` is None until one is drawn ("No flow yet")."""

    kind: str
    id: uuid.UUID
    title: str
    flow: SimpleFlow | None = None


class SimpleMeetingDecision(BaseModel):
    """A decision taken in a meeting: a ``decisions`` row, origin ``meeting``."""

    id: uuid.UUID
    number: int
    title: str
    approver: SimplePersonRef
    at: dt.datetime
    subjects: list[dict[str, Any]] = []
    change_ids: list[uuid.UUID] = []
    flow: SimpleDecidedFlow | None = None


class SimpleActionItemIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    owner_id: uuid.UUID | None = None
    due_date: dt.date | None = None
    # An action item recorded in the meeting (its row): Send adds only the new ones.
    action_item_id: uuid.UUID | None = None
    # #1817: the roadmap item it is about (one of the agenda's features), if any.
    item_id: uuid.UUID | None = None


class SimpleActionItemOut(SimpleActionItemIn):
    owner_name: str | None = None


class SimpleMeetingActionItem(BaseModel):
    """#1817: a sent meeting's recorded action item; ``can_change``: its owner, or one who
    decides its item, marks it done or changes it."""

    id: uuid.UUID
    title: str
    owner_id: uuid.UUID
    owner_name: str | None = None
    due_date: dt.date | None = None
    item_id: uuid.UUID | None = None
    status: str
    can_change: bool = False


class SimpleWait(BaseModel):
    """What still waits on whom (an absent required reviewer's approval, a proposal)."""

    what: str
    on: list[SimplePersonRef] = []


class SimpleMinutes(BaseModel):
    summary: str = ""
    open_questions: list[str] = []
    action_items: list[SimpleActionItemOut] = []
    waits: list[SimpleWait] = []
    # extract: Oracle's quick draft, shown at once; oracle: the minutes job's; edited: a
    # person's.
    written_by: Literal["extract", "oracle", "edited"] = "extract"


class SimpleMinutesIn(BaseModel):
    summary: str = Field(default="", max_length=4000)
    open_questions: list[str] = Field(default_factory=list, max_length=20)
    action_items: list[SimpleActionItemIn] = Field(default_factory=list, max_length=30)


DeliveryStatus = Literal["queued", "sent", "retrying", "failed"]


class SimpleEmailDelivery(BaseModel):
    """One attendee's minutes email: queued, sent, retrying (a try failed, another is due
    on the tick) or failed (three tries failed; Retry requeues it)."""

    person: SimplePersonRef
    status: DeliveryStatus


class SimpleDelivery(BaseModel):
    decisions: bool = True
    inbox: bool = True
    # chosen by whoever ended the meeting; email_status: queued, sent, retrying (some
    # attendee's is tried again), failed (some attendee's did not go) or unavailable.
    email: bool = False
    email_status: str | None = None
    # Each attendee's email, and how many went.
    emails: list[SimpleEmailDelivery] = []
    email_sent: int = 0
    slack: bool = False
    # queued, sent, retrying or failed.
    slack_status: str | None = None
    slack_channel: str | None = None


class SimpleSlackState(BaseModel):
    # The company's Slack notifications integration is installed and active.
    connected: bool
    # The Notifications channel minutes go to (Settings › Notifications), when set.
    channel: str | None = None


class SimpleMeetingBrief(BaseModel):
    id: uuid.UUID
    title: str
    prd: SimpleDocRef
    origin: MeetingOrigin
    status: MeetingStatus
    presenter: SimplePersonRef
    attendees: list[SimpleAttendee]
    length_min: int
    started_at: dt.datetime
    ended_at: dt.datetime | None
    decisions: int
    minutes_state: MinutesState | None = None
    summary: str | None = None


class SimpleMeetingCan(BaseModel):
    # Change through the meeting (the presenter's change mode; the caller's own rights
    # decide applied or proposed).
    change: bool
    # The presenter: change mode, presence.
    set_rules: bool
    # The PRD's decider (or an owner): Approve in the meeting.
    approve: bool
    # The presenter, an owner or the decider ends it, edits and sends the minutes.
    end: bool
    # The same people requeue a failed minutes job ("Draft again").
    redraft: bool = False
    # Whoever ended the meeting or an owner retries a failed email or Slack post.
    retry_delivery: bool = False
    # agenda-sheet: an owner or the PRD's decider changes the agenda; an approver who is
    # not the decider proposes; others read.
    edit_agenda: bool = False
    propose_agenda: bool = False


class SimpleMeetingNote(BaseModel):
    """chat-actions: a minutes note or open question added during the meeting; also a
    comment (qa-simple-decide-1), which is not a meeting decision and stays out of
    minutes."""

    id: str
    kind: Literal["note", "question", "comment"]
    text: str
    by_name: str
    at: dt.datetime | None = None
    card_id: uuid.UUID | None = None


class SimpleAgendaItem(BaseModel):
    id: uuid.UUID
    title: str


class SimpleAgendaRow(BaseModel):
    """agenda-sheet: one row of the meeting's agenda: a feature of its PRD or a topic a
    person typed, with its minutes; ``state`` reads the chat's next and skip."""

    id: str
    kind: Literal["feature", "topic"]
    feature_id: uuid.UUID | None = None
    title: str
    mins: int
    by_name: str | None = None
    state: Literal["done", "now", "next", "skipped"]


class SimpleAgendaProposal(BaseModel):
    """agenda-sheet: an approver's agenda changes waiting for the meeting's decider."""

    by: SimplePersonRef
    decider: SimplePersonRef | None = None
    words: list[str] = []
    # The proposer's earlier ops whose item is gone since, as words: dropped, not proposed.
    dropped: list[str] = []


class SimpleAgenda(BaseModel):
    """chat-actions: the item the meeting takes next and the items it skips.
    agenda-sheet: the rows in order, the PRD's features not on it yet, what the last batch
    of the sheet did (for its Undo line) and an approver's waiting proposal."""

    next: SimpleAgendaItem | None = None
    skipped: list[SimpleAgendaItem] = []
    items: list[SimpleAgendaRow] = []
    addable: list[SimpleAgendaItem] = []
    batch: str | None = None
    words: list[str] = []
    # The accepted proposal's ops whose item was gone, as words: left out of the batch.
    left_out: list[str] = []
    # port-an-decisions: the batch removed items that wait in Settings › Trash (Open Trash).
    in_trash: bool = False
    proposal: SimpleAgendaProposal | None = None
    # Who decides what an approver proposes: the PRD's decider (none: an owner).
    decider: SimplePersonRef | None = None


class SimpleAgendaEditIn(BaseModel):
    """agenda-sheet: one op of the Agenda sheet. ``batch`` names the sheet's opening, so
    Undo puts back the agenda as it was when that batch began."""

    op: Literal["add", "rename", "move", "remove", "undo", "accept", "withdraw"]
    item_id: str | None = Field(default=None, max_length=64)
    feature_id: uuid.UUID | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)
    to: int | None = Field(default=None, ge=0, le=200)
    batch: str | None = Field(default=None, max_length=64)


class SimpleDraftRoadmapItem(BaseModel):
    """An item of the run's draft roadmap with its dates: not on the roadmap yet."""

    id: uuid.UUID
    key: str
    title: str
    horizon: str
    start: dt.date
    end: dt.date


class SimpleDraftRoadmap(BaseModel):
    """The run's draft roadmap of the meeting's PRD (RP2, 'Meeting step as draft'): its
    dated items, shown hatched in the Roadmap step until the meeting approves the dates."""

    items: list[SimpleDraftRoadmapItem]
    # Once this meeting approved the dates (no draft left): how many items it put on the
    # roadmap, so the step says so after a reload too; null while the dates are draft.
    approved: int | None = None


class SimpleRoadmapDraftItem(SimpleDraftRoadmapItem):
    """A dated item of a draft PRD on the Simple roadmap's draft layer, with its owner."""

    owner_name: str | None = None


class SimpleRoadmapDraftPrd(BaseModel):
    """RP2 'Draft layer on roadmap': a PRD whose run's draft roadmap holds dated items not
    approved yet, shown hatched over the roadmap until the PRD is approved."""

    prd: SimpleDocRef
    run_id: uuid.UUID | None = None
    items: list[SimpleRoadmapDraftItem]
    # The reader may Change dates and Leave out (approvers and up).
    can_change: bool = False


class SimpleDraftDatesIn(BaseModel):
    """Change dates on a draft item: it stays draft."""

    start: dt.date
    end: dt.date

    @model_validator(mode="after")
    def _ordered(self) -> "SimpleDraftDatesIn":
        if self.end < self.start:
            raise ValueError("the end comes before the start")
        return self


class SimpleMeetingOut(SimpleMeetingBrief):
    session_id: uuid.UUID
    occurrence_id: uuid.UUID | None = None
    change_mode: ChangeMode
    change_people: list[SimplePersonRef] = []
    roadmap_ids: list[uuid.UUID] = []
    meeting_decisions: list[SimpleMeetingDecision] = []
    open_decisions: list[SimpleOpenDecision] = []
    # prd-questions: the agenda's "Decisions due": the PRD's open questions that block the
    # milestone the soonest one blocks, soonest first, with those decided in this meeting.
    decisions_due: "list[SimpleQuestion]" = []
    pending_proposals: list[SimpleChangeOut] = []
    drafts: list[SimpleDraftOut] = []
    # Everyone its drafts wait on, named (#723 review: an absent section reviewer need not
    # be an attendee), for the banner's "Waiting on <name>'s approval".
    waiting_people: list[SimplePersonRef] = []
    minutes: SimpleMinutes | None = None
    # #1817: once sent, its action items as recorded, each with its status.
    action_items: list[SimpleMeetingActionItem] = []
    # The minutes job's state while ``minutes_state`` is "drafting" (else None).
    minutes_job: MinutesJobState | None = None
    delivery: SimpleDelivery | None = None
    slack: SimpleSlackState
    email_available: bool
    can: SimpleMeetingCan
    # Approve's answer: the roadmaps left for their own decider.
    not_approved: list[SimpleNotApproved] = []
    # chat-actions: the notes and open questions so far, and the agenda's changes.
    notes: list[SimpleMeetingNote] = []
    agenda: SimpleAgenda = SimpleAgenda()
    # RP2: the run's draft roadmap of the PRD (dated, not approved); None without one.
    draft_roadmap: SimpleDraftRoadmap | None = None


class SimpleUpcomingMeeting(BaseModel):
    """A scheduled review to start from: a ritual occurrence, or an active ritual's next
    due time before its occurrence is made (``occurrence_id`` None; starting it makes it)."""

    occurrence_id: uuid.UUID | None = None
    ritual_id: uuid.UUID
    ritual_title: str
    due_at: dt.datetime
    ends_at: dt.datetime
    length_min: int
    attendees: list[SimplePersonRef]
    meeting_id: uuid.UUID | None = None
    # Its occurrence's pre-read is built (Home's "Open pre-read").
    pre_read_ready: bool = False
    # Owners and the ritual's owner start a ritual's review (the caller may).
    can_start: bool = False
    # What the ritual reviews when all of it is in Trash ("roadmap": a roadmap refresh while
    # every roadmap is in Trash); Home says so and links the ritual's settings.
    reviews_in_trash: Literal["roadmap"] | None = None
    # What the ritual reviews when all of it was deleted for good (purged from Trash, none
    # left); Home says "Its roadmap was deleted" and links the ritual's settings.
    reviews_deleted: Literal["roadmap"] | None = None
    # home-deleted-roadmap: when it was deleted for good (its last purge); Home shows the day.
    reviews_deleted_at: dt.datetime | None = None


class SimpleMeetingsOut(BaseModel):
    upcoming: list[SimpleUpcomingMeeting]
    live: list[SimpleMeetingBrief]
    past: list[SimpleMeetingBrief]


class SimpleStartPrd(BaseModel):
    document: SimpleDocRef
    decider: SimplePersonRef | None
    # Owners and the document's decider start a meeting; others see who starts it.
    can_start: bool
    starters: list[SimplePersonRef]
    default_attendee_ids: list[uuid.UUID]


class SimpleStartMember(SimplePersonRef):
    # qa4-simple-decide-14: whether this person's role may change things in a review's
    # chat in any mode (a viewer never may), so the sheet offers only them.
    can_change: bool


class SimpleStartOptions(BaseModel):
    prds: list[SimpleStartPrd]
    members: list[SimpleStartMember]
    length_min: int = 60
    occurrence: SimpleUpcomingMeeting | None = None


class SimpleMeetingIn(BaseModel):
    prd: str = Field(min_length=1, max_length=200)
    title: str | None = Field(default=None, max_length=200)
    origin: MeetingOrigin = "one_pager"
    occurrence_id: uuid.UUID | None = None
    # A ritual's next review before its occurrence is made (Meetings > Upcoming), with the
    # row's due time: a start the ritual has moved past is 409, never next week's review.
    ritual_id: uuid.UUID | None = None
    due_at: dt.datetime | None = None
    # meeting-changes-only-its-agenda: the roadmap it reviews (slug or id), when the PRD's
    # items are on several; else the one they are on.
    roadmap: str | None = Field(default=None, max_length=200)
    attendee_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    change_mode: ChangeMode = "everyone"
    change_people: list[uuid.UUID] = Field(default_factory=list, max_length=2)
    length_min: int = Field(default=60, ge=5, le=240)


class SimpleMeetingRulesIn(BaseModel):
    change_mode: ChangeMode | None = None
    change_people: list[uuid.UUID] | None = Field(default=None, max_length=2)
    absent_ids: list[uuid.UUID] | None = None


class SimpleMeetingCommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    subjects: list[dict[str, Any]] = Field(default_factory=list, max_length=10)


class SimpleSendIn(BaseModel):
    email: bool = False
    slack: bool = False


class SimpleRetryDeliveryIn(BaseModel):
    what: Literal["email", "slack"]


class SimpleDecisionRow(BaseModel):
    id: uuid.UUID
    number: int
    title: str
    origin: str
    status: str
    approver: SimplePersonRef | None
    decided_at: dt.datetime | None
    created_at: dt.datetime
    subjects: list[dict[str, Any]] = []
    # A meeting decision on a new flow or feature: that flow.
    flow: SimpleDecidedFlow | None = None
    # prd-questions: a PRD's question keeps its code ("Q10"); a decided one, its answer.
    code: str | None = None
    # QA (unique codes): a PRD's question names its PRD (one the reader reads).
    prd_title: str | None = None
    chosen: str | None = None
    # edit-decisions (ec1 b): every field the sheet shows and changes, what the reader may
    # do there, and the last change made from it.
    question: str | None = None
    context: str | None = None
    options: list["SimpleQuestionOption"] = []
    review_at: dt.date | None = None
    can: "SimpleDecisionCan | None" = None
    edited_at: dt.datetime | None = None
    edited_by: SimplePersonRef | None = None


class SimpleMeetingGroup(BaseModel):
    meeting: SimpleMeetingBrief
    minutes: SimpleMinutes | None
    decisions: list[SimpleDecisionRow]
    # qa4-simple-decide-32: the meeting's notes and comments, as its minutes list them.
    notes: list[SimpleMeetingNote] = []
    # How the sent minutes went out (email, Slack), and whether the caller may Retry.
    delivery: SimpleDelivery | None = None
    can_retry_delivery: bool = False


class SimpleFilterOption(BaseModel):
    id: str
    title: str


QuestionColumn = Literal["needs_input", "recommended", "decided"]
DecisionsView = Literal["list", "board", "meetings"]


class SimpleQuestionOption(BaseModel):
    key: str
    label: str


class SimpleQuestionFeature(BaseModel):
    code: str
    title: str


class SimpleQuestionBlocks(BaseModel):
    """What the question blocks: a milestone of the PRD's plan and its features."""

    milestone: str | None = None
    milestone_name: str | None = None
    features: list[SimpleQuestionFeature] = []
    # "Blocks M1: F-03 Health log" (the owner's words).
    label: str


class SimpleQuestionPending(BaseModel):
    """A proposed answer waiting for the decider (a change through the engine)."""

    change_id: uuid.UUID
    by: SimplePersonRef
    answer: str


class SimpleQuestionCan(BaseModel):
    # Applies at once (owners and the decider, with Undo).
    decide: bool = False
    # Proposes to the decider (approvers and commenters).
    propose: bool = False
    # Names the decider (owners and the decider; others propose).
    name_decider: bool = False
    # edit-decisions (eq2 b): changes its text, recommendation and other answers at once
    # (owners and the decider; ``propose`` suggests the change instead); withdraws it (the
    # "not now", with Undo); deletes it to Trash.
    edit: bool = False
    withdraw: bool = False
    delete: bool = False


class SimpleDecisionCan(BaseModel):
    """edit-decisions (ec1 b): what the reader may do on an open decision's sheet, from
    the decision's own rights (its creator, its decider or an owner edits, withdraws and
    deletes; owners reassign; another commenter or approver proposes an edit)."""

    edit: bool = False
    propose: bool = False
    withdraw: bool = False
    delete: bool = False
    reassign: bool = False


class SimpleQuestionSource(BaseModel):
    """Where Oracle read the question: the PRD's approved version, and when."""

    version: int | None = None
    read_at: dt.datetime | None = None


class SimpleQuestion(BaseModel):
    """prd-questions: one of a PRD's open questions, read in as a decision (origin
    ``prd``): the PRD's code (Q7), its recommendation and alternatives, what it blocks,
    its due day and decider."""

    id: uuid.UUID
    number: int
    code: str
    title: str
    status: str
    column: QuestionColumn
    prd: SimpleDocRef
    decider: SimplePersonRef | None = None
    # What is missing for a "Needs input" question: "decider" or "recommendation".
    missing: Literal["decider", "recommendation"] | None = None
    due_on: dt.date | None = None
    # "Late · due Fri Nov 6" or "Due Fri Nov 27" (company days); None when decided.
    due_label: str | None = None
    late: bool = False
    blocks: SimpleQuestionBlocks | None = None
    recommendation: str | None = None
    alternatives: list[SimpleQuestionOption] = []
    chosen: str | None = None
    decided_at: dt.datetime | None = None
    decided_by: SimplePersonRef | None = None
    # "Decided on Fri Oct 23 by Ana Lee" or "Decided in the PRD on Fri Oct 23 by Ana Lee".
    decided_label: str | None = None
    waiting_for_me: bool = False
    pending: SimpleQuestionPending | None = None
    can: SimpleQuestionCan = SimpleQuestionCan()
    # "From Guided setup draft 3 · read Oct 22": the version it was read from.
    source: SimpleQuestionSource | None = None
    # A live review meeting's agenda: the change that decided it in this meeting, for its
    # Undo (only who made it, while the meeting runs).
    undo_id: uuid.UUID | None = None
    # edit-decisions: the last change made from the sheet, who and when ("Edited by you
    # just now").
    edited_at: dt.datetime | None = None
    edited_by: SimplePersonRef | None = None


class SimpleNoteCode(BaseModel):
    """#1866: a goal, feature or milestone whose code a note writes, with its name, so the
    page shows the code with its name ("F-104 Quiet hours"); the company's own only."""

    code: str
    name: str
    kind: Literal["goal", "feature", "milestone"]


class SimpleRunStepOut(BaseModel):
    """One decision at a run's stop: what was done ("Sent back", "Approved"), by whom, the
    day (the company's) and the note given."""

    what: str
    who: str | None = None
    day: dt.date | None = None
    note: str | None = None
    # #1866: the codes the note writes that name something, in the note's order.
    codes: list[SimpleNoteCode] = []


class SimpleRunStopOut(BaseModel):
    """build-rundecide RD1 a: one stop of a run as a decision row: "Engineering check:
    approved after a change", the person's name, their role, the note and the day. `trail`
    lists every step when the stop was sent back before it was approved. `dates_changed`:
    how many dates the approver changed at a Dates stop (eng_dates) before approving it,
    "Approved with one date changed"; 0 for every other stop."""

    checkpoint_id: uuid.UUID
    kind: str
    stop: str
    outcome: str
    dates_changed: int = 0
    who: str | None = None
    role: str | None = None
    day: dt.date | None = None
    note: str | None = None
    # #1866: the codes the note writes that name something, in the note's order.
    codes: list[SimpleNoteCode] = []
    trail: list[SimpleRunStepOut] = []


class SimpleRunGroup(BaseModel):
    """build-rundecide RD1 a: one run's decided stops, in order, under its name and PRD
    ("Usage alerts plan · Usage alerts PRD · 5 decisions")."""

    run_id: uuid.UUID
    name: str
    prd: SimpleFilterOption | None = None
    stops: list[SimpleRunStopOut]


class SimpleDecisionsOut(BaseModel):
    """Simple's Decisions (direction B "By meeting"): the meetings' decisions grouped under
    them, newest first, then the decisions taken outside meetings. prd-questions: the
    PRDs' open questions as decisions (List and Board), the person's remembered view and
    how many of Oracle's run approvals Simple leaves to Detailed."""

    meetings: list[SimpleMeetingGroup]
    other: list[SimpleDecisionRow]
    prds: list[SimpleFilterOption]
    goals: list[SimpleFilterOption]
    meeting_options: list[SimpleFilterOption]
    # Open first, soonest due first; decided after, newest first.
    questions: list[SimpleQuestion] = []
    waiting_count: int = 0
    late_count: int = 0
    # Oracle's own run approvals waiting for this person (shown in Detailed only).
    approvals_waiting: int = 0
    # One of them, for the page's foot ("D-12 Approve Baseline confirm").
    approvals_example: str | None = None
    view: DecisionsView = "list"
    # build-rundecide RD1 a: the runs' decided stops, one group per run, newest run first.
    runs: list[SimpleRunGroup] = []


class SimpleWaitingItem(BaseModel):
    """home-decisions-one-list: one thing waiting on the signed-in person
    (oracle.simple.waiting_list): what it is, its action in words and where it is done."""

    kind: Literal[
        "run_stop",
        "question",
        "decision",
        "broken_link",
        "date",
        "draft",
        "proposal",
        "goal_suggestion",
        "goal",
        # The Inbox's other counted "Needs you" rows (Add predictions, launches, rituals,
        # metrics, requests), opened where the Inbox opens them.
        "inbox",
    ]
    # Unique in the list (kind and id); ``ref_id`` is the id its own endpoint acts on (the
    # checkpoint, question, decision's number, item, date suggestion, draft, change, goal
    # suggestion or proposed goal).
    key: str
    ref_id: str
    title: str
    detail: str = ""
    action: str
    href: str
    at: dt.datetime | None = None
    # A proposal's change operation (Accept/Decline act on it through /v1/simple/changes).
    op: str | None = None


class SimpleDecisionsWaitingOut(BaseModel):
    """prd-questions: the one list Home's "Decisions waiting for you", the rail's count and
    the review meeting's "Decisions due" read: product decisions waiting for this person
    (the PRDs' open questions and other judgement calls), never Oracle's run approvals."""

    count: int
    late: int
    questions: list[SimpleQuestion] = []
    # Other product decisions (not a PRD's question) waiting for this person.
    others: int = 0
    approvals_waiting: int = 0
    # walkc-roadmap-tasks: the open item tasks this person owns (due first; not counted in
    # ``count``, which is decisions only).
    tasks: list[SimpleTaskWaiting] = []
    # home-decisions-one-list: everything waiting on this person (run stops, questions,
    # decision-log calls, broken links, dates, drafts, proposals, goal suggestions), each
    # with its action.
    items: list[SimpleWaitingItem] = []


class InboxSimpleMinutes(BaseModel):
    """A meeting's minutes, sent to each attendee (``simple_minutes``)."""

    meeting_id: uuid.UUID
    title: str
    ended_at: dt.datetime | None
    sent_at: dt.datetime | None
    decisions: int
    state: Literal["new", "open"]


class InboxSimpleActionItem(BaseModel):
    """#1817: an open meeting action item its owner is to do (``simple_action_items``,
    counted in ``total``), with its due date, linked item and meeting."""

    id: uuid.UUID
    title: str
    due_date: dt.date | None = None
    late: bool = False
    item_id: uuid.UUID | None = None
    item_title: str | None = None
    # inbox-codes (#1786): the linked item's code (codes.code_of); None for one with none.
    item_code: str | None = None
    roadmap_id: uuid.UUID | None = None
    meeting_id: uuid.UUID | None = None
    meeting_title: str | None = None
    at: dt.datetime
    state: Literal["new", "open"]


SimpleMeetingOut.model_rebuild()
SimpleDecisionRow.model_rebuild()
