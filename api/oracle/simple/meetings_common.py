"""Simple meetings: the contract, who is who and the reads the meeting modules share."""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import User
from oracle.authz import has_role
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.models import AuditEvent
from oracle.roadmap.models import ProductTrack, RoadmapItem, TrackPrd
from oracle.simple import drafts
from oracle.simple.models import SimpleChange, SimpleMeeting
from oracle.simple.models import SimpleMeetingDecision as MeetingDecisionRow
from oracle.simple.schemas import SimpleAttendee, SimpleOpenDecision, SimplePersonRef

SOURCE_KIND = "simple_meeting_decision"
DEFAULT_LENGTH = 60
INBOX_DAYS = 30
UPCOMING_MAX = 20
# A minutes job still drafting after this long: "still drafting", send what is written.
MINUTES_SLOW = timedelta(minutes=2)
# walkc-meeting: past this a queued or running minutes job is taken as failed (its call
# times out at 180 s; the walk waited 13-15 minutes).
MINUTES_STUCK = timedelta(minutes=6)
SUMMARY_MAX = 4000
MAX_QUESTIONS = 5
MAX_ACTIONS = 8


class MeetingError(Exception):
    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(detail if isinstance(detail, str) else detail.get("message"))
        self.status = status
        self.detail = detail


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
    # meet-chat-right-prd: the meeting's PRD (its chat reads only it), and how it ended:
    # who ended it, or by itself (its session idle past MEETING_IDLE), and when.
    prd_document_id: uuid.UUID | None = None
    ended_at: datetime | None = None
    ended_by: uuid.UUID | None = None
    ended_by_itself: bool = False

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
        prd_document_id=m.prd_document_id,
        ended_at=m.ended_at,
        ended_by=m.ended_by,
    )


async def ended_by_itself(db: AsyncSession, meeting_id: uuid.UUID) -> bool:
    """Whether the meeting ended by itself (_settle: its time ran out), not by a person."""
    return (
        await db.scalar(
            select(AuditEvent.id)
            .where(
                AuditEvent.action == "simple_meeting.ended_idle", AuditEvent.entity_id == meeting_id
            )
            .limit(1)
        )  # fmt: skip
    ) is not None


async def rules_for_session(db: AsyncSession, session_id: uuid.UUID) -> MeetingRules | None:
    m = await db.scalar(select(SimpleMeeting).where(SimpleMeeting.session_id == session_id))
    return _rules(m) if m is not None else None


def _subject(s: dict) -> dict | None:
    try:
        sid = str(uuid.UUID(str(s.get("id"))))
    except (TypeError, ValueError):
        return None
    out: dict[str, Any] = {"kind": str(s.get("kind") or "document")[:40], "id": sid}
    if s.get("ref"):
        out["ref"] = str(s["ref"])[:300]
    return out


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


async def prd_whos(db: AsyncSession, documents: list[Document]) -> dict[uuid.UUID, PrdWho]:
    """:func:`prd_who` of many PRDs in two reads (the start sheet lists every PRD)."""
    from oracle.review.models import DocumentReviewPolicy

    ids = [d.id for d in documents]
    if not ids:
        return {}
    policies = {
        p.document_id: p
        for p in await db.scalars(
            select(DocumentReviewPolicy).where(DocumentReviewPolicy.document_id.in_(ids))
        )
    }
    owners: dict[uuid.UUID, dict[uuid.UUID, str]] = {i: {} for i in ids}
    rows = await db.execute(
        select(User.id, User.role, TrackPrd.prd_document_id)
        .join(ProductTrack, ProductTrack.owner_id == User.id)
        .join(TrackPrd, TrackPrd.track_id == ProductTrack.id)
        .where(
            TrackPrd.prd_document_id.in_(ids),
            TrackPrd.state == "linked",
            User.disabled_at.is_(None),
        )
    )
    for uid, role, prd_id in rows:
        owners[prd_id].setdefault(uid, role)
    out = {}
    for i in ids:
        p = policies.get(i)
        out[i] = PrdWho(
            p.decider_id if p else None,
            list(p.mandatory_reviewer_ids or []) if p else [],
            list(owners[i]),
        )
    return out


def may_start(principal: Any, w: PrdWho) -> bool:
    """Only owners and the document's decider start a meeting (the owner's pick)."""
    me = _me(principal)
    # qa-simple-decide-14: a viewer starts nothing, even as the named decider.
    return me is not None and (
        has_role(principal.role, "owner")
        or (me == w.decider and has_role(principal.role, "commenter"))
    )


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
        # simple-replaced-prds: a replaced PRD is not reviewed in Simple (404 naming its
        # replacements); its past meetings stay as history.
        document = await one_pager._document(db, principal, ref, current=True)
    except ChangeError as e:
        raise MeetingError(e.status, e.detail) from e
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


