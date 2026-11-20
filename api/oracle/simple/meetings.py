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

**Every action is a meeting decision**: each approve, cut, move, accept, decline or undo
made in the meeting is recorded by :func:`record_meeting_decision`: a ``decisions`` row
(origin ``meeting``, subjects the items and lines it changed, approver who decided),
linked to the meeting and the changes (``simple_meeting_decisions``). A comment
(:func:`comment`) is not a decision: it is kept as a note (kind ``comment``), like a
chat-actions note or open question, and stays out of minutes and the Decisions page
(qa-simple-decide-1).

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

import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs.models import Document
from oracle.docs.parser import DraftError as ImportRejected
from oracle.docs.prd_order import sort_prds
from oracle.errors import exception_text
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts, minutes
from oracle.simple.meetings_agenda import (
    FEATURE_MINS,  # noqa: F401
    TOPIC_MINS,  # noqa: F401
    _agenda_apply,  # noqa: F401
    _agenda_features,  # noqa: F401
    _agenda_right,  # noqa: F401
    _agenda_words,  # noqa: F401
    _live,  # noqa: F401
    _row_name,  # noqa: F401
    _rows,  # noqa: F401
    _states,  # noqa: F401
    _trash_removed,  # noqa: F401
    _untrash,  # noqa: F401
    add_note,  # noqa: F401
    remove_note,  # noqa: F401
    restore_agenda,  # noqa: F401
    restore_agenda_item,  # noqa: F401
    set_agenda,  # noqa: F401
)
from oracle.simple.meetings_common import (
    _PENDING,  # noqa: F401
    DEFAULT_LENGTH,  # noqa: F401
    INBOX_DAYS,  # noqa: F401
    MAX_ACTIONS,  # noqa: F401
    MAX_QUESTIONS,  # noqa: F401
    MINUTES_SLOW,  # noqa: F401
    MINUTES_STUCK,  # noqa: F401
    PRODUCT,  # noqa: F401
    RETRY_AFTER_MINUTES,  # noqa: F401
    REVIEWS,  # noqa: F401
    SOURCE_KIND,  # noqa: F401
    SUMMARY_MAX,  # noqa: F401
    TRIES,  # noqa: F401
    UPCOMING_MAX,  # noqa: F401
    MeetingError,  # noqa: F401
    MeetingRules,  # noqa: F401
    PrdWho,  # noqa: F401
    _attendees,  # noqa: F401
    _company_owners,  # noqa: F401
    _current,  # noqa: F401
    _decisions,  # noqa: F401
    _defaults,  # noqa: F401
    _draft_outs,  # noqa: F401
    _due,  # noqa: F401
    _email_status,  # noqa: F401
    _failed_try,  # noqa: F401
    _me,  # noqa: F401
    _members,  # noqa: F401
    _minutes_job,  # noqa: F401
    _note_authors,  # noqa: F401
    _open_decisions,  # noqa: F401
    _prd,  # noqa: F401
    _prd_items,  # noqa: F401
    _presenter_or_decider,  # noqa: F401
    _readable,  # noqa: F401
    _ref,  # noqa: F401
    _rules,  # noqa: F401
    _sees_change,  # noqa: F401
    _subject,  # noqa: F401
    email_available,  # noqa: F401
    ended_by_itself,  # noqa: F401
    may_retry,  # noqa: F401
    may_start,  # noqa: F401
    prd_who,  # noqa: F401
    prd_whos,  # noqa: F401
    rules_for_session,  # noqa: F401
)
from oracle.simple.meetings_decisions import (
    _OPEN_DECISION,  # noqa: F401
    _STEP_WORDS,  # noqa: F401
    _STOP_WORDS,  # noqa: F401
    _approved_words,  # noqa: F401
    _decisions_page,  # noqa: F401
    _meeting_option_title,  # noqa: F401
    _row,  # noqa: F401
    _run_groups,  # noqa: F401
    _run_name,  # noqa: F401
    decided_flows,  # noqa: F401
    decided_in,  # noqa: F401
    decided_refs,  # noqa: F401
    decisions_page,  # noqa: F401
    inbox_rows,  # noqa: F401
    left_out_entry,  # noqa: F401
    titles_by_session,  # noqa: F401
)
from oracle.simple.meetings_start import (
    _occurrence_now,  # noqa: F401
    _reviewed_roadmap,  # noqa: F401
    may_start_ritual,  # noqa: F401
    start,  # noqa: F401
)
from oracle.simple.meetings_words import (
    _RAW,  # noqa: F401
    PROPOSAL_WORDS,  # noqa: F401
    _answer_actions,  # noqa: F401
    _clean_actions,  # noqa: F401
    _days,  # noqa: F401
    _headings,  # noqa: F401
    _plain,  # noqa: F401
    _plain_words,  # noqa: F401
    _section,  # noqa: F401
    _sentence,  # noqa: F401
    _shown_date,  # noqa: F401
    approve_problems,  # noqa: F401
    describe,  # noqa: F401
    published_words,  # noqa: F401
)
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
    SimpleActionItemOut,
    SimpleDelivery,
    SimpleDocRef,
    SimpleEmailDelivery,
    SimpleMeetingBrief,
    SimpleMeetingCan,
    SimpleMeetingDecision,
    SimpleMeetingOut,
    SimpleMeetingRulesIn,
    SimpleMeetingsOut,
    SimpleMinutes,
    SimpleMinutesIn,
    SimplePersonRef,
    SimpleSendIn,
    SimpleSlackState,
    SimpleStartMember,
    SimpleStartOptions,
    SimpleStartPrd,
    SimpleUpcomingMeeting,
)
from oracle.trash import service as trash_service

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- the contract


