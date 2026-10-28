"""Simple S8 (#723, D7, D19 and the owner's picks): review meetings and the Decisions page.

**A meeting** reviews one PRD: its one-pager, its roadmap slice, then its open decisions
and pending proposals, on one screen with a clock. It is a titled session (``simple_sessions``
``kind = 'meeting'``) joining the shared working drafts (oracle.simple.drafts): every
change made through it is the change engine's, under the caller's own rights (owners and
the decider apply, approvers and commenters propose, viewers read), and is marked as made
in the meeting. The presenter decides who may change things through the meeting
(:class:`MeetingRules`: everyone in it, only the presenter, or the presenter plus one or
two named people).

**Who starts one**: an owner or the PRD's decider; everyone else sees who may start it
and joins once it is live. A scheduled review occurrence has at most one meeting. A meeting
whose session closed for idleness (oracle.simple.changes.MEETING_IDLE) ends on its next
read, with Oracle's quick minutes (:func:`_settle`). Default attendees: the PRD's decider,
its required reviewers and its owners (its tracks' owners); any member can be added.

**Every action is a meeting decision**: each approve, cut, move, accept, decline, undo or
comment made in the meeting is recorded by :func:`record_meeting_decision`: a
``decisions`` row (origin ``meeting``, subjects the items and lines it changed, approver
who decided), linked to the meeting and the changes (``simple_meeting_decisions``).

**Approve** is the decider's, through :func:`oracle.simple.drafts.approve_in_meeting`: the
required reviewers present approve there too; each absent one gets an Inbox request and
the draft publishes only once they approve.

**End**: Oracle's quick draft of the minutes at once (summary, decisions, open questions,
action items, what waits on whom), then the ``meeting_minutes`` job's (an llm job under
its budget) unless a person edited them. Sending posts them to Simple's Decisions page and
each attendee's Inbox, always; email to the attendees (Oracle's mailer) and a post to the
company's Slack Notifications channel are optional, chosen by whoever sends. Action items
are added through the change engine (``add_action_item`` with the meeting's id).

**Each decided flow is linked**: a meeting decision on a new flow or feature (a draft item)
carries that item and its flow from S10's ``oracle.simple.visuals.flow_for`` (none while
that module is absent or has drawn none: "No flow yet").

Visibility: a meeting is seen by whoever reads its PRD (oracle.docs.visibility).
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts
from oracle.simple.models import (
    SimpleChange,
    SimpleDraft,
    SimpleMeeting,
    SimpleSession,
    SimpleSessionDraft,
)
from oracle.simple.models import (
    SimpleMeetingDecision as MeetingDecisionRow,
)
from oracle.simple.schemas import (
    InboxSimpleMinutes,
    SimpleActionItemOut,
    SimpleAttendee,
    SimpleDecidedFlow,
    SimpleDecisionRow,
    SimpleDecisionsOut,
    SimpleDelivery,
    SimpleDocRef,
    SimpleFilterOption,
    SimpleMeetingBrief,
    SimpleMeetingCan,
    SimpleMeetingDecision,
    SimpleMeetingGroup,
    SimpleMeetingIn,
    SimpleMeetingOut,
    SimpleMeetingRulesIn,
    SimpleMeetingsOut,
    SimpleMinutes,
    SimpleMinutesIn,
    SimpleOpenDecision,
    SimplePersonRef,
    SimpleSendIn,
    SimpleSlackState,
    SimpleStartOptions,
    SimpleStartPrd,
    SimpleUpcomingMeeting,
)

log = logging.getLogger(__name__)

SOURCE_KIND = "simple_meeting_decision"
DEFAULT_LENGTH = 60
INBOX_DAYS = 30
UPCOMING_MAX = 20
# A minutes job still drafting after this long: "still drafting", send what is written.
MINUTES_SLOW = timedelta(minutes=2)
SUMMARY_MAX = 4000
MAX_QUESTIONS = 5
MAX_ACTIONS = 8


class MeetingError(Exception):
    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(detail if isinstance(detail, str) else detail.get("message"))
        self.status = status
        self.detail = detail


# --------------------------------------------------------------------------- the contract


@dataclass
class MeetingRules:
    """Who may change things through a meeting (the presenter's change mode, D22a)."""

    meeting_id: uuid.UUID
    session_id: uuid.UUID
    presenter_id: uuid.UUID
    attendee_ids: list[uuid.UUID]
    change_mode: Literal["everyone", "presenter", "named"]
    change_people: list[uuid.UUID]
    ended: bool

    def may_change(self, user_id: uuid.UUID | None) -> bool:
        """Whether ``user_id`` may change things through the meeting: never once ended;
        the presenter always; then everyone in it, or the named people."""
        if user_id is None or self.ended:
            return False
        if user_id == self.presenter_id:
            return True
        if self.change_mode == "everyone":
            return user_id in self.attendee_ids
        if self.change_mode == "named":
            return user_id in self.change_people
        return False


def _rules(m: SimpleMeeting) -> MeetingRules:
    return MeetingRules(
        meeting_id=m.id,
        session_id=m.session_id,
        presenter_id=m.presenter_id,
        attendee_ids=list(m.attendee_ids or []),
        change_mode=m.change_mode,  # type: ignore[arg-type]
        change_people=list(m.change_people or []),
        ended=m.status == "ended",
    )


async def meeting_rules(db: AsyncSession, meeting_id: uuid.UUID) -> MeetingRules | None:
    m = await db.get(SimpleMeeting, meeting_id)
    if m is not None:
        await _settle(db, [m])
    return _rules(m) if m is not None else None


async def rules_for_session(db: AsyncSession, session_id: uuid.UUID) -> MeetingRules | None:
    m = await db.scalar(select(SimpleMeeting).where(SimpleMeeting.session_id == session_id))
    return _rules(m) if m is not None else None


async def record_meeting_decision(
    db: AsyncSession,
    principal: Any,
    meeting_id: uuid.UUID,
    title: str,
    subjects: list[dict],
    change_ids: list[uuid.UUID],
) -> uuid.UUID:
    """One meeting decision: a ``decisions`` row (origin ``meeting``, decided, approver
    the caller), linked to the meeting and the changes it made. 404 for no such meeting,
    409 once it ended. The caller commits."""
    from oracle.decisions import capture

    me = _me(principal)
    m = await db.get(SimpleMeeting, meeting_id)
    if m is None:
        raise MeetingError(404, "No such meeting")
    if m.status == "ended":
        raise MeetingError(409, "This meeting has ended")
    if me is None:
        raise MeetingError(403, "Meeting decisions are made by people")
    clean = [_subject(s) for s in subjects or []]
    d = await capture.capture(
        db,
        principal,
        origin="meeting",
        source_kind=SOURCE_KIND,
        source_id=uuid.uuid4(),
        title=title,
        options=[{"key": "decided", "label": title}],
        chosen_option="decided",
        rationale=f"Decided in {m.title}",
        approver_id=me,
        context=f"Decided in the review meeting {m.title}",
        subjects=[s for s in clean if s is not None],
        decided_by=me,
    )
    db.add(
        MeetingDecisionRow(
            meeting_id=m.id, decision_id=d.id, change_ids=list(change_ids), at=company_time.now()
        )
    )
    await db.flush()
    return d.id


def _subject(s: dict) -> dict | None:
    try:
        sid = str(uuid.UUID(str(s.get("id"))))
    except (TypeError, ValueError):
        return None
    out: dict[str, Any] = {"kind": str(s.get("kind") or "document")[:40], "id": sid}
    if s.get("ref"):
        out["ref"] = str(s["ref"])[:300]
    return out


# --------------------------------------------------------------------------- who


def _me(principal: Any) -> uuid.UUID | None:
    if principal is None or getattr(principal, "run_id", None) is not None:
        return None
    return getattr(principal, "user_id", None)


@dataclass
class PrdWho:
    decider: uuid.UUID | None
    reviewers: list[uuid.UUID]
    owners: list[uuid.UUID]


async def prd_who(db: AsyncSession, document: Document) -> PrdWho:
    from oracle.simple import one_pager

    w = await one_pager.who(db, document)
    return PrdWho(w.decider, list(w.reviewers), list(w.track_owners))


def may_start(principal: Any, w: PrdWho) -> bool:
    """Only owners and the document's decider start a meeting (the owner's pick)."""
    me = _me(principal)
    return me is not None and (has_role(principal.role, "owner") or me == w.decider)


async def _names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    return {u.id: u.name or u.email for u in await db.scalars(select(User).where(User.id.in_(ids)))}


def _ref(i: uuid.UUID, names: dict[uuid.UUID, str]) -> SimplePersonRef:
    return SimplePersonRef(id=i, name=names.get(i, "someone"))


async def _members(db: AsyncSession) -> list[User]:
    return list(
        await db.scalars(
            select(User).where(User.disabled_at.is_(None)).order_by(User.name, User.email)
        )
    )


async def _company_owners(db: AsyncSession) -> list[uuid.UUID]:
    return list(
        await db.scalars(
            select(User.id)
            .where(User.role == "owner", User.disabled_at.is_(None))
            .order_by(User.created_at, User.id)
        )
    )


async def _prd(db: AsyncSession, principal: Any, ref: str) -> Document:
    from oracle.simple import one_pager
    from oracle.simple.changes import ChangeError

    try:
        document = await one_pager._document(db, principal, ref)
    except ChangeError as e:
        raise MeetingError(e.status, str(e)) from e
    if document.kind != "prd":
        raise MeetingError(422, "A review meeting reviews a PRD")
    return document


async def _readable(db: AsyncSession, principal: Any, document: Document) -> bool:
    from oracle.docs import visibility

    return visibility.can_see(principal, document) and not getattr(document, "deleted_at", None)


def _defaults(w: PrdWho, me: uuid.UUID | None) -> list[uuid.UUID]:
    ids = [i for i in [w.decider, *w.reviewers, *w.owners] if i is not None]
    if me is not None:
        ids.insert(0, me)
    return list(dict.fromkeys(ids))


# --------------------------------------------------------------------------- start


async def options(
    db: AsyncSession, principal: Any, prd: str | None, occurrence: uuid.UUID | None
) -> SimpleStartOptions:
    """The start sheet: the PRDs the caller reads (one, with ``prd``), each with who may
    start it and its default attendees; the members; a ritual occurrence's details."""
    me = _me(principal)
    if prd:
        docs = [await _prd(db, principal, prd)]
    else:
        docs = [
            d
            for d in await db.scalars(
                select(Document)
                .where(Document.kind == "prd", Document.deleted_at.is_(None))
                .order_by(Document.title)
            )
            if await _readable(db, principal, d)
        ]
    owners = await _company_owners(db)
    members = await _members(db)
    names = {u.id: u.name or u.email for u in members}
    prds = []
    for d in docs:
        w = await prd_who(db, d)
        starters = list(dict.fromkeys([*([w.decider] if w.decider else []), *owners]))
        prds.append(
            SimpleStartPrd(
                document=SimpleDocRef(id=d.id, slug=d.slug, title=d.title),
                decider=_ref(w.decider, names) if w.decider else None,
                can_start=may_start(principal, w),
                starters=[_ref(i, names) for i in starters],
                default_attendee_ids=_defaults(w, me),
            )
        )
    occ = None
    if occurrence is not None:
        occ = (await _upcoming(db, names, principal, only=occurrence))[:1]
        occ = occ[0] if occ else None
        if occ is None:
            raise MeetingError(404, "No such scheduled review")
    return SimpleStartOptions(
        prds=prds,
        members=[SimplePersonRef(id=u.id, name=names[u.id]) for u in members],
        length_min=occ.length_min if occ else DEFAULT_LENGTH,
        occurrence=occ,
    )


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
        change_mode=body.change_mode,
        change_people=people,
        length_min=body.length_min,
        status="live",
        started_at=session.started_at,
    )
    db.add(m)
    await db.flush()
    await audit.record(db, principal, "simple_meeting.started", "simple_meeting", m.id,
                       data={"prd": str(document.id), "attendees": [str(a) for a in attendees],
                             "change_mode": m.change_mode})  # fmt: skip
    return m