async def _current(db: AsyncSession) -> Any:
    """Not a PRD a live PRD replaces (simple-replaced-prds, company.History): Simple offers
    only the PRDs that replaced it; the replaced one is history, read in Detailed."""
    from oracle.roadmap import company

    return Document.id.not_in(await company.replaced_prd_ids(db))


def _presenter_or_decider(principal: Any, m: SimpleMeeting, w: PrdWho) -> bool:
    me = _me(principal)
    return me is not None and (
        me in (m.presenter_id, w.decider) or has_role(principal.role, "owner")
    )


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
                                  present=i not in m.absent_ids,
                                  joined=i in [m.presenter_id, *(m.joined_ids or [])]))  # fmt: skip
    return out


def email_available() -> bool:
    from oracle.members import mailer

    return mailer.get_mailer() is not None


# The walk (M1): Simple reads product decisions only: a run's stop (a checkpoint decision,
# Oracle's run approval) is Detailed's, never a meeting's pre-read or the Decisions page's.
PRODUCT = Decision.origin != "checkpoint"


async def _open_decisions(db: AsyncSession, document: Document, item_ids: set[uuid.UUID]):
    """The PRD's open product decisions, never a run's approval (PRODUCT) nor a PRD's own
    question (the agenda's "On the agenda" lists those)."""
    rows = await db.scalars(
        select(Decision)
        .where(Decision.status == "proposed", PRODUCT, Decision.origin != "prd")
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
    """The PRD's roadmap items (ids of every version) and the roadmaps they are on.

    meet-draft-items: an item on a run's draft roadmap has no roadmap document; it counts
    as the PRD's item but adds no roadmap."""
    rows = (
        await db.execute(
            select(RoadmapItem.id, RoadmapItem.roadmap_document_id).where(
                RoadmapItem.prd_document_id == document.id
            )
        )
    ).all()
    return {r[0] for r in rows}, {r[1] for r in rows if r[1] is not None}


def _note_authors(ms: list[SimpleMeeting]) -> set[uuid.UUID]:
    return {uuid.UUID(n["by"]) for m in ms for n in m.notes or [] if n.get("by")}


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
    # Queued, started or requeued (Draft again) last: each touches updated_at, on the job
    # runner's clock (the wall clock).
    waited = jobs._now() - job.updated_at
    if job.status == "succeeded":
        # Its answer lands with the next read of the job's commit; a job that succeeded
        # long ago without writing them never will (walkc-meeting: never "drafting" on).
        return "failed" if waited > MINUTES_SLOW else "drafting"
    # walkc-meeting: a job still queued or running past MINUTES_STUCK is not coming (a
    # stalled queue, a lost worker): said as failed, so Draft again is offered.
    if waited > MINUTES_STUCK:
        return "failed"
    return "slow" if waited > MINUTES_SLOW else "drafting"


async def _sees_change(db: AsyncSession, principal: Any, c: SimpleChange) -> bool:
    me = _me(principal)
    if me is None:
        return False
    return c.by == me or has_role(principal.role, "owner") or me in (c.routed_to or [])


# The document kind a ritual kind reviews (oracle.rituals.kinds).
REVIEWS: dict[str, Literal["roadmap"]] = {"roadmap_refresh": "roadmap"}


# Delivery: each attendee's email and the Slack post are tried on the minute tick (the
# first right after Send), again 5 then 10 minutes after a failure: 3 tries over about 15
# minutes, then failed until whoever ended the meeting or an owner retries. The log keeps
# the error's type only, never an address or a token.
RETRY_AFTER_MINUTES = (5, 10)
TRIES = len(RETRY_AFTER_MINUTES) + 1
_PENDING = ("queued", "retrying")


def _due(state: dict, now: datetime) -> bool:
    at = state.get("next_at")
    return state.get("status") in _PENDING and (not at or datetime.fromisoformat(at) <= now)


def _failed_try(state: dict, now: datetime) -> dict:
    tries = int(state.get("tries") or 0) + 1
    if tries >= TRIES:
        return {"status": "failed", "tries": tries, "next_at": None}
    wait = timedelta(minutes=RETRY_AFTER_MINUTES[tries - 1])
    return {"status": "retrying", "tries": tries, "next_at": (now + wait).isoformat()}


def _email_status(to: dict) -> str:
    states = {x["status"] for x in to.values()}
    for status in ("retrying", "queued", "failed"):
        if status in states:
            return status
    return "sent"


def may_retry(principal: Any, m: SimpleMeeting) -> bool:
    """Whoever ended the meeting or an owner retries its delivery."""
    me = _me(principal)
    if me is None or getattr(principal, "run_token_id", None) is not None:
        return False
    return me == m.ended_by or has_role(principal.role, "owner")
