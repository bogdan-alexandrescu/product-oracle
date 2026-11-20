"""Simple meetings: starting one, from a PRD or a ritual's occurrence."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.authz import has_role
from oracle.docs.models import Document
from oracle.roadmap.models import ProductTrack
from oracle.roadmap.tracks import on_prd as tracks_on_prd
from oracle.simple.meetings_common import (
    MeetingError,
    _me,
    _members,
    _prd,
    _prd_items,
    _readable,
    may_start,
    prd_who,
)
from oracle.simple.models import SimpleMeeting
from oracle.simple.schemas import SimpleMeetingIn


async def start(db: AsyncSession, principal: Any, body: SimpleMeetingIn) -> SimpleMeeting:
    """A new meeting and its titled session (the caller commits). 403 unless the caller
    is an owner or the PRD's decider."""
    from oracle.rituals.models import Ritual, RitualOccurrence
    from oracle.simple import changes

    me = _me(principal)
    document = await _prd(db, principal, body.prd)
    w = await prd_who(db, document)
    if not may_start(principal, w):
        raise MeetingError(403, "Only an owner or the PRD's decider starts its review meeting")
    members = {u.id for u in await _members(db)}
    attendees = list(dict.fromkeys([me, *body.attendee_ids]))
    unknown = [str(i) for i in attendees if i not in members]
    if unknown:
        raise MeetingError(422, f"Not active members: {', '.join(unknown)}")
    people = list(dict.fromkeys(body.change_people))
    if body.change_mode == "named":
        if not 1 <= len(people) <= 2 or any(p not in attendees for p in people):
            raise MeetingError(422, "Name one or two people in the meeting who may change things")
    else:
        people = []
    title = (body.title or "").strip()
    occurrence = None
    occurrence_id = body.occurrence_id
    if occurrence_id is None and body.ritual_id is not None:
        occurrence_id = await _occurrence_now(db, principal, body.ritual_id, body.due_at)
    if occurrence_id is not None:
        occurrence = await db.get(RitualOccurrence, occurrence_id)
        if occurrence is None:
            raise MeetingError(404, "No such scheduled review")
        # One meeting per occurrence: two crossing starts wait on each other here.
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
                         {"k": f"simple_meetings.occurrence:{occurrence.id}"})  # fmt: skip
        first = await db.scalar(
            select(SimpleMeeting.id).where(SimpleMeeting.occurrence_id == occurrence.id)
        )
        if first is not None:
            raise MeetingError(409, {"message": "This scheduled review has its meeting already",
                                     "meeting_id": str(first)})  # fmt: skip
        if not title:
            ritual = await db.get(Ritual, occurrence.ritual_id)
            title = f"{ritual.title}: {document.title}" if ritual else ""
    title = title or f"Review: {document.title}"
    roadmap_id = await _reviewed_roadmap(db, principal, document, body.roadmap)
    session = await changes.start_session(db, principal, "meeting")
    m = SimpleMeeting(
        title=title[:200],
        prd_document_id=document.id,
        origin="ritual" if occurrence is not None else body.origin,
        occurrence_id=occurrence.id if occurrence is not None else None,
        session_id=session.id,
        presenter_id=me,
        attendee_ids=attendees,
        absent_ids=[],
        joined_ids=[me],
        change_mode=body.change_mode,
        change_people=people,
        length_min=body.length_min,
        status="live",
        started_at=session.started_at,
        agenda={"roadmap_id": str(roadmap_id)} if roadmap_id else {},
    )
    db.add(m)
    await db.flush()
    await audit.record(db, principal, "simple_meeting.started", "simple_meeting", m.id,
                       data={"prd": str(document.id), "attendees": [str(a) for a in attendees],
                             "change_mode": m.change_mode})  # fmt: skip
    return m


async def _reviewed_roadmap(
    db: AsyncSession, principal: Any, document: Document, ref: str | None
) -> uuid.UUID | None:
    """meeting-changes-only-its-agenda: the roadmap the meeting reviews: the one named
    (422 unless a roadmap with the PRD's items), else the one the PRD's items are on; on
    several, the one its track is on; None when none is (the meeting reviews them all)."""
    _, on = await _prd_items(db, document)
    if ref:
        try:
            where = Document.id == uuid.UUID(ref)
        except ValueError:
            where = Document.slug == ref
        rm = await db.scalar(select(Document).where(where, Document.kind == "roadmap"))
        if rm is None or rm.id not in on or not await _readable(db, principal, rm):
            raise MeetingError(422, f"No roadmap with items of {document.title} is named {ref}")
        return rm.id
    if len(on) <= 1:
        return next(iter(on), None)
    # On several: the roadmap of the PRD's own track (one per PRD), else all of them.
    home = await db.scalar(
        select(ProductTrack.roadmap_document_id).where(tracks_on_prd(document.id))
    )
    return home if home in on else None


def may_start_ritual(principal: Any, ritual: Any) -> bool:
    """Starting a ritual's review uses up its occurrence: owners and the ritual's owner only,
    as Prepare now and the ritual's edits in Detailed (review)."""
    me = _me(principal)
    # qa-simple-decide-14: a viewer starts nothing, whichever ritual it owns.
    return me is not None and (
        has_role(principal.role, "owner")
        or (me == ritual.owner_id and has_role(principal.role, "commenter"))
    )


async def _occurrence_now(
    db: AsyncSession, principal: Any, ritual_id: uuid.UUID, due: datetime | None
) -> uuid.UUID:
    """Starting a ritual's review from its Upcoming row (``due``, the row's due time): its
    occurrence at that time when made, else made now when ``due`` is the ritual's
    ``next_due_at``, which then moves on to the one after, as Prepare now does. A row the
    ritual has moved past (a stale page, a double click, crossing starts) is 409 with the
    meeting already started on it, never next week's occurrence."""
    from oracle.rituals.models import Ritual, RitualOccurrence
    from oracle.rituals.schedule import next_occurrence
    from oracle.rituals.service import _create_occurrence

    ritual = await db.get(Ritual, ritual_id, with_for_update=True)
    if ritual is None or ritual.status != "active":
        raise MeetingError(404, "No such scheduled review")
    if not may_start_ritual(principal, ritual):
        raise MeetingError(403, "Only an owner or the ritual's owner starts its review")
    if due is None:
        raise MeetingError(422, "due_at: the review's due time is required with ritual_id")
    made = await db.scalar(
        select(RitualOccurrence.id).where(
            RitualOccurrence.ritual_id == ritual.id, RitualOccurrence.due_at == due
        )
    )
    if made is not None:
        return made
    if ritual.next_due_at is None or ritual.next_due_at != due:
        raise MeetingError(409, {"message": "This scheduled review has moved on: reload Upcoming",
                                 "meeting_id": None})  # fmt: skip
    occ_id = await _create_occurrence(db, ritual, due)
    ritual.next_due_at = next_occurrence(ritual.schedule, due)
    await db.flush()
    return occ_id