async def meeting_rules(db: AsyncSession, meeting_id: uuid.UUID) -> MeetingRules | None:
    m = await db.get(SimpleMeeting, meeting_id)
    if m is None:
        return None
    await _settle(db, [m])
    rules = _rules(m)
    if m.status == "ended":
        rules.ended_by_itself = await ended_by_itself(db, m.id)
    return rules


async def record_meeting_decision(
    db: AsyncSession,
    principal: Any,
    meeting_id: uuid.UUID,
    title: str,
    subjects: list[dict],
    change_ids: list[uuid.UUID],
    chosen: str = "decided",
) -> uuid.UUID:
    """One meeting decision: a ``decisions`` row (origin ``meeting``, decided, approver
    the caller), linked to the meeting and the changes it made; ``chosen`` is its one
    option's key. 404 for no such meeting, 409 once it ended. The caller commits."""
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
    # agenda-sheet: an agenda item decided in the meeting reads done.
    decided = [str(s["id"]) for s in clean if s and s.get("kind") == "roadmap_item"]
    if decided:
        done = list(dict.fromkeys([*((m.agenda or {}).get("done") or []), *decided]))
        m.agenda = {**(m.agenda or {}), "done": done}
    nxt = (m.agenda or {}).get("next")
    if nxt and any(s and s.get("kind") == "roadmap_item" and str(s.get("id")) == nxt
                   for s in clean):  # fmt: skip
        # Decided: the item the agenda took next is no longer under discussion.
        m.agenda = {**(m.agenda or {}), "next": None}
    d = await capture.capture(
        db,
        principal,
        origin="meeting",
        source_kind=SOURCE_KIND,
        source_id=uuid.uuid4(),
        title=title,
        options=[{"key": chosen, "label": title}],
        chosen_option=chosen,
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


# --------------------------------------------------------------------------- who


async def _names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    from oracle.simple import drafts

    if not ids:
        return {}
    # roadmap-speed: within one read the members are read once.
    users = (
        await drafts.all_users(db)
        if drafts.reading()
        else await db.scalars(select(User).where(User.id.in_(ids)))
    )
    return {u.id: u.name or u.email for u in users if u.id in ids}


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
        # prd-order: the company PRD order, as every page lists PRDs.
        docs = [
            d
            for d in await sort_prds(
                db,
                await db.scalars(
                    select(Document).where(
                        Document.kind == "prd", Document.deleted_at.is_(None), await _current(db)
                    )
                ),
            )
            if await _readable(db, principal, d)
        ]
    owners = await _company_owners(db)
    members = await _members(db)
    names = {u.id: u.name or u.email for u in members}
    prds = []
    whos = await prd_whos(db, docs)
    for d in docs:
        w = whos[d.id]
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
        members=[
            SimpleStartMember(id=u.id, name=names[u.id], can_change=has_role(u.role, "commenter"))
            for u in members
        ],
        length_min=occ.length_min if occ else DEFAULT_LENGTH,
        occurrence=occ,
    )


async def _get(db: AsyncSession, principal: Any, meeting_id: uuid.UUID, lock: bool = False):
    # A locked read refreshes a row the session holds already, so what the caller changes
    # starts from the row as committed (agenda-sheet: two people's ops at once).
    m = await db.get(SimpleMeeting, meeting_id, with_for_update=lock, populate_existing=lock)
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


async def end_idle(db: AsyncSession) -> int:
    """The idle sweep's second step (oracle.ticker.body, after changes.close_idle): every
    live meeting whose session closed ends with its quick minutes, whether or not anyone
    opens it again (a meeting whose start never answered its presenter included). The
    caller commits; how many ended."""
    ms = list(
        await db.scalars(
            select(SimpleMeeting)
            .join(SimpleSession, SimpleSession.id == SimpleMeeting.session_id)
            .where(SimpleMeeting.status == "live", SimpleSession.closed_at.is_not(None))
            .with_for_update(of=SimpleMeeting)
        )
    )
    await _settle(db, ms)
    return len(ms)


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
    if me not in (m.joined_ids or []):
        m.joined_ids = [*(m.joined_ids or []), me]
    await db.flush()
    await audit.record(db, principal, "simple_meeting.joined", "simple_meeting", m.id)
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
    title, subjects = await describe(db, c, proposal=verb == "Declined")
    if verb in ("Accepted", "Declined") and c.by is not None:
        # qa4-simple-decide-12: an accepted or declined proposal says whose it was.
        who = (await _names(db, {c.by})).get(c.by)
        title = f"{verb} {who}'s proposal: {title}" if who else f"{verb}: {title}"
    elif verb:
        title = f"{verb}: {title}"
    elif c.status == "proposed":
        title = f"Proposed: {title}"
    subjects.append({"kind": "document", "id": str(m.prd_document_id)})
    did = await record_meeting_decision(db, principal, m.id, title, subjects, [change_id])
    await db.commit()
    return did