def may_start_ritual(principal: Any, ritual: Any) -> bool:
    """Starting a ritual's review uses up its occurrence: owners and the ritual's owner only,
    as Prepare now and the ritual's edits in Detailed (review)."""
    me = _me(principal)
    return me is not None and (has_role(principal.role, "owner") or me == ritual.owner_id)


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


async def _get(db: AsyncSession, principal: Any, meeting_id: uuid.UUID, lock: bool = False):
    m = await db.get(SimpleMeeting, meeting_id, with_for_update=lock)
    if m is None:
        raise MeetingError(404, "No such meeting")
    document = await db.get(Document, m.prd_document_id)
    if document is None or not await _readable(db, principal, document):
        raise MeetingError(404, "No such meeting")
    await _settle(db, [m])
    return m, document


async def _settle(db: AsyncSession, ms: list[SimpleMeeting]) -> None:
    """A live meeting whose session closed (idle past MEETING_IDLE, or closed) ends: no
    more changes through it, Oracle's quick minutes for its presenter to edit and send.
    The caller commits."""
    from oracle.simple import changes

    now = company_time.now()
    for m in ms:
        if m.status != "live":
            continue
        session = await db.get(SimpleSession, m.session_id)
        if session is not None and session.closed_at is None and not changes._idle(session, now):
            continue
        if session is not None and session.closed_at is None:
            session.closed_at = now
        m.status = "ended"
        m.ended_at = session.closed_at if session is not None else now
        m.ended_by = m.presenter_id
        m.minutes = await extract(db, m)
        m.minutes_state = "ready"
        await db.flush()
        await audit.record(db, None, "simple_meeting.ended_idle", "simple_meeting", m.id, data={})


def _presenter_or_decider(principal: Any, m: SimpleMeeting, w: PrdWho) -> bool:
    me = _me(principal)
    return me is not None and (
        me in (m.presenter_id, w.decider) or has_role(principal.role, "owner")
    )


async def join(db: AsyncSession, principal: Any, meeting_id: uuid.UUID) -> SimpleMeeting:
    """The caller joins a live meeting (an attendee, present)."""
    m, _ = await _get(db, principal, meeting_id, lock=True)
    me = _me(principal)
    if m.status != "live":
        raise MeetingError(409, "This meeting has ended")
    if me is None:
        raise MeetingError(403, "People join meetings")
    if me not in m.attendee_ids:
        m.attendee_ids = [*m.attendee_ids, me]
    if me in m.absent_ids:
        m.absent_ids = [i for i in m.absent_ids if i != me]
    await db.flush()
    return m


