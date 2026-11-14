"""Simple S8 (#723): review meetings and the Decisions page (oracle.simple.meetings). For
people: a run's token is refused (the ``simple`` area is in no run-token scope).

- ``GET /v1/simple/meetings``: viewer and up; upcoming reviews (rituals), live, past.
- ``GET /v1/simple/meetings/options``: the start sheet (``prd``, ``occurrence``).
- ``POST /v1/simple/meetings``: an owner or the PRD's decider starts one (403 otherwise).
- ``GET /v1/simple/meetings/{id}``: the meeting screen and, once ended, its minutes.
- ``POST .../join``: commenter and up joins a live meeting.
- ``PATCH .../rules``: the presenter's change mode and who is absent.
- ``POST .../comments``: a comment, recorded as a meeting decision.
- ``POST .../agenda`` (agenda-sheet): add, rename, move, remove an agenda item and Undo;
  an owner or the PRD's decider saves, an approver proposes (accept, withdraw), 403 else.
- ``POST .../approve``: the PRD's decider (or an owner) approves the meeting's drafts.
- ``POST .../end``: the presenter, the decider or an owner; Oracle drafts the minutes.
- ``PUT .../minutes``: edit them before sending; ``POST .../send``: Decisions and Inbox
  always, email and Slack when chosen, whatever the minutes job's state (what is written).
- ``POST .../minutes/redraft``: "Draft again", requeues a failed ``meeting_minutes`` job.
- ``GET /v1/simple/decisions/waiting`` (prd-questions): viewer and up; the product
  decisions waiting for the caller, PRD questions first, soonest due first.
- ``GET /v1/simple/decisions``: viewer and up; grouped by meeting, filters ``prd``,
  ``goal``, ``meeting``.

Changes made in a meeting go through ``POST /v1/simple/changes`` with the meeting's
``session_id`` (oracle.simple.changes_router records each as a meeting decision).
"""

import uuid
from typing import Annotated

from fastapi import BackgroundTasks, Depends, HTTPException, Query

from oracle.auth.deps import Principal, TenantDB
from oracle.decisions.models import Decision
from oracle.routing import APIRouter
from oracle.simple import meeting_draft, meetings
from oracle.simple.router import _people
from oracle.simple.schemas import (
    SimpleAgendaEditIn,
    SimpleDecisionRow,
    SimpleDecisionsOut,
    SimpleDecisionsWaitingOut,
    SimpleDraftDatesIn,
    SimpleMeetingCommentIn,
    SimpleMeetingIn,
    SimpleMeetingOut,
    SimpleMeetingRulesIn,
    SimpleMeetingsOut,
    SimpleMinutesIn,
    SimpleRetryDeliveryIn,
    SimpleSendIn,
    SimpleStartOptions,
)
from oracle.tenancy import tenant_session

router = APIRouter(prefix="/v1/simple", tags=["simple"])

Reader = Annotated[Principal, Depends(_people("viewer"))]
Commenter = Annotated[Principal, Depends(_people("commenter"))]
Text = Annotated[str | None, Query(max_length=200)]


async def _run(db, coro):
    try:
        return await coro
    except meetings.MeetingError as e:
        await db.rollback()
        raise HTTPException(e.status, e.detail) from e


async def _out(db, principal, meeting_id, not_approved=None) -> SimpleMeetingOut:
    out = await _run(db, meetings.one(db, principal, meeting_id, not_approved))
    await db.commit()  # a meeting idle past its session ends on read
    return out


@router.get("/meetings", response_model=SimpleMeetingsOut, name="list_simple_meetings")
async def list_simple_meetings(principal: Reader, db: TenantDB) -> SimpleMeetingsOut:
    """Upcoming reviews from the rituals, live meetings and past ones (newest first)."""
    out = await _run(db, meetings.listing(db, principal))
    await db.commit()
    return out


@router.get("/meetings/options", response_model=SimpleStartOptions,
            name="get_simple_meeting_options")  # fmt: skip
async def get_simple_meeting_options(
    principal: Reader, db: TenantDB, prd: Text = None, occurrence: uuid.UUID | None = None
) -> SimpleStartOptions:
    """The start sheet: the PRDs (each with who may start it and its default attendees),
    the members, and the scheduled review it starts from."""
    return await _run(db, meetings.options(db, principal, prd, occurrence))


@router.post("/meetings", response_model=SimpleMeetingOut, status_code=201,
             name="start_simple_meeting")  # fmt: skip