async def comment(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, text: str, subjects: list[dict]
) -> str:
    """A comment made in the meeting is kept as a note, not a meeting decision
    (qa-simple-decide-1): it does not appear in meeting_decisions, the minutes or the
    Decisions page."""
    m, _ = await _get(db, principal, meeting_id)
    if not _rules(m).may_change(_me(principal)) and _me(principal) not in m.attendee_ids:
        raise MeetingError(403, "Join the meeting to comment in it")
    if m.status == "ended":
        raise MeetingError(409, "This meeting has ended")
    note = {"id": str(uuid.uuid4()), "kind": "comment", "text": " ".join(text.split())[:1000],
            "by": str(_me(principal)), "at": company_time.now().isoformat(),
            "card_id": None}  # fmt: skip
    m.notes = [*(m.notes or []), note]
    await db.flush()
    return note["id"]


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
    # walkc-meeting-r2 review: present is joined and not marked away; one invited who never
    # pressed Join reads "invited, not joined yet" and is asked in the Inbox like an absent one.
    joined = {m.presenter_id, *(m.joined_ids or [])}
    present = [i for i in m.attendee_ids if i in joined and i not in m.absent_ids and i != me]
    # The PRD and every document the meeting drafted, read before the importer can roll
    # the session back: a refused problem names its section by these documents' headings.
    documents = {m.prd_document_id, *await db.scalars(
        select(SimpleDraft.document_id)
        .join(SimpleSessionDraft, SimpleSessionDraft.draft_id == SimpleDraft.id)
        .where(SimpleSessionDraft.session_id == m.session_id)
    )} - {None}  # fmt: skip
    try:
        result = await drafts.approve_in_meeting(db, session, me, present)
    except drafts.DraftError as e:
        raise MeetingError(e.status, e.detail) from e
    except ImportRejected as e:
        # walkc-meeting: never the raw "draft rejected: 38 problem(s)": each problem in
        # plain words, with what to do about it and where; its section by the headings of
        # the document whose draft was refused, when known (two may share a section key).
        refused = getattr(e, "document_id", None)
        headings = await _headings(db, {refused} if refused else documents)
        raise MeetingError(422, approve_problems(e.problems, headings=headings)) from e
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
    # read-speed: every meeting's PRD's decider, reviewers and owners in two reads.
    whos = await prd_whos(db, list(docs.values()))
    out = []
    for m in ms:
        doc = docs[m.prd_document_id]
        w = whos[doc.id]
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


async def one(db: AsyncSession, principal: Any, meeting_id: uuid.UUID,
              not_approved: list | None = None) -> SimpleMeetingOut:  # fmt: skip
    from oracle.simple import changes, meeting_draft, questions

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
            .order_by(SimpleChange.at, SimpleChange.seq)
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
        decisions_due=await questions.due_for(
            db, principal, document.id, m.id, m.session_id if m.status == "live" else None
        ),
        pending_proposals=[await changes.one_out(db, principal, c) for c in seen],
        drafts=await _draft_outs(db, principal, ds),
        waiting_people=[_ref(i, waiting_names) for i in waiting],
        minutes=SimpleMinutes.model_validate(m.minutes) if m.minutes else None,
        minutes_job=job_state,
        delivery=await delivery_out(db, m),
        slack=await _slack_state(db),
        email_available=email_available(),
        can=SimpleMeetingCan(
            change=rules.may_change(me) and has_role(principal.role, "commenter"),
            # qa-simple-decide-14: a viewer is shown no control it cannot use (the routes
            # need a commenter).
            set_rules=m.status == "live"
            and me == m.presenter_id
            and has_role(principal.role, "commenter"),
            approve=m.status == "live" and decider_or_owner,
            end=_presenter_or_decider(principal, m, w)
            and m.minutes_state != "sent"
            and has_role(principal.role, "commenter"),
            redraft=job_state == "failed" and _presenter_or_decider(principal, m, w),
            retry_delivery=m.minutes_state == "sent" and may_retry(principal, m),
            edit_agenda=m.status == "live" and _agenda_right(principal, w) == "save",
            propose_agenda=m.status == "live" and _agenda_right(principal, w) == "propose",
        ),
        not_approved=not_approved or [],
        notes=await _notes_out(db, m),
        agenda=await _agenda_out(db, m, document.id, w.decider),
        draft_roadmap=await meeting_draft.draft_out(db, document, m.id),
    )


# --------------------------------------------------------------------------- chat-actions