async def set_rules(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, body: SimpleMeetingRulesIn
) -> SimpleMeeting:
    """The presenter's change mode and who is absent (the caller commits)."""
    m, _ = await _get(db, principal, meeting_id, lock=True)
    if _me(principal) != m.presenter_id:
        raise MeetingError(403, "Only the presenter sets who may change things")
    if m.status != "live":
        raise MeetingError(409, "This meeting has ended")
    mode = body.change_mode or m.change_mode
    people = list(dict.fromkeys(body.change_people if body.change_people is not None
                                else m.change_people))  # fmt: skip
    if mode == "named":
        if not 1 <= len(people) <= 2 or any(p not in m.attendee_ids for p in people):
            raise MeetingError(422, "Name one or two people in the meeting who may change things")
    else:
        people = []
    m.change_mode, m.change_people = mode, people
    if body.absent_ids is not None:
        if any(i not in m.attendee_ids or i == m.presenter_id for i in body.absent_ids):
            raise MeetingError(422, "Only attendees other than the presenter are marked absent")
        m.absent_ids = list(dict.fromkeys(body.absent_ids))
    await db.flush()
    await audit.record(db, principal, "simple_meeting.rules", "simple_meeting", m.id,
                       data={"change_mode": mode, "change_people": [str(p) for p in people],
                             "absent": [str(a) for a in m.absent_ids]})  # fmt: skip
    return m


# --------------------------------------------------------------------------- deciding


async def describe(db: AsyncSession, c: SimpleChange) -> tuple[str, list[dict]]:
    """A change in words, and the subjects it names (its item, its PRD's line)."""
    t = c.target or {}
    subjects: list[dict] = []
    name = ""
    item_id = t.get("item_id")
    if item_id:
        try:
            row = await db.get(RoadmapItem, uuid.UUID(str(item_id)))
        except ValueError:
            row = None
        if row is not None:
            name = row.title
            subjects.append({"kind": "roadmap_item", "id": str(row.id), "ref": row.item_key})
    if c.op == "edit_line":
        doc = await db.get(Document, uuid.UUID(str(t.get("document_id")))) if t.get(
            "document_id") else None  # fmt: skip
        after = str((c.after or {}).get("line") or "")
        name = f"a line of {doc.title}: “{after[:120]}”" if doc else "a one-pager line"
        if doc is not None:
            subjects.append(
                {"kind": "section", "id": str(doc.id), "ref": f"line:{t.get('line_id')}"}
            )
    elif not name:
        name = str((c.after or {}).get("title") or t.get("title") or "")
    words = drafts.OP_WORDS.get(c.op) or c.op.replace("_", " ").capitalize()
    return f"{words} {name}".strip(), subjects


async def after_change(
    db: AsyncSession,
    principal: Any,
    change_id: uuid.UUID,
    session_id: uuid.UUID | None,
    verb: str | None = None,
) -> uuid.UUID | None:
    """A change made through a meeting's session (made, accepted, declined or undone)
    becomes a meeting decision; commits. None when the session is no meeting's."""
    if session_id is None:
        return None
    m = await db.scalar(select(SimpleMeeting).where(SimpleMeeting.session_id == session_id))
    if m is None or m.status != "live":
        return None
    c = await db.get(SimpleChange, change_id)
    if c is None:
        return None
    title, subjects = await describe(db, c)
    if verb:
        title = f"{verb}: {title}"
    elif c.status == "proposed":
        title = f"Proposed: {title}"
    subjects.append({"kind": "document", "id": str(m.prd_document_id)})
    did = await record_meeting_decision(db, principal, m.id, title, subjects, [change_id])
    await db.commit()
    return did


async def comment(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, text: str, subjects: list[dict]
) -> uuid.UUID:
    """A comment made in the meeting is a meeting decision too (D7)."""
    m, _ = await _get(db, principal, meeting_id)
    if not _rules(m).may_change(_me(principal)) and _me(principal) not in m.attendee_ids:
        raise MeetingError(403, "Join the meeting to comment in it")
    did = await record_meeting_decision(
        db, principal, m.id, f"Comment: {' '.join(text.split())}",
        [*subjects, {"kind": "document", "id": str(m.prd_document_id)}], [],
    )  # fmt: skip
    return did


def published_words(d: Any, names: dict[uuid.UUID, str]) -> str:
    """ "published" only when the draft's version really is (#723, production); else what
    still holds it, in the meeting banner's words: "not yet published: Waiting on Rae's
    approval · Sections Scope need a reviewer"."""
    if d.status == "approved":
        return "published"
    why = []
    if d.waiting_on:
        who = drafts._people([names.get(i, "someone") for i in d.waiting_on])
        why.append(f"Waiting on {who}'s approval")
    why += list(d.blocked_by or [])
    return "not yet published: " + (" · ".join(why) or "its review is not complete")


async def approve(db: AsyncSession, principal: Any, meeting_id: uuid.UUID):
    """The decider's Approve: every draft the meeting worked on, with the required
    reviewers present approving too (oracle.simple.drafts.approve_in_meeting); the
    approval is a meeting decision. The caller commits."""
    m, document = await _get(db, principal, meeting_id, lock=True)
    w = await prd_who(db, document)
    me = _me(principal)
    if m.status != "live":
        raise MeetingError(409, "This meeting has ended")
    if me is None or not (me == w.decider or has_role(principal.role, "owner")):
        raise MeetingError(403, "Only the PRD's decider (or an owner) approves in the meeting")
    session = await db.get(SimpleSession, m.session_id)
    present = [i for i in m.attendee_ids if i not in m.absent_ids and i != me]
    try:
        result = await drafts.approve_in_meeting(db, session, me, present)
    except drafts.DraftError as e:
        raise MeetingError(e.status, str(e)) from e
    if not result.drafts:
        if result.not_approved:
            return result
        raise MeetingError(422, "Nothing to approve: no change was made in this meeting")
    names = await _names(db, {i for d in result.drafts for i in d.waiting_on})
    parts = []
    for d in result.drafts:
        parts.append(f"{d.document.title} ({published_words(d, names)})")
    await record_meeting_decision(
        db, principal, m.id, f"Approved {'; '.join(parts)}",
        [{"kind": "document", "id": str(d.document.id)} for d in result.drafts], [],
    )  # fmt: skip
    return result


# --------------------------------------------------------------------------- reading


async def _decisions(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, list]:
    """Each meeting's decisions, newest first: (link row, decision)."""
    out: dict[uuid.UUID, list] = {i: [] for i in ids}
    if not ids:
        return out
    rows = (
        await db.execute(
            select(MeetingDecisionRow, Decision)
            .join(Decision, Decision.id == MeetingDecisionRow.decision_id)
            .where(MeetingDecisionRow.meeting_id.in_(ids))
            .order_by(MeetingDecisionRow.at.desc(), Decision.number.desc())
        )
    ).all()
    for link, d in rows:
        out[link.meeting_id].append((link, d))
    return out


def _attendees(m: SimpleMeeting, w: PrdWho, names: dict) -> list[SimpleAttendee]:
    out = []
    for i in m.attendee_ids:
        roles = []
        if i == m.presenter_id:
            roles.append("presenter")
        if i == w.decider:
            roles.append("decider")
        if i in w.reviewers:
            roles.append("reviewer")
        if i in w.owners:
            roles.append("owner")
        out.append(SimpleAttendee(id=i, name=names.get(i, "someone"), roles=roles,  # type: ignore[arg-type]
                                  present=i not in m.absent_ids))  # fmt: skip
    return out