async def start_simple_meeting(
    body: SimpleMeetingIn, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    """Start a review meeting: owners and the PRD's decider only."""
    m = await _run(db, meetings.start(db, principal, body))
    await db.commit()
    return await _out(db, principal, m.id)


@router.get("/meetings/{meeting_id}", response_model=SimpleMeetingOut,
            name="get_simple_meeting")  # fmt: skip
async def get_simple_meeting(
    meeting_id: uuid.UUID, principal: Reader, db: TenantDB
) -> SimpleMeetingOut:
    return await _out(db, principal, meeting_id)


@router.post("/meetings/{meeting_id}/join", response_model=SimpleMeetingOut,
             name="join_simple_meeting")  # fmt: skip
async def join_simple_meeting(
    meeting_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    await _run(db, meetings.join(db, principal, meeting_id))
    await db.commit()
    return await _out(db, principal, meeting_id)


@router.patch("/meetings/{meeting_id}/rules", response_model=SimpleMeetingOut,
              name="set_simple_meeting_rules")  # fmt: skip
async def set_simple_meeting_rules(
    meeting_id: uuid.UUID, body: SimpleMeetingRulesIn, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    """The presenter's change mode (everyone, only the presenter, the presenter plus one
    or two named people) and who is absent."""
    await _run(db, meetings.set_rules(db, principal, meeting_id, body))
    await db.commit()
    return await _out(db, principal, meeting_id)


@router.post("/meetings/{meeting_id}/comments", response_model=SimpleMeetingOut,
             status_code=201, name="comment_in_simple_meeting")  # fmt: skip
async def comment_in_simple_meeting(
    meeting_id: uuid.UUID, body: SimpleMeetingCommentIn, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    await _run(db, meetings.comment(db, principal, meeting_id, body.text, body.subjects))
    await db.commit()
    return await _out(db, principal, meeting_id)


@router.post("/meetings/{meeting_id}/agenda", response_model=SimpleMeetingOut,
             name="edit_simple_meeting_agenda")  # fmt: skip
async def edit_simple_meeting_agenda(
    meeting_id: uuid.UUID, body: SimpleAgendaEditIn, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    """agenda-sheet: one op of the Agenda sheet (oracle.simple.meetings.edit_agenda)."""
    await _run(db, meetings.edit_agenda(db, principal, meeting_id, body.model_dump()))
    await db.commit()
    return await _out(db, principal, meeting_id)


@router.post("/meetings/{meeting_id}/approve", response_model=SimpleMeetingOut,
             name="approve_in_simple_meeting")  # fmt: skip
async def approve_in_simple_meeting(
    meeting_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    """The decider's Approve: the present required reviewers approve with them; absent
    ones get an Inbox request and the draft publishes when they approve."""
    result = await _run(db, meetings.approve(db, principal, meeting_id))
    await db.commit()
    return await _out(db, principal, meeting_id, result.not_approved)


@router.post("/meetings/{meeting_id}/draft-items/approve", response_model=SimpleMeetingOut,
             name="approve_simple_meeting_draft_dates")  # fmt: skip
async def approve_simple_meeting_draft_dates(
    meeting_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    """Approve these N dates (RP2): the run's draft items go on the roadmap with their
    dates; the meeting records the decision. The PRD still needs its own approval."""
    await _run(db, meeting_draft.approve_dates(db, principal, meeting_id))
    await db.commit()
    return await _out(db, principal, meeting_id)


@router.post("/meetings/{meeting_id}/draft-items/{item_id}/dates",
             response_model=SimpleMeetingOut, name="change_simple_meeting_draft_dates")  # fmt: skip
async def change_simple_meeting_draft_dates(
    meeting_id: uuid.UUID,
    item_id: uuid.UUID,
    body: SimpleDraftDatesIn,
    principal: Commenter,
    db: TenantDB,
) -> SimpleMeetingOut:
    """Change dates on a draft item of the run's draft roadmap: it stays draft."""
    await _run(
        db, meeting_draft.change_dates(db, principal, meeting_id, item_id, body.start, body.end)
    )
    await db.commit()
    return await _out(db, principal, meeting_id)


@router.post(
    "/meetings/{meeting_id}/draft-items/{item_id}/leave-out",
    response_model=SimpleMeetingOut,
    name="leave_out_simple_meeting_draft_item",
)
async def leave_out_simple_meeting_draft_item(
    meeting_id: uuid.UUID, item_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    """Leave out a draft item: it never goes on the roadmap."""
    await _run(db, meeting_draft.leave_out(db, principal, meeting_id, item_id))
    await db.commit()
    return await _out(db, principal, meeting_id)


@router.post("/meetings/{meeting_id}/end", response_model=SimpleMeetingOut,
             name="end_simple_meeting")  # fmt: skip
async def end_simple_meeting(
    meeting_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    await _run(db, meetings.end(db, principal, meeting_id))
    await db.commit()
    return await _out(db, principal, meeting_id)


@router.put("/meetings/{meeting_id}/minutes", response_model=SimpleMeetingOut,
            name="edit_simple_meeting_minutes")  # fmt: skip
async def edit_simple_meeting_minutes(
    meeting_id: uuid.UUID, body: SimpleMinutesIn, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    await _run(db, meetings.edit_minutes(db, principal, meeting_id, body))
    await db.commit()
    return await _out(db, principal, meeting_id)


@router.post("/meetings/{meeting_id}/minutes/redraft", response_model=SimpleMeetingOut,
             name="redraft_simple_meeting_minutes")  # fmt: skip
async def redraft_simple_meeting_minutes(
    meeting_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    """Draft again: the presenter, the PRD's decider or an owner requeues a failed minutes
    job (409 unless it failed)."""
    await _run(db, meetings.redraft(db, principal, meeting_id))
    await db.commit()
    return await _out(db, principal, meeting_id)


async def _email(tenant_id: uuid.UUID, meeting_id: uuid.UUID) -> None:
    async with tenant_session(tenant_id) as s:
        await meetings.deliver_email(s, meeting_id)
        await s.commit()


@router.post("/meetings/{meeting_id}/send", response_model=SimpleMeetingOut,
             name="send_simple_meeting_minutes")  # fmt: skip
async def send_simple_meeting_minutes(
    meeting_id: uuid.UUID,
    body: SimpleSendIn,
    principal: Commenter,
    db: TenantDB,
    background: BackgroundTasks,
) -> SimpleMeetingOut:
    """Post the minutes to the Decisions page and each attendee's Inbox; email the
    attendees and post to Slack when chosen."""
    m = await _run(db, meetings.send(db, principal, meeting_id, body))
    d = m.delivery or {}
    if d.get("email_status") == "queued" or d.get("slack_status") == "queued":
        background.add_task(_email, principal.tenant_id, meeting_id)
    return await _out(db, principal, meeting_id)


@router.post("/meetings/{meeting_id}/delivery/retry", response_model=SimpleMeetingOut,
             name="retry_simple_meeting_delivery")  # fmt: skip
async def retry_simple_meeting_delivery(
    meeting_id: uuid.UUID, body: SimpleRetryDeliveryIn, principal: Commenter, db: TenantDB
) -> SimpleMeetingOut:
    """Retry: whoever ended the meeting or an owner requeues the minutes' failed emails or
    Slack post (403 for others, 409 when nothing failed); the minute tick tries them."""
    await _run(db, meetings.retry_delivery(db, principal, meeting_id, body.what))
    return await _out(db, principal, meeting_id)


@router.get("/decisions", response_model=SimpleDecisionsOut, name="get_simple_decisions")
async def get_simple_decisions(
    principal: Reader,
    db: TenantDB,
    prd: Text = None,
    goal: Text = None,
    meeting: uuid.UUID | None = None,
) -> SimpleDecisionsOut:
    """Every decision newest first, grouped under the meeting that took it (beside its
    minutes), then those taken outside meetings; filter by PRD, goal or meeting."""
    out = await _run(db, meetings.decisions_page(db, principal, prd, goal, meeting))
    await db.commit()
    return out


@router.get(
    "/decisions/waiting", response_model=SimpleDecisionsWaitingOut,
    name="get_simple_decisions_waiting",
)  # fmt: skip
async def get_simple_decisions_waiting(
    principal: Reader, db: TenantDB
) -> SimpleDecisionsWaitingOut:
    """prd-questions: the product decisions waiting for this person (Home's card, the rail's
    count, the review's "Decisions due"); Oracle's run approvals only counted, for Detailed."""
    from oracle.simple import questions

    out = await _run(db, questions.waiting(db, principal))
    await db.commit()
    return out


async def _question_shown(db: TenantDB, principal: Principal, d: Decision) -> bool:
    """A PRD's question as the Decisions page lists it: its PRD is not deleted and the
    reader reads it; an open one of a replaced PRD is left out (simple-replaced-prds)."""
    from oracle.docs.models import Document

    ref = (d.prd_question or {}).get("document_id")
    doc = await db.get(Document, uuid.UUID(str(ref))) if ref else None
    if (
        doc is None
        or doc.deleted_at is not None
        or not await meetings._readable(db, principal, doc)
    ):
        return False
    from oracle.roadmap import company

    return not (d.status == "proposed" and doc.id in await company.replaced_prd_ids(db))


@router.get(
    "/decisions/{decision_id}", response_model=SimpleDecisionRow, name="get_simple_decision"
)  # fmt: skip
async def get_simple_decision(
    decision_id: uuid.UUID, principal: Reader, db: TenantDB
) -> SimpleDecisionRow:
    """edit-decisions (ec1 b): one decision as the Decisions page lists it, with every field
    the sheet shows and what this reader may do there (Home's and Waiting for you's
    decision-log calls open the sheet by id). After /decisions/waiting, which it would hide."""
    from oracle.simple import decision_sheet

    d = await db.get(Decision, decision_id)
    if d is None or d.origin == "checkpoint" or d.deleted_at is not None:
        raise HTTPException(404, "No such decision")
    if d.origin == "prd" and not await _question_shown(db, principal, d):
        raise HTTPException(404, "No such decision")
    edited = await decision_sheet.edits(db, {d.id})
    by = {b for _, b in edited.values()}
    names = await meetings._names(db, ({d.approver_id} if d.approver_id else set()) | by)
    return meetings._row(d, names, principal, edited)