async def edit_agenda(db: AsyncSession, principal: Any, meeting_id: uuid.UUID,
                      body: dict) -> None:  # fmt: skip
    """agenda-sheet: one op of the Agenda sheet (add, rename, move, remove, undo; accept
    or withdraw an approver's proposal). The meeting row is locked before it is read, so
    two people's ops at once both land. The caller commits."""
    m, document = await _get(db, principal, meeting_id, lock=True)
    if m.status == "ended":
        raise MeetingError(409, "This meeting has ended")
    w = await prd_who(db, document)
    right = _agenda_right(principal, w)
    if right == "read" or not has_role(principal.role, "commenter"):
        raise MeetingError(403, "Only an owner or the PRD's decider changes the agenda")
    me = _me(principal)
    a = dict(m.agenda or {})
    features = await _agenda_features(db, document.id)
    titles = {str(r.id): r.title for r in features}
    rows = _rows(m, features)
    op = body["op"]
    prop = a.get("proposal")
    if op == "withdraw":
        if not prop or (prop["by"] != str(me) and right != "save"):
            raise MeetingError(404, "No proposal to withdraw")
        a["proposal"] = None
    elif op == "accept":
        if right != "save" or not prop:
            raise MeetingError(403 if prop else 404, "Only the decider accepts the proposal")
        # The accept is the decider's batch: their sheet named it, so their Undo line shows.
        batch = body.get("batch") or f"accept-{uuid.uuid4()}"
        a.update(before=[dict(x) for x in rows], batch=batch)
        # An op whose item is gone since is left out, and the decider is told which.
        clauses, gone, said = [], [], prop.get("said") or []
        for k, o in enumerate(prop.get("ops") or []):
            try:
                clauses.append(_agenda_apply(a, rows, titles, uuid.UUID(prop["by"]), o))
            except MeetingError:
                gone.extend(said[k : k + 1])
        a.update(items=rows, clauses=clauses, words=_agenda_words(clauses), proposal=None,
                 left_out=_agenda_words(gone))  # fmt: skip
        a["trashed"] = await _trash_removed(db, principal, m, clauses)
    elif op == "undo":
        if right != "save" or "before" not in a:
            raise MeetingError(404, "Nothing to undo")
        if body.get("batch") != a.get("batch"):
            raise MeetingError(409, "Someone changed the agenda since")
        a.update(items=a.pop("before"), clauses=[], words=[], left_out=[], batch=None)
        # port-an-decisions: what the batch removed comes back, so it leaves Trash.
        await _untrash(db, a.pop("trashed", None) or [])
    elif right == "propose":
        # The agenda stays as it is; the ops wait for the decider. An op of the earlier
        # proposal whose item is gone since is dropped, and the proposal says so (its clauses
        # read together, so a move and a rename of one item read as one).
        mine = prop if prop and prop.get("by") == str(me) else None
        ops, said = list((mine or {}).get("ops") or []), list((mine or {}).get("said") or [])
        trial = [dict(x) for x in _rows(m, features)]
        kept, clauses, gone = [], [], list((mine or {}).get("gone") or [])
        for k, o in enumerate(ops):
            try:
                clauses.append(_agenda_apply(a, trial, titles, me, o))  # type: ignore[arg-type]
                kept.append(o)
            except MeetingError:
                gone.extend(said[k : k + 1])
        clauses.append(_agenda_apply(a, trial, titles, me, body))  # type: ignore[arg-type]
        a["proposal"] = {"by": str(me), "decider": str(w.decider) if w.decider else None,
                         "ops": [*kept, {k: v for k, v in body.items() if v is not None}],
                         "said": clauses, "words": _agenda_words(clauses),
                         "gone": gone, "dropped": _agenda_words(gone)}  # fmt: skip
    else:
        if a.get("batch") != body.get("batch") or "before" not in a:
            a.update(before=[dict(x) for x in rows], batch=body.get("batch"), clauses=[],
                     left_out=[], trashed=[])  # fmt: skip
        clause = _agenda_apply(a, rows, titles, me, body)  # type: ignore[arg-type]
        clauses = [*(a.get("clauses") or []), clause]
        a.update(items=rows, clauses=clauses, words=_agenda_words(clauses))
        a["trashed"] = [*(a.get("trashed") or []),
                        *await _trash_removed(db, principal, m, [clause])]  # fmt: skip
    m.agenda = json.loads(json.dumps(a, default=str))
    await db.flush()


async def _notes_out(
    db: AsyncSession, m: SimpleMeeting, names: dict[uuid.UUID, str] | None = None
) -> list:
    """The meeting's notes, each with its author's name; a page of meetings passes the
    names it read once for all of them (``_note_authors``)."""
    from oracle.simple.schemas import SimpleMeetingNote

    notes = list(m.notes or [])
    if names is None:
        names = await _names(db, _note_authors([m]))
    return [
        SimpleMeetingNote(
            id=n["id"],
            kind=n["kind"],
            text=n["text"],
            by_name=names.get(uuid.UUID(n["by"]), "someone") if n.get("by") else "someone",
            at=n.get("at"),
            card_id=n.get("card_id"),
        )  # fmt: skip
        for n in notes
    ]


