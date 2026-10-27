"""Simple S8 (#723): review meetings and the Decisions page (oracle.simple.meetings). For
people: a run's token is refused (the ``simple`` area is in no run-token scope).

- ``GET /v1/simple/meetings``: viewer and up; upcoming reviews (rituals), live, past.
- ``GET /v1/simple/meetings/options``: the start sheet (``prd``, ``occurrence``).
- ``POST /v1/simple/meetings``: an owner or the PRD's decider starts one (403 otherwise).
- ``GET /v1/simple/meetings/{id}``: the meeting screen and, once ended, its minutes.
- ``POST .../join``: commenter and up joins a live meeting.
- ``PATCH .../rules``: the presenter's change mode and who is absent.
- ``POST .../comments``: a comment, recorded as a meeting decision.
- ``POST .../approve``: the PRD's decider (or an owner) approves the meeting's drafts.
- ``POST .../end``: the presenter, the decider or an owner; Oracle drafts the minutes.
- ``PUT .../minutes``: edit them before sending; ``POST .../send``: Decisions and Inbox
  always, email and Slack when chosen.
- ``GET /v1/simple/decisions``: viewer and up; grouped by meeting, filters ``prd``,
  ``goal``, ``meeting``.

Changes made in a meeting go through ``POST /v1/simple/changes`` with the meeting's
``session_id`` (oracle.simple.changes_router records each as a meeting decision).
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query

from oracle.auth.deps import Principal, TenantDB
from oracle.simple import meetings
from oracle.simple.router import _people
from oracle.simple.schemas import (
    SimpleDecisionsOut,
    SimpleMeetingCommentIn,
    SimpleMeetingIn,
    SimpleMeetingOut,
    SimpleMeetingRulesIn,
    SimpleMeetingsOut,
    SimpleMinutesIn,
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
    return await _run(db, meetings.one(db, principal, meeting_id, not_approved))


@router.get("/meetings", response_model=SimpleMeetingsOut, name="list_simple_meetings")
async def list_simple_meetings(principal: Reader, db: TenantDB) -> SimpleMeetingsOut:
    """Upcoming reviews from the rituals, live meetings and past ones (newest first)."""
    return await _run(db, meetings.listing(db, principal))


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
    if (m.delivery or {}).get("email_status") == "queued":
        background.add_task(_email, principal.tenant_id, meeting_id)
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
    return await _run(db, meetings.decisions_page(db, principal, prd, goal, meeting))