async def briefs(db: AsyncSession, ms: list[SimpleMeeting]) -> list[SimpleMeetingBrief]:
    docs = {
        d.id: d
        for d in await db.scalars(
            select(Document).where(Document.id.in_({m.prd_document_id for m in ms}))
        )
    } if ms else {}  # fmt: skip
    counts = dict(
        (
            await db.execute(
                select(MeetingDecisionRow.meeting_id, func.count())
                .where(MeetingDecisionRow.meeting_id.in_([m.id for m in ms]))
                .group_by(MeetingDecisionRow.meeting_id)
            )
        ).all()
    ) if ms else {}  # fmt: skip
    names = await _names(db, {i for m in ms for i in [m.presenter_id, *m.attendee_ids]})
    out = []
    for m in ms:
        doc = docs[m.prd_document_id]
        w = await prd_who(db, doc)
        out.append(
            SimpleMeetingBrief(
                id=m.id,
                title=m.title,
                prd=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
                origin=m.origin,  # type: ignore[arg-type]
                status=m.status,  # type: ignore[arg-type]
                presenter=_ref(m.presenter_id, names),
                attendees=_attendees(m, w, names),
                length_min=m.length_min,
                started_at=m.started_at,
                ended_at=m.ended_at,
                decisions=counts.get(m.id, 0),
                minutes_state=m.minutes_state,  # type: ignore[arg-type]
                summary=(m.minutes or {}).get("summary") if m.minutes_state == "sent" else None,
            )
        )
    return out


async def _slack_state(db: AsyncSession) -> SimpleSlackState:
    from oracle.integrations import slack_oauth
    from oracle.reports.alignment import validate_setting
    from oracle.tenant_settings_api import get_setting

    install = await slack_oauth.installed(db)
    if install is None or install.status != "active":
        return SimpleSlackState(connected=False)
    channel = validate_setting(await get_setting(db, "alignment_report")).get("slack_channel")
    name = None
    if channel:
        name = channel.get("name") or channel.get("id")
    return SimpleSlackState(connected=True, channel=f"#{name}" if name else None)


def email_available() -> bool:
    from oracle.members import mailer

    return mailer.get_mailer() is not None


async def _open_decisions(db: AsyncSession, document: Document, item_ids: set[uuid.UUID]):
    rows = await db.scalars(
        select(Decision)
        .where(Decision.status == "proposed")
        .where(
            or_(
                Decision.subjects.contains([{"kind": "document", "id": str(document.id)}]),
                *[
                    Decision.subjects.contains([{"kind": "roadmap_item", "id": str(i)}])
                    for i in item_ids
                ],
            )  # fmt: skip
        )
        .order_by(Decision.number.desc())
    )
    return [SimpleOpenDecision(id=d.id, number=d.number, title=d.title) for d in rows]


async def _prd_items(db: AsyncSession, document: Document) -> tuple[set, set]:
    """The PRD's roadmap items (ids of every version) and the roadmaps they are on."""
    rows = (
        await db.execute(
            select(RoadmapItem.id, RoadmapItem.roadmap_document_id).where(
                RoadmapItem.prd_document_id == document.id
            )
        )
    ).all()
    return {r[0] for r in rows}, {r[1] for r in rows}


async def one(db: AsyncSession, principal: Any, meeting_id: uuid.UUID,
              not_approved: list | None = None) -> SimpleMeetingOut:  # fmt: skip
    from oracle.simple import changes

    m, document = await _get(db, principal, meeting_id)
    w = await prd_who(db, document)
    me = _me(principal)
    [brief] = await briefs(db, [m])
    rules = _rules(m)
    links = (await _decisions(db, [m.id]))[m.id]
    flows = await decided_flows(db, links)
    item_ids, roadmap_ids = await _prd_items(db, document)
    names = await _names(db, {d.approver_id for _, d in links} | set(m.change_people))
    proposals = list(
        await db.scalars(
            select(SimpleChange)
            .where(
                SimpleChange.status == "proposed",
                or_(
                    SimpleChange.document_id == document.id,
                    SimpleChange.target["item_id"].astext.in_([str(i) for i in item_ids]),
                ),
            )
            .order_by(SimpleChange.at)
        )
    )
    seen = [c for c in proposals if await _sees_change(db, principal, c)]
    ds = list(
        await db.scalars(
            select(SimpleDraft)
            .join(SimpleSessionDraft, SimpleSessionDraft.draft_id == SimpleDraft.id)
            .where(SimpleSessionDraft.session_id == m.session_id)
            .order_by(SimpleDraft.created_at)
        )
    )
    dw = await drafts.who(db, {d.document_id for d in ds})
    ds = [d for d in ds if drafts.sees(principal, d, dw)]
    waiting = list(dict.fromkeys(i for d in ds for i in d.waiting_on or []))
    waiting_names = await _names(db, set(waiting))
    decider_or_owner = me is not None and (me == w.decider or has_role(principal.role, "owner"))
    job_state = await _minutes_job(db, m)
    return SimpleMeetingOut(
        **brief.model_dump(),
        session_id=m.session_id,
        occurrence_id=m.occurrence_id,
        change_mode=m.change_mode,  # type: ignore[arg-type]
        change_people=[_ref(i, names) for i in m.change_people],
        roadmap_ids=sorted(roadmap_ids, key=str),
        meeting_decisions=[
            SimpleMeetingDecision(
                id=d.id,
                number=d.number,
                title=d.title,
                approver=_ref(d.approver_id, names),
                at=link.at,
                subjects=list(d.subjects or []),
                change_ids=list(link.change_ids or []),
                flow=flows.get(d.id),
            )  # fmt: skip
            for link, d in links
        ],
        open_decisions=await _open_decisions(db, document, item_ids),
        pending_proposals=[await changes.one_out(db, principal, c) for c in seen],
        drafts=await _draft_outs(db, principal, ds),
        waiting_people=[_ref(i, waiting_names) for i in waiting],
        minutes=SimpleMinutes.model_validate(m.minutes) if m.minutes else None,
        minutes_job=job_state,
        delivery=SimpleDelivery.model_validate(m.delivery) if m.delivery else None,
        slack=await _slack_state(db),
        email_available=email_available(),
        can=SimpleMeetingCan(
            change=rules.may_change(me) and has_role(principal.role, "commenter"),
            set_rules=m.status == "live" and me == m.presenter_id,
            approve=m.status == "live" and decider_or_owner,
            end=_presenter_or_decider(principal, m, w) and m.minutes_state != "sent",
            redraft=job_state == "failed" and _presenter_or_decider(principal, m, w),
        ),
        not_approved=not_approved or [],
    )


async def _draft_outs(db: AsyncSession, principal: Any, ds: list) -> list:
    """The meeting's drafts; one its decider approved that has not published names what
    still holds it (``blocked_by``, as last settled: drafts.held), so the banner never
    says "published" for it."""
    if not ds:
        return []
    out = await drafts.outs(db, principal, ds)
    for o, d in zip(out, ds, strict=True):
        o.blocked_by = drafts.held(d)
    return out


async def _minutes_job(db: AsyncSession, m: SimpleMeeting) -> str | None:
    """While the minutes are drafting: "failed" (the job failed, was cancelled or is
    gone), "slow" (queued or running past MINUTES_SLOW) or "drafting"."""
    from oracle.jobs import service as jobs
    from oracle.jobs.models import LlmJob

    if m.status != "ended" or m.minutes_state != "drafting":
        return None
    job = await db.get(LlmJob, m.minutes_job_id) if m.minutes_job_id else None
    if job is None or job.status in ("failed", "cancelled"):
        return "failed"
    if job.status == "succeeded":
        return "drafting"  # its answer lands with the next read of the job's commit
    # Queued, started or requeued (Draft again) last: each touches updated_at, on the job
    # runner's clock (the wall clock).
    return "slow" if jobs._now() - job.updated_at > MINUTES_SLOW else "drafting"


async def _sees_change(db: AsyncSession, principal: Any, c: SimpleChange) -> bool:
    me = _me(principal)
    if me is None:
        return False
    return c.by == me or has_role(principal.role, "owner") or me in (c.routed_to or [])