async def _agenda_out(
    db: AsyncSession, m: SimpleMeeting, document_id: uuid.UUID, decider: uuid.UUID | None
) -> Any:
    from oracle.simple.schemas import (
        SimpleAgenda,
        SimpleAgendaItem,
        SimpleAgendaProposal,
        SimpleAgendaRow,
    )

    a = m.agenda or {}
    features = await _agenda_features(db, document_id)
    ids = [i for i in [a.get("next"), *(a.get("skipped") or [])] if i]
    rows = {
        str(r.id): r
        for r in await db.scalars(select(RoadmapItem).where(RoadmapItem.id.in_(ids)))
    } if ids else {}  # fmt: skip
    titles = {str(r.id): r.title for r in features} | {k: r.title for k, r in rows.items()}

    def item(i: str | None) -> Any:
        r = rows.get(i) if i else None
        return SimpleAgendaItem(id=r.id, title=r.title) if r is not None else None

    stored = _rows(m, features)
    prop = a.get("proposal")
    people = {uuid.UUID(x["by"]) for x in stored if x.get("by")} | ({decider} if decider else set())
    if prop:
        people |= {uuid.UUID(i) for i in (prop["by"], prop.get("decider")) if i}
    names = await _names(db, people)
    on = {x.get("feature_id") for x in stored}
    return SimpleAgenda(
        next=item(a.get("next")),
        skipped=[x for x in map(item, a.get("skipped") or []) if x],
        items=[
            SimpleAgendaRow(
                id=x["id"],
                kind="feature" if x.get("feature_id") else "topic",
                feature_id=x.get("feature_id"),
                title=_row_name(x, titles, "Untitled"),
                mins=x.get("mins") or FEATURE_MINS,
                by_name=names.get(uuid.UUID(x["by"])) if x.get("by") else None,
                state=st,  # type: ignore[arg-type]
            )
            for x, st in zip(stored, _states(a, stored), strict=True)
        ],
        addable=[SimpleAgendaItem(id=r.id, title=r.title) for r in features if str(r.id) not in on],
        batch=a.get("batch"),
        words=list(a.get("words") or []),
        left_out=list(a.get("left_out") or []),
        in_trash=bool(a.get("trashed")),
        proposal=SimpleAgendaProposal(
            by=_ref(uuid.UUID(prop["by"]), names),
            decider=_ref(uuid.UUID(prop["decider"]), names) if prop.get("decider") else None,
            words=list(prop.get("words") or []),
            dropped=list(prop.get("dropped") or []),
        )
        if prop
        else None,  # fmt: skip
        decider=_ref(decider, names) if decider else None,
    )


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
        # Not one whose review was held (a meeting started from it has ended): the ritual's
        # following occurrence is the next one.
        held_here = select(SimpleMeeting.occurrence_id).where(
            SimpleMeeting.occurrence_id.is_not(None), SimpleMeeting.status == "ended"
        )
        q = q.where(
            RitualOccurrence.status.in_(("scheduled", "ready")),
            RitualOccurrence.ends_at >= now,
            RitualOccurrence.id.not_in(held_here),
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
    # occurrences), until the ritual's attendees are edited after that review: then its list
    # is. Not ``updated_at``: the scheduler bumps it whenever it moves ``next_due_at``.
    held: dict[uuid.UUID, list[uuid.UUID]] = {}
    edited = {r.id: r.attendees_edited_at for _, r in rows}
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
    # A ritual whose documents are all in Trash reviews nothing live (Home says so).
    trashed: dict[str, bool] = {}
    for kind in {REVIEWS[r.kind] for _, r in rows if r.kind in REVIEWS}:
        trashed[kind] = await trash_service.only_in_trash(db, kind)
    # home-deleted-roadmap: and one whose documents were all deleted for good says that.
    deleted: dict[str, datetime | None] = {}
    for kind in {REVIEWS[r.kind] for _, r in rows if r.kind in REVIEWS}:
        deleted[kind] = await trash_service.deleted_for_good(db, kind)
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
            reviews_in_trash=REVIEWS[r.kind] if trashed.get(REVIEWS.get(r.kind, "")) else None,
            reviews_deleted=REVIEWS[r.kind] if deleted.get(REVIEWS.get(r.kind, "")) else None,
            reviews_deleted_at=deleted.get(REVIEWS.get(r.kind, "")),
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
            select(SimpleChange)
            .where(SimpleChange.session_id == m.session_id, SimpleChange.status == "proposed")
            .order_by(SimpleChange.at, SimpleChange.seq)
        )
    )
    # walkc-meeting r2 (5j): a working draft waits on whoever approves the meeting's drafts
    # (the PRD's decider, else the company's owners), and a proposal routed to nobody on them too.
    approvers: list[uuid.UUID] = []
    if any(d.status == "working" for d in ds) or any(not c.routed_to for c in proposals):
        prd = await db.get(Document, m.prd_document_id)
        decider = (await prd_who(db, prd)).decider if prd is not None else None
        approvers = [decider] if decider else await _company_owners(db)
    names = await _names(
        db, {i for d in ds for i in d.waiting_on or []}
        | {i for c in proposals for i in c.routed_to or []} | set(approvers),
    )  # fmt: skip

    def on(ids: list[uuid.UUID]) -> list[dict]:
        return [{"id": str(i), "name": names.get(i, "someone")} for i in ids]

    for d in ds:
        title = docs[d.document_id].title if d.document_id in docs else "a document"
        if d.status == "submitted" and d.waiting_on:
            out.append({"what": f"Publishing {title}: their approval", "on": on(d.waiting_on)})
        elif d.status == "working":
            out.append({"what": f"{title}: the working draft is not approved yet",
                        "on": on(approvers)})  # fmt: skip
    for c in proposals:
        title, _ = await describe(db, c)
        out.append({"what": f"Proposal: {title}", "on": on(list(c.routed_to or []) or approvers)})
    return out


async def extract(db: AsyncSession, m: SimpleMeeting) -> dict[str, Any]:
    """Oracle's quick draft of the minutes, shown at once: only the meeting's own record
    (oracle.simple.minutes): its decisions, the chat's questions and its action items."""
    links = (await _decisions(db, [m.id]))[m.id]
    titles = [d.title for _, d in reversed(links)]
    waits = await _waits(db, m)
    rec = await minutes.record(db, m, [d for _, d in reversed(links)], waits)
    if titles:
        # qa-simple-decide-6: a short prose count, not the decisions' titles (the
        # Decisions page already lists them) nor the notes' text.
        n_notes = len([n for n in m.notes or [] if n.get("kind") == "note" and n.get("text")])
        summary = minutes.summary_sentence(len(titles), n_notes, len(rec.questions()))
    elif rec.empty:
        summary = minutes.nothing(m.title)
    else:
        summary = f"{m.title}: no decision was taken."
    actions = [minutes.recorded(a) for a in rec.actions]
    return {
        "summary": summary[:SUMMARY_MAX],
        "open_questions": rec.questions()[:MAX_QUESTIONS],
        "action_items": actions[:MAX_ACTIONS],
        "waits": waits,
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
    if m.occurrence_id is not None:
        # The ritual's occurrence is held: Upcoming and Home's next review move to its next.
        from oracle.rituals.models import RitualOccurrence

        occ = await db.get(RitualOccurrence, m.occurrence_id, with_for_update=True)
        if occ is not None and occ.status in ("scheduled", "ready", "missed"):
            occ.status, occ.held_by, occ.held_at = "held", _me(principal), now
            await audit.record(db, principal, "ritual.held", "ritual_occurrence", occ.id)
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


async def run_job(s: AsyncSession, job, ask) -> dict[str, Any]:
    """The ``meeting_minutes`` job: one call with the meeting's decisions, open items and
    waits; the answer replaces Oracle's quick draft unless a person edited or sent them."""
    from oracle.jobs.kinds import JobInputError

    try:
        meeting_id = uuid.UUID(str((job.input or {}).get("meeting_id")))
    except ValueError as e:
        raise JobInputError("the job names no meeting") from e
    # walkc-meeting: the meeting's row is not held across the model's call (up to 180 s):
    # Save, Send and Draft again lock it; it is locked again to write the answer.
    m = await s.get(SimpleMeeting, meeting_id)
    if m is None:
        raise JobInputError("the meeting no longer exists")
    document = await s.get(Document, m.prd_document_id)
    links = (await _decisions(s, [m.id]))[m.id]
    names = await _names(s, set(m.attendee_ids) | {d.approver_id for _, d in links})
    waits = await _waits(s, m)
    rec = await minutes.record(s, m, [d for _, d in reversed(links)], waits)
    if rec.empty:
        # Nothing was said, decided or assigned: nothing to ask a model about.
        if (m.minutes or {}).get("written_by") == "edited" or m.minutes_state == "sent":
            return {"written": False, "reason": "a person edited or sent the minutes first"}
        m.minutes = {"summary": minutes.nothing(m.title), "open_questions": [],
                     "action_items": [], "waits": waits, "written_by": "oracle"}  # fmt: skip
        m.minutes_state = "ready"
        await s.flush()
        return {"written": True, "empty": True}
    payload = {
        "title": m.title,
        "prd": document.title if document else "",
        "attendees": [{"id": str(i), "name": names.get(i, "someone")} for i in m.attendee_ids],
        "decisions": [
            {"title": d.title, "by": names.get(d.approver_id, "someone")}
            for _, d in reversed(links)
        ],  # fmt: skip
        "chat": [
            {"by": names.get(c.by, "someone") if c.by else "someone", "text": c.text}
            for c in rec.chat
        ],  # fmt: skip
        "notes": rec.notes,
        "action_items": [
            {"title": a["title"], "owner_id": str(a["owner_id"]), "due_date": a["due_date"]}
            for a in rec.actions
        ],
        "pending": [w["what"] for w in waits],
        "waits": [{"what": w["what"], "on": [p["name"] for p in w["on"]]} for w in waits],
    }
    answer = await ask("meeting_minutes", payload)
    m = await s.get(SimpleMeeting, meeting_id, with_for_update=True, populate_existing=True)
    if m is None:
        raise JobInputError("the meeting no longer exists")
    if m.minutes_job_id not in (None, job.id):
        return {"written": False, "reason": "Draft again queued a newer job"}
    if (m.minutes or {}).get("written_by") == "edited" or m.minutes_state == "sent":
        return {"written": False, "reason": "a person edited or sent the minutes first"}
    summary = " ".join(str(answer.get("summary") or "").split())[:SUMMARY_MAX]
    if not summary:
        m.minutes_state = "ready"
        return {"written": False, "reason": "the answer had no summary"}
    questions = [" ".join(str(q).split())[:300] for q in answer.get("open_questions") or []
                 if str(q).strip()]  # fmt: skip
    # The output check: only what the meeting's record supports (the rest is logged).
    questions, actions = minutes.check(
        m.id, rec, questions, _answer_actions(answer.get("action_items")),
        set(m.attendee_ids), names,
    )  # fmt: skip
    m.minutes = {
        "summary": summary,
        "open_questions": questions[:MAX_QUESTIONS],
        "action_items": actions[:MAX_ACTIONS],
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
    if job is not None and job.status not in ("failed", "cancelled"):
        # walkc-meeting: a stuck job (queued or running past MINUTES_STUCK) is cancelled and
        # a new one queued, so the stalled one can never write over it.
        job.status = "cancelled"
        job.error = "Stalled: Draft again queued a new one"
        job = None
    try:
        if job is not None:
            job = await jobs.retry(db, principal, job.id)
        else:
            job = await jobs.enqueue(
                db, document, "meeting_minutes", input={"meeting_id": str(m.id)},
                principal=principal,
            )  # fmt: skip
    except jobs.JobError as e:
        raise MeetingError(e.status, exception_text(e)) from e
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
    await audit.record(db, principal, "simple_meeting.minutes_edited", "simple_meeting", m.id)
    return m


async def send(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, body: SimpleSendIn
) -> SimpleMeeting:
    """Send the minutes: always to the Decisions page and each attendee's Inbox; by
    email and to Slack when chosen. Action items are added through the change engine
    (owners apply, others propose). Commits."""
    from oracle.simple import changes
    from oracle.simple import minutes as minutes_mod
    from oracle.simple.models import SimpleActionItem
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
    now = company_time.now().isoformat()
    if body.email:
        delivery["email_status"] = "queued" if email_available() else "unavailable"
        if delivery["email_status"] == "queued":
            delivery["email_to"] = {str(i): {"status": "queued", "tries": 0, "next_at": now}
                                    for i in m.attendee_ids}  # fmt: skip
    if body.slack:
        delivery["slack_channel"] = slack.channel
        delivery["slack_status"] = "queued"
        delivery["slack_tries"], delivery["slack_next_at"] = 0, now
    m.minutes, m.minutes_state, m.sent_at, m.delivery = (
        minutes,
        "sent",
        company_time.now(),
        delivery,
    )
    await db.flush()
    await audit.record(db, principal, "simple_meeting.sent", "simple_meeting", m.id,
                       data={"email": body.email, "slack": body.slack})  # fmt: skip
    await db.commit()
    # Action items through the change engine (each commits on its own), into a session
    # of the sender's: the meeting's is closed. One recorded in the meeting has its row
    # already: by its id, or by its title when a person's edit dropped the id (the review).
    have = list(
        await db.execute(
            select(SimpleActionItem.id, SimpleActionItem.title).where(
                SimpleActionItem.meeting_id == m.id
            )
        )
    )
    ids = {str(i) for i, _ in have}
    titles = {frozenset(minutes_mod.words(t)) for _, t in have}
    for a in minutes.get("action_items") or []:
        same = frozenset(minutes_mod.words(a["title"]))
        if str(a.get("action_item_id") or "") in ids or same in titles:
            continue
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


async def _post_slack(db: AsyncSession, text: str) -> None:
    """Post the minutes to the Notifications channel; raises when it did not go."""
    from oracle.integrations import slack_oauth
    from oracle.slack import api as slack_api
    from oracle.slack.pings import _notify_channel

    row = await slack_oauth.installed(db)
    channel = await _notify_channel(db)
    if row is None or row.status != "active" or channel is None:
        raise LookupError("slack_unavailable")
    async with slack_api.http_client() as http:
        await slack_api.call(http, "chat.postMessage", token=slack_oauth.token_of(row),
                             json={"channel": channel, "text": text[:3000], "mrkdwn": True,
                                   "unfurl_links": False})  # fmt: skip


async def deliver(db: AsyncSession, meeting_id: uuid.UUID) -> int:
    """Try a sent meeting's due emails and Slack post once each; records each status (the
    caller commits). The meeting is locked only to claim what is due (commits) and to record
    how it went, never through a send. Returns how many emails went."""
    import html as html_mod

    import httpx

    from oracle.members import mailer

    m = await db.get(SimpleMeeting, meeting_id, with_for_update=True)
    if m is None or not m.delivery:
        return 0
    d = dict(m.delivery)
    now = company_time.now()
    if d.get("slack_status") in _PENDING and "slack_tries" not in d:
        d["slack_status"] = "sent"  # queued before the post carried its tries: the outbox posted it
    due: list[str] = []
    users: dict[str, User] = {}
    sender = None
    if d.get("email_status") in _PENDING:
        to = {k: dict(v) for k, v in (d.get("email_to") or {}).items()}
        if not to:  # queued before each attendee carried a status
            to = {str(i): {"status": "queued", "tries": 0} for i in m.attendee_ids}
        live = select(User).where(User.id.in_(m.attendee_ids), User.disabled_at.is_(None))
        users = {str(u.id): u for u in await db.scalars(live)}
        to = {k: v for k, v in to.items() if k in users}
        due = [k for k, v in to.items() if _due(v, now)]
        sender = mailer.get_mailer() if due else None
        if due and sender is None:
            d["email_status"], due = "unavailable", []
        else:
            d["email_to"] = to
            d["email_status"] = _email_status(to) if to else "sent"
            d["email_sent"] = sum(1 for v in to.values() if v["status"] == "sent")
    slack = {"status": d.get("slack_status"), "tries": d.get("slack_tries"),
             "next_at": d.get("slack_next_at")}  # fmt: skip
    post = bool(d.get("slack")) and _due(slack, now)
    if not due and not post:
        m.delivery = d
        await db.flush()
        return 0
    # Claim what is due (a second deliver leaves it alone until the lease ends; a crash
    # mid-send tries it again then), then send with the meeting unlocked.
    names = {u.id: u.name or u.email for u in users.values()} if due else await _names(
        db, set(m.attendee_ids))  # fmt: skip
    text = _plain(m, m.minutes or {}, names, await company_time.company_time_zone(db))
    subject = f"Minutes: {m.title}"
    lease = (now + timedelta(minutes=RETRY_AFTER_MINUTES[0])).isoformat()
    tried = {k: dict(d["email_to"][k]) for k in due}
    for k in due:
        d["email_to"][k]["next_at"] = lease
    if post:
        d["slack_next_at"] = lease
    m.delivery = d
    await db.commit()
    done: dict[str, dict] = {}
    if due:
        async with httpx.AsyncClient() as http:
            for k in due:
                msg = mailer.InviteEmail(
                    to=users[k].email, subject=subject, text=text,
                    html=f"<pre style='font-family:inherit'>{html_mod.escape(text)}</pre>",
                )  # fmt: skip
                try:
                    await sender.send(http, msg)
                except Exception as exc:  # noqa: BLE001 - recorded, never raised
                    done[k] = _failed_try(tried[k], now)
                    log.warning("minutes email for meeting %s failed: %s", meeting_id,
                                type(exc).__name__)  # fmt: skip
                else:
                    done[k] = {"status": "sent", "tries": int(tried[k].get("tries") or 0) + 1}
    if post:
        try:
            await _post_slack(db, text)
        except Exception as exc:  # noqa: BLE001 - recorded, never raised
            slack = _failed_try(slack, now)
            log.warning("minutes Slack post for meeting %s failed: %s", meeting_id,
                        type(exc).__name__)  # fmt: skip
        else:
            slack = {"status": "sent", "tries": int(slack.get("tries") or 0) + 1, "next_at": None}
    m = await db.get(SimpleMeeting, meeting_id, with_for_update=True, populate_existing=True)
    if m is None or not m.delivery:
        return 0
    d = dict(m.delivery)
    if done:
        to = {k: dict(v) for k, v in (d.get("email_to") or {}).items()}
        to.update({k: v for k, v in done.items() if k in to})
        d["email_to"] = to
        d["email_status"] = _email_status(to) if to else "sent"
        d["email_sent"] = sum(1 for v in to.values() if v["status"] == "sent")
    if post:
        d["slack_status"], d["slack_tries"], d["slack_next_at"] = (
            slack["status"], slack["tries"], slack["next_at"])  # fmt: skip
    m.delivery = d
    await db.flush()
    return sum(1 for v in done.values() if v["status"] == "sent")


async def deliver_email(db: AsyncSession, meeting_id: uuid.UUID) -> int:
    """The first try right after Send (the route's background task): see :func:`deliver`."""
    return await deliver(db, meeting_id)


async def deliver_due(db: AsyncSession) -> int:
    """The minute tick: each sent meeting with an email or a Slack post still to try
    (commits). Returns how many emails went."""
    pending = list(_PENDING)
    ids = list(
        await db.scalars(
            select(SimpleMeeting.id).where(or_(
                SimpleMeeting.delivery["email_status"].astext.in_(pending),
                SimpleMeeting.delivery["slack_status"].astext.in_(pending),
            ))
        )
    )  # fmt: skip
    n = 0
    for i in ids:
        n += await deliver(db, i)
        await db.commit()
    return n


async def retry_delivery(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, what: str
) -> SimpleMeeting:
    """Retry: requeue what failed (each failed attendee's email, or the Slack post) for the
    tick, with three tries again. Commits."""
    m, _document = await _get(db, principal, meeting_id, lock=True)
    if not may_retry(principal, m):
        raise MeetingError(403, "Only whoever ended the meeting or an owner retries it")
    d = dict(m.delivery or {})
    now = company_time.now().isoformat()
    fresh = {"status": "queued", "tries": 0, "next_at": now}
    if what == "email":
        to = {k: dict(v) for k, v in (d.get("email_to") or {}).items()}
        failed = [k for k, v in to.items() if v.get("status") == "failed"]
        if d.get("email_status") != "failed" or not failed:
            raise MeetingError(409, "No email is left to retry")
        to.update({k: dict(fresh) for k in failed})
        d["email_to"], d["email_status"] = to, _email_status(to)
    else:
        if d.get("slack_status") != "failed":
            raise MeetingError(409, "The Slack post is not left to retry")
        d["slack_status"], d["slack_tries"], d["slack_next_at"] = "queued", 0, now
    m.delivery = d
    await db.flush()
    await audit.record(db, principal, "simple_meeting.delivery_retried", "simple_meeting", m.id,
                       data={"what": what})  # fmt: skip
    await db.commit()
    return m


async def delivery_out(db: AsyncSession, m: SimpleMeeting) -> SimpleDelivery | None:
    """The meeting's delivery for people: each attendee's email named, with its status."""
    if not m.delivery:
        return None
    d = m.delivery
    to = d.get("email_to") or {}
    names = await _names(db, {uuid.UUID(k) for k in to})
    emails = [
        SimpleEmailDelivery(person=_ref(uuid.UUID(k), names), status=v["status"])
        for k, v in to.items()
        if uuid.UUID(k) in names
    ]
    return SimpleDelivery.model_validate(
        {
            **d,
            "emails": [e.model_dump() for e in emails],
            # Stored before each attendee carried a status: the count it kept.
            "email_sent": sum(1 for e in emails if e.status == "sent")
            if to
            else int(d.get("email_sent") or 0),
        }  # fmt: skip
    )


async def _named(db: AsyncSession, minutes: SimpleMinutes) -> SimpleMinutes:
    ids = {a.owner_id for a in minutes.action_items if a.owner_id}
    names = await _names(db, ids)  # type: ignore[arg-type]
    return minutes.model_copy(update={"action_items": [
        SimpleActionItemOut(**a.model_dump(exclude={"owner_name"}),
                            owner_name=names.get(a.owner_id) if a.owner_id else None)
        for a in minutes.action_items
    ]})  # fmt: skip