async def _upcoming(
    db: AsyncSession, names: dict, principal: Any, only: uuid.UUID | None = None
) -> list[SimpleUpcomingMeeting]:
    """The reviews to start, the one source Home's "Next review meeting" and the rail's
    Meetings count read too: one row per active ritual, soonest first: its open occurrence
    (scheduled or ready, not over), else its next due time, however far ahead (BGD,
    2026-10-27: no horizon), when no occurrence is made for it yet (rituals make them only
    ``prep_hours`` ahead)."""
    from oracle.rituals.models import Ritual, RitualOccurrence

    now = company_time.now()
    q = (
        select(RitualOccurrence, Ritual)
        .join(Ritual, Ritual.id == RitualOccurrence.ritual_id)
        .where(Ritual.status == "active")
    )
    if only is not None:
        q = q.where(RitualOccurrence.id == only)
    else:
        q = q.where(
            RitualOccurrence.status.in_(("scheduled", "ready")), RitualOccurrence.ends_at >= now
        )
    rows: list[tuple[Any, Any]] = list(
        (await db.execute(q.order_by(RitualOccurrence.due_at).limit(UPCOMING_MAX))).all()
    )
    if only is None:
        # A ritual once: its soonest open occurrence (rows are soonest first).
        first: dict[uuid.UUID, tuple[Any, Any]] = {}
        for o, r in rows:
            first.setdefault(r.id, (o, r))
        rows, seen = list(first.values()), set(first)
        for r in await db.scalars(
            select(Ritual).where(
                Ritual.status == "active",
                Ritual.next_due_at.is_not(None),
            )
        ):
            if r.id not in seen:
                rows.append((None, r))
        rows.sort(key=lambda x: x[0].due_at if x[0] is not None else x[1].next_due_at)
        rows = rows[:UPCOMING_MAX]
    occ_ids = [o.id for o, _ in rows if o is not None]
    started = dict(
        (
            await db.execute(
                select(SimpleMeeting.occurrence_id, SimpleMeeting.id).where(
                    SimpleMeeting.occurrence_id.in_(occ_ids)
                )
            )
        ).all()
    ) if occ_ids else {}  # fmt: skip
    # The walk: the ritual's real attendees are its owner and attendees and whoever was
    # present at the last review held from it (a meeting started from one of its
    # occurrences), until the ritual's list is edited after that review: then its list is.
    held: dict[uuid.UUID, list[uuid.UUID]] = {}
    edited = {r.id: r.updated_at for _, r in rows}
    if edited:
        for rid, ids, absent, at in await db.execute(
            select(RitualOccurrence.ritual_id, SimpleMeeting.attendee_ids,
                   SimpleMeeting.absent_ids, SimpleMeeting.started_at)
            .join(RitualOccurrence, RitualOccurrence.id == SimpleMeeting.occurrence_id)
            .where(RitualOccurrence.ritual_id.in_(list(edited)))
            .order_by(SimpleMeeting.started_at.desc())
        ):  # fmt: skip
            if rid in held:
                continue
            fresh = edited[rid] is None or at is None or at >= edited[rid]
            held[rid] = [i for i in ids or [] if i not in (absent or [])] if fresh else []
    missing = {i for ids in held.values() for i in ids} - set(names)
    if missing:
        names.update(await _names(db, missing))
    out = []
    for o, r in rows:
        due = o.due_at if o is not None else r.next_due_at
        out.append(SimpleUpcomingMeeting(
            occurrence_id=o.id if o is not None else None,
            ritual_id=r.id,
            ritual_title=r.title,
            due_at=due,
            ends_at=o.ends_at if o is not None else due + timedelta(minutes=r.duration_min),
            length_min=min(max(r.duration_min, 5), 240),
            attendees=[
                SimplePersonRef(id=i, name=names.get(i, "someone"))
                for i in dict.fromkeys([r.owner_id, *(r.attendee_ids or []), *held.get(r.id, [])])
            ],
            meeting_id=started.get(o.id) if o is not None else None,
            pre_read_ready=o is not None and o.status == "ready",
            can_start=may_start_ritual(principal, r),
        ))  # fmt: skip
    return out


async def listing(db: AsyncSession, principal: Any) -> SimpleMeetingsOut:
    """The Meetings page: upcoming reviews from rituals, live meetings, past ones with
    their minutes, newest first."""
    ms = list(await db.scalars(select(SimpleMeeting).order_by(SimpleMeeting.started_at.desc())))
    docs = {
        d.id: d
        for d in await db.scalars(
            select(Document).where(Document.id.in_({m.prd_document_id for m in ms}))
        )
    } if ms else {}  # fmt: skip
    readable = {i for i, d in docs.items() if await _readable(db, principal, d)}
    ms = [m for m in ms if m.prd_document_id in readable]
    await _settle(db, ms)
    out = await briefs(db, ms)
    names = {u.id: u.name or u.email for u in await _members(db)}
    return SimpleMeetingsOut(
        upcoming=await _upcoming(db, names, principal),
        live=[b for b in out if b.status == "live"],
        past=[b for b in out if b.status == "ended"],
    )


# --------------------------------------------------------------------------- end


async def _waits(db: AsyncSession, m: SimpleMeeting) -> list[dict]:
    """What still waits on whom: drafts held for absent reviewers, open proposals."""
    out: list[dict] = []
    ds = list(
        await db.scalars(
            select(SimpleDraft)
            .join(SimpleSessionDraft, SimpleSessionDraft.draft_id == SimpleDraft.id)
            .where(SimpleSessionDraft.session_id == m.session_id)
        )
    )
    doc_ids = {x.document_id for x in ds}
    docs = (
        {d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(doc_ids)))}
        if ds
        else {}
    )
    proposals = list(
        await db.scalars(
            select(SimpleChange).where(
                SimpleChange.session_id == m.session_id, SimpleChange.status == "proposed"
            )
        )
    )
    names = await _names(
        db, {i for d in ds for i in d.waiting_on or []}
        | {i for c in proposals for i in c.routed_to or []},
    )  # fmt: skip
    for d in ds:
        title = docs[d.document_id].title if d.document_id in docs else "a document"
        if d.status == "submitted" and d.waiting_on:
            out.append({"what": f"Publishing {title}: their approval",
                        "on": [{"id": str(i), "name": names.get(i, "someone")}
                               for i in d.waiting_on]})  # fmt: skip
        elif d.status == "working":
            out.append({"what": f"{title}: the working draft is not approved yet", "on": []})
    for c in proposals:
        title, _ = await describe(db, c)
        out.append({"what": f"Proposal: {title}",
                    "on": [{"id": str(i), "name": names.get(i, "someone")}
                           for i in c.routed_to or []]})  # fmt: skip
    return out


async def extract(db: AsyncSession, m: SimpleMeeting) -> dict[str, Any]:
    """Oracle's quick draft of the minutes, shown at once."""
    links = (await _decisions(db, [m.id]))[m.id]
    titles = [d.title for _, d in reversed(links)]
    if titles:
        word = "decision" if len(titles) == 1 else "decisions"
        more = "…" if len(titles) > 6 else "."
        summary = f"{len(titles)} {word} in {m.title}: " + "; ".join(titles[:6]) + more
    else:
        summary = f"{m.title}: no decision was taken."
    document = await db.get(Document, m.prd_document_id)
    item_ids, _ = await _prd_items(db, document)
    questions = [f"D-{d.number}: {d.title}" for d in await _open_decisions(db, document, item_ids)]
    return {
        "summary": summary[:SUMMARY_MAX],
        "open_questions": questions[:MAX_QUESTIONS],
        "action_items": [],
        "waits": await _waits(db, m),
        "written_by": "extract",
    }


async def end(db: AsyncSession, principal: Any, meeting_id: uuid.UUID) -> SimpleMeeting:
    """End the meeting: no more changes through it; Oracle's quick minutes at once and the
    ``meeting_minutes`` job queued (the caller commits)."""
    from oracle.jobs import service as jobs

    m, document = await _get(db, principal, meeting_id, lock=True)
    w = await prd_who(db, document)
    if not _presenter_or_decider(principal, m, w):
        raise MeetingError(403, "Only the presenter, the PRD's decider or an owner ends it")
    if m.status == "ended":
        raise MeetingError(409, "This meeting has ended already")
    now = company_time.now()
    m.status, m.ended_at, m.ended_by = "ended", now, _me(principal)
    session = await db.get(SimpleSession, m.session_id, with_for_update=True)
    if session is not None and session.closed_at is None:
        session.closed_at = now
    m.minutes = await extract(db, m)
    m.minutes_state = "ready"
    try:
        job = await jobs.enqueue(db, document, "meeting_minutes", input={"meeting_id": str(m.id)},
                                 principal=principal)  # fmt: skip
        m.minutes_job_id, m.minutes_state = job.id, "drafting"
    except jobs.JobError:
        pass  # turned off for the PRD: the quick draft stays
    await db.flush()
    await audit.record(db, principal, "simple_meeting.ended", "simple_meeting", m.id,
                       data={"minutes_job_id": str(m.minutes_job_id) if m.minutes_job_id
                             else None})  # fmt: skip
    return m


def _clean_actions(raw: Any, members: set[uuid.UUID], default: uuid.UUID | None) -> list[dict]:
    out = []
    for a in raw if isinstance(raw, list) else []:
        if not isinstance(a, dict) or not str(a.get("title") or "").strip():
            continue
        owner = None
        try:
            owner = uuid.UUID(str(a.get("owner_id"))) if a.get("owner_id") else None
        except ValueError:
            owner = None
        if owner not in members:
            owner = default
        due = None
        try:
            due = date.fromisoformat(str(a["due_date"])).isoformat() if a.get("due_date") else None
        except ValueError:
            due = None
        out.append({"title": " ".join(str(a["title"]).split())[:200],
                    "owner_id": str(owner) if owner else None, "due_date": due})  # fmt: skip
    return out[:MAX_ACTIONS]


async def run_job(s: AsyncSession, job, ask) -> dict[str, Any]:
    """The ``meeting_minutes`` job: one call with the meeting's decisions, open items and
    waits; the answer replaces Oracle's quick draft unless a person edited or sent them."""
    from oracle.jobs.kinds import JobInputError

    try:
        meeting_id = uuid.UUID(str((job.input or {}).get("meeting_id")))
    except ValueError as e:
        raise JobInputError("the job names no meeting") from e
    m = await s.get(SimpleMeeting, meeting_id, with_for_update=True)
    if m is None:
        raise JobInputError("the meeting no longer exists")
    document = await s.get(Document, m.prd_document_id)
    links = (await _decisions(s, [m.id]))[m.id]
    names = await _names(s, set(m.attendee_ids) | {d.approver_id for _, d in links})
    waits = await _waits(s, m)
    payload = {
        "title": m.title,
        "prd": document.title if document else "",
        "attendees": [{"id": str(i), "name": names.get(i, "someone")} for i in m.attendee_ids],
        "decisions": [
            {"title": d.title, "by": names.get(d.approver_id, "someone")}
            for _, d in reversed(links)
        ],  # fmt: skip
        "pending": [w["what"] for w in waits],
        "waits": [{"what": w["what"], "on": [p["name"] for p in w["on"]]} for w in waits],
    }
    answer = await ask("meeting_minutes", payload)
    if (m.minutes or {}).get("written_by") == "edited" or m.minutes_state == "sent":
        return {"written": False, "reason": "a person edited or sent the minutes first"}
    summary = " ".join(str(answer.get("summary") or "").split())[:SUMMARY_MAX]
    if not summary:
        m.minutes_state = "ready"
        return {"written": False, "reason": "the answer had no summary"}
    questions = [" ".join(str(q).split())[:300] for q in answer.get("open_questions") or []
                 if str(q).strip()][:MAX_QUESTIONS]  # fmt: skip
    m.minutes = {
        "summary": summary,
        "open_questions": questions,
        "action_items": _clean_actions(
            answer.get("action_items"), set(m.attendee_ids), m.ended_by
        ),  # fmt: skip
        "waits": waits,
        "written_by": "oracle",
    }
    m.minutes_state = "ready"
    await s.flush()
    return {"written": True}


async def redraft(db: AsyncSession, principal: Any, meeting_id: uuid.UUID) -> SimpleMeeting:
    """Draft again: requeue a failed ``meeting_minutes`` job (a new one when it is gone);
    the minutes drafting again. The presenter, the PRD's decider or an owner; 409 unless
    the minutes are drafting with a failed job (the caller commits)."""
    from oracle.jobs import service as jobs
    from oracle.jobs.models import LlmJob

    m, document = await _get(db, principal, meeting_id, lock=True)
    w = await prd_who(db, document)
    if not _presenter_or_decider(principal, m, w):
        raise MeetingError(403, "Only the presenter, the PRD's decider or an owner drafts again")
    if await _minutes_job(db, m) != "failed":
        raise MeetingError(409, "Oracle is not failing to draft these minutes")
    job = await db.get(LlmJob, m.minutes_job_id) if m.minutes_job_id else None
    try:
        if job is not None:
            job = await jobs.retry(db, principal, job.id)
        else:
            job = await jobs.enqueue(
                db, document, "meeting_minutes", input={"meeting_id": str(m.id)},
                principal=principal,
            )  # fmt: skip
    except jobs.JobError as e:
        raise MeetingError(e.status, str(e)) from e
    m.minutes_job_id, m.minutes_state = job.id, "drafting"
    await db.flush()
    await audit.record(db, principal, "simple_meeting.redraft", "simple_meeting", m.id,
                       data={"minutes_job_id": str(job.id)})  # fmt: skip
    return m


async def edit_minutes(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, body: SimpleMinutesIn
) -> SimpleMeeting:
    m, document = await _get(db, principal, meeting_id, lock=True)
    w = await prd_who(db, document)
    if not _presenter_or_decider(principal, m, w):
        raise MeetingError(403, "Only the presenter, the PRD's decider or an owner edits them")
    if m.status != "ended" or m.minutes_state == "sent":
        raise MeetingError(409, "Minutes are edited after the meeting ends and before sending")
    members = {u.id for u in await _members(db)}
    m.minutes = {
        "summary": body.summary.strip(),
        "open_questions": [q.strip() for q in body.open_questions if q.strip()],
        "action_items": _clean_actions(
            [a.model_dump(mode="json") for a in body.action_items], members, m.ended_by
        ),
        "waits": (m.minutes or {}).get("waits") or await _waits(db, m),
        "written_by": "edited",
    }
    if m.minutes_state == "drafting":
        m.minutes_state = "ready"
    await db.flush()
    return m


async def send(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, body: SimpleSendIn
) -> SimpleMeeting:
    """Send the minutes: always to the Decisions page and each attendee's Inbox; by
    email and to Slack when chosen. Action items are added through the change engine
    (owners apply, others propose). Commits."""
    from oracle.simple import changes
    from oracle.simple.schemas import SimpleChangeIn

    m, document = await _get(db, principal, meeting_id, lock=True)
    w = await prd_who(db, document)
    if not _presenter_or_decider(principal, m, w):
        raise MeetingError(403, "Only the presenter, the PRD's decider or an owner sends them")
    if m.status != "ended":
        raise MeetingError(409, "End the meeting first")
    if m.minutes_state == "sent":
        raise MeetingError(409, "The minutes were sent already")
    slack = await _slack_state(db)
    if body.slack and not (slack.connected and slack.channel):
        raise MeetingError(422, "Slack is not connected" if not slack.connected
                           else "No Slack channel is set in Settings › Notifications")  # fmt: skip
    minutes = dict(m.minutes or await extract(db, m))
    delivery: dict[str, Any] = {"decisions": True, "inbox": True, "email": body.email,
                                "slack": body.slack}  # fmt: skip
    if body.email:
        delivery["email_status"] = "queued" if email_available() else "unavailable"
    if body.slack:
        delivery["slack_channel"] = slack.channel
        delivery["slack_status"] = "queued"
    m.minutes, m.minutes_state, m.sent_at, m.delivery = (
        minutes,
        "sent",
        company_time.now(),
        delivery,
    )
    if body.slack:
        from oracle.slack.models import SlackOutbox

        text = _plain(m, minutes, await _names(db, set(m.attendee_ids)))
        db.add(SlackOutbox(op="ping", link_id=None, recipient_id=_me(principal),
                           payload={"event": "meeting_minutes", "channel_post": True,
                                    "text": text, "channel_text": text}))  # fmt: skip
    await db.flush()
    await audit.record(db, principal, "simple_meeting.sent", "simple_meeting", m.id,
                       data={"email": body.email, "slack": body.slack})  # fmt: skip
    await db.commit()
    # Action items through the change engine (each commits on its own), into a session
    # of the sender's: the meeting's is closed.
    for a in minutes.get("action_items") or []:
        owner = a.get("owner_id") or str(_me(principal))
        try:
            await changes.create(db, principal, SimpleChangeIn(
                op="add_action_item",
                target={"meeting_id": str(m.id), "action_item_id": str(uuid.uuid4())},
                before={},
                after={"title": a["title"], "owner_id": owner, "due_date": a.get("due_date")},
            ))  # fmt: skip
        except changes.ChangeError as e:
            await db.rollback()
            log.warning("meeting %s: action item not added: %s", m.id, e)
    return m


def _plain(m: SimpleMeeting, minutes: dict, names: dict) -> str:
    lines = [f"Minutes: {m.title}", "", minutes.get("summary") or ""]
    if minutes.get("open_questions"):
        lines += ["", "Open questions:", *[f"- {q}" for q in minutes["open_questions"]]]
    if minutes.get("action_items"):
        lines += ["", "Action items:"]
        for a in minutes["action_items"]:
            who = names.get(uuid.UUID(a["owner_id"]), "someone") if a.get("owner_id") else "someone"
            due = f" by {a['due_date']}" if a.get("due_date") else ""
            lines.append(f"- {a['title']} ({who}{due})")
    if minutes.get("waits"):
        lines += ["", "Waiting:"]
        for x in minutes["waits"]:
            on = ", ".join(p.get("name", "someone") for p in x.get("on") or [])
            lines.append(f"- {x['what']}" + (f" (on {on})" if on else ""))
    return "\n".join(lines)


async def deliver_email(db: AsyncSession, meeting_id: uuid.UUID) -> int:
    """Send a meeting's queued minutes email to each attendee through Oracle's mailer;
    records ``sent`` or ``failed`` (the caller commits). Returns how many went."""
    import html as html_mod

    import httpx

    from oracle.members import mailer

    m = await db.get(SimpleMeeting, meeting_id, with_for_update=True)
    if m is None or (m.delivery or {}).get("email_status") != "queued":
        return 0
    sender = mailer.get_mailer()
    if sender is None:
        m.delivery = {**m.delivery, "email_status": "unavailable"}
        return 0
    users = list(await db.scalars(select(User).where(User.id.in_(m.attendee_ids),
                                                     User.disabled_at.is_(None))))  # fmt: skip
    names = {u.id: u.name or u.email for u in users}
    text = _plain(m, m.minutes or {}, names)
    sent, failed = 0, 0
    async with httpx.AsyncClient() as http:
        for u in users:
            msg = mailer.InviteEmail(
                to=u.email, subject=f"Minutes: {m.title}", text=text,
                html=f"<pre style='font-family:inherit'>{html_mod.escape(text)}</pre>",
            )  # fmt: skip
            try:
                await sender.send(http, msg)
                sent += 1
            except Exception as exc:  # noqa: BLE001 - recorded, never raised
                failed += 1
                log.warning("minutes email for meeting %s failed: %s", m.id, type(exc).__name__)
    m.delivery = {**m.delivery, "email_status": "failed" if failed and not sent else "sent",
                  "email_sent": sent}  # fmt: skip
    await db.flush()
    return sent


async def send_queued_emails(db: AsyncSession) -> int:
    """The minute tick: minutes emails still queued (commits)."""
    ids = list(
        await db.scalars(
            select(SimpleMeeting.id).where(
                SimpleMeeting.delivery["email_status"].astext == "queued"
            )
        )
    )
    n = 0
    for i in ids:
        n += await deliver_email(db, i)
        await db.commit()
    return n


# --------------------------------------------------------------------------- inbox


async def inbox_rows(db: AsyncSession, principal: Any, seen: Any) -> list[InboxSimpleMinutes]:
    """Minutes sent to me as an attendee in the last 30 days."""
    me = _me(principal)
    if me is None or getattr(principal, "run_token_id", None) is not None:
        return []
    since = company_time.now() - timedelta(days=INBOX_DAYS)
    ms = list(
        await db.scalars(
            select(SimpleMeeting)
            .where(
                SimpleMeeting.minutes_state == "sent",
                SimpleMeeting.sent_at >= since,
                SimpleMeeting.attendee_ids.contains([me]),
            )
            .order_by(SimpleMeeting.sent_at.desc())
        )
    )
    counts = dict(
        (
            await db.execute(
                select(MeetingDecisionRow.meeting_id, func.count())
                .where(MeetingDecisionRow.meeting_id.in_([m.id for m in ms]))
                .group_by(MeetingDecisionRow.meeting_id)
            )
        ).all()
    ) if ms else {}  # fmt: skip
    return [
        InboxSimpleMinutes(
            meeting_id=m.id,
            title=m.title,
            ended_at=m.ended_at,
            decisions=counts.get(m.id, 0),
            state="new" if seen is None or (m.sent_at and m.sent_at > seen) else "open",
        )  # fmt: skip
        for m in ms
    ]


# --------------------------------------------------------------------------- titles


async def titles_by_session(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Meeting titles by session id (train T's notes: "…, in <meeting title>")."""
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict(
        (
            await db.execute(
                select(SimpleMeeting.session_id, SimpleMeeting.title).where(
                    SimpleMeeting.session_id.in_(ids)
                )
            )
        ).all()
    )


async def decided_in(
    db: AsyncSession, subjects: list[dict]
) -> dict[tuple[str, str, str | None], list[SimpleOpenDecision]]:
    """The decided decisions naming each subject ``(kind, id, ref)``, newest first."""
    out: dict[tuple[str, str, str | None], list[SimpleOpenDecision]] = {}
    if not subjects:
        return out
    wanted = {(s["kind"], s["id"], s.get("ref")) for s in subjects}
    rows = await db.scalars(
        select(Decision)
        .where(Decision.status == "decided")
        .where(or_(*[Decision.subjects.contains([{"kind": k, "id": i}]) for k, i, _ in wanted]))
        .order_by(Decision.number.desc())
    )
    for d in rows:
        for s in d.subjects or []:
            for key in (
                (s.get("kind"), s.get("id"), s.get("ref")),
                (s.get("kind"), s.get("id"), None),
            ):
                if key in wanted:
                    lst = out.setdefault(key, [])  # type: ignore[arg-type]
                    if all(x.id != d.id for x in lst):
                        lst.append(SimpleOpenDecision(id=d.id, number=d.number, title=d.title))
    return out


# --------------------------------------------------------------------------- flows


async def decided_flows(db: AsyncSession, links: list) -> dict[uuid.UUID, SimpleDecidedFlow]:
    """Each meeting decision on a new flow or feature (a change to a draft item): that
    item and its flow from S10 (None until drawn, or without S10's module)."""
    try:
        from oracle.simple import visuals
    except ImportError:
        visuals = None
    change_ids = {c for link, _ in links for c in link.change_ids or []}
    if not change_ids:
        return {}
    item_of = {}
    for c in await db.scalars(select(SimpleChange).where(SimpleChange.id.in_(change_ids))):
        try:
            item_of[c.id] = uuid.UUID(str((c.target or {}).get("item_id")))
        except ValueError:
            continue
    rows = {
        r.id: r
        for r in await db.scalars(
            select(RoadmapItem).where(
                RoadmapItem.id.in_(set(item_of.values())), RoadmapItem.draft.is_(True)
            )
        )
    } if item_of else {}  # fmt: skip
    out: dict[uuid.UUID, SimpleDecidedFlow] = {}
    flows: dict[uuid.UUID, Any] = {}
    for link, d in links:
        row = next((rows[item_of[c]] for c in link.change_ids or []
                    if item_of.get(c) in rows), None)  # fmt: skip
        if row is None:
            continue
        if row.id not in flows:
            flows[row.id] = (
                await visuals.flow_for(db, "draft_item", row.id) if visuals is not None else None
            )
        out[d.id] = SimpleDecidedFlow(kind="draft_item", id=row.id, title=row.title,
                                      flow=flows[row.id])  # fmt: skip
    return out


# --------------------------------------------------------------------------- the page


def _row(d: Decision, names: dict) -> SimpleDecisionRow:
    return SimpleDecisionRow(
        id=d.id, number=d.number, title=d.title, origin=d.origin, status=d.status,
        approver=_ref(d.approver_id, names) if d.approver_id else None,
        decided_at=d.decided_at, created_at=d.created_at, subjects=list(d.subjects or []),
    )  # fmt: skip


async def decisions_page(
    db: AsyncSession,
    principal: Any,
    prd: str | None = None,
    goal: str | None = None,
    meeting: uuid.UUID | None = None,
) -> SimpleDecisionsOut:
    """Direction B "By meeting": each meeting's decisions under it, beside its minutes,
    newest first; then the decisions taken outside meetings. Filters: a PRD (slug or id),
    a goal (key or id), a meeting."""
    from oracle.simple import service

    ms = list(await db.scalars(select(SimpleMeeting).order_by(SimpleMeeting.started_at.desc())))
    docs = {d.id: d for d in await db.scalars(
        select(Document).where(Document.kind == "prd", Document.deleted_at.is_(None)))}  # fmt: skip
    readable = {i for i, d in docs.items() if await _readable(db, principal, d)}
    ms = [m for m in ms if m.prd_document_id in readable]
    await _settle(db, ms)
    read = await service.load(db)
    goals = {e.goal.id: e.goal for e in read.entries if e.goal is not None}
    prd_doc = None
    if prd:
        prd_doc = next((d for d in docs.values() if prd in (str(d.id), d.slug)), None)
        if prd_doc is None or prd_doc.id not in readable:
            raise MeetingError(404, "No such PRD")
    goal_ent = None
    if goal:
        goal_ent = next((g for g in goals.values() if goal in (str(g.id), g.key)), None)
        if goal_ent is None:
            raise MeetingError(404, "No such goal")
    # Subject ids each filter matches.
    match: set[str] | None = None
    if prd_doc is not None or goal_ent is not None:
        entries = [
            e for e in read.entries
            if (prd_doc is None or (e.prd is not None and e.prd.id == prd_doc.id))
            and (goal_ent is None or (e.goal is not None and e.goal.id == goal_ent.id))
        ]  # fmt: skip
        match = {str(e.row.id) for e in entries}
        if prd_doc is not None:
            match.add(str(prd_doc.id))
            all_items, _ = await _prd_items(db, prd_doc)
            if goal_ent is None:
                match |= {str(i) for i in all_items}
        if goal_ent is not None:
            match.add(str(goal_ent.id))

    def keep(d: Decision) -> bool:
        return match is None or any(str(s.get("id")) in match for s in d.subjects or [])

    links = await _decisions(db, [m.id for m in ms])
    in_meetings = {d.id for lst in links.values() for _, d in lst}
    shown_ms = [m for m in ms if meeting is None or m.id == meeting]
    if prd_doc is not None:
        shown_ms = [m for m in shown_ms if m.prd_document_id == prd_doc.id
                    or any(keep(d) for _, d in links[m.id])]  # fmt: skip
    elif match is not None:
        shown_ms = [m for m in shown_ms if any(keep(d) for _, d in links[m.id])]
    others: list[Decision] = []
    if meeting is None:
        q = select(Decision).where(Decision.origin != "meeting")
        if in_meetings:
            q = q.where(Decision.id.not_in(in_meetings))
        if match is not None:
            # The filter before the limit: an older matching decision is not crowded out.
            q = q.where(or_(*[Decision.subjects.contains([{"id": i}]) for i in match]))
        q = q.order_by(Decision.number.desc()).limit(200)
        others = [d for d in await db.scalars(q) if keep(d)]
    names = await _names(db, {d.approver_id for lst in links.values() for _, d in lst}
                         | {d.approver_id for d in others})  # fmt: skip
    flows = await decided_flows(db, [x for m in shown_ms for x in links[m.id]])
    groups = []
    for b, m in zip(await briefs(db, shown_ms), shown_ms, strict=True):
        minutes = SimpleMinutes.model_validate(m.minutes) if m.minutes else None
        # A PRD's own meeting shows all its decisions; otherwise those the filter names.
        whole = prd_doc is not None and goal_ent is None and m.prd_document_id == prd_doc.id
        groups.append(SimpleMeetingGroup(
            meeting=b,
            minutes=await _named(db, minutes) if minutes else None,
            decisions=[_row(d, names).model_copy(update={"flow": flows.get(d.id)})
                       for _, d in links[m.id] if whole or keep(d)],
        ))  # fmt: skip
    return SimpleDecisionsOut(
        meetings=groups,
        other=[_row(d, names) for d in others],
        prds=[SimpleFilterOption(id=d.slug, title=d.title)
              for d in sorted(docs.values(), key=lambda d: d.title) if d.id in readable],
        goals=[SimpleFilterOption(id=g.key, title=g.title)
               for g in sorted(goals.values(), key=lambda g: g.key)],
        meeting_options=[SimpleFilterOption(id=str(m.id), title=m.title) for m in ms],
    )  # fmt: skip


async def _named(db: AsyncSession, minutes: SimpleMinutes) -> SimpleMinutes:
    ids = {a.owner_id for a in minutes.action_items if a.owner_id}
    names = await _names(db, ids)  # type: ignore[arg-type]
    return minutes.model_copy(update={"action_items": [
        SimpleActionItemOut(**a.model_dump(exclude={"owner_name"}),
                            owner_name=names.get(a.owner_id) if a.owner_id else None)
        for a in minutes.action_items
    ]})  # fmt: skip
