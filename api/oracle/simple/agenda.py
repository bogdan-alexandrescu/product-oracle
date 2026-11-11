"""meeting-changes-only-its-agenda (owner, Nov 3): a meeting changes only what it reviews.

A review meeting's agenda is its PRD and the roadmap it reviews: the one it was started
on (``agenda.roadmap_id``, meetings.start), else every roadmap the PRD's items are on. A change a
meeting makes (its chat's cards, apply all, its agents' cards, a task) to an item anywhere
else is never applied: it is a proposal for that item's roadmap decider (else its owner,
else the company's owners), who accepts or declines it from their Inbox or the item's
panel, and it says which meeting asked for it. A meeting does not decide such a proposal
through its own session either.
"""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.roadmap.models import RoadmapItem
from oracle.runs import batch
from oracle.simple.models import SimpleMeeting

# The roadmaps a PRD's items are on (oracle.runs.batch).
ROADMAPS = "agenda_roadmaps"


@dataclass
class Agenda:
    meeting_id: uuid.UUID
    title: str
    prd_id: uuid.UUID
    roadmap_ids: set[uuid.UUID] = field(default_factory=set)

    session_id: uuid.UUID | None = None

    def covers(self, row: RoadmapItem) -> bool:
        """Whether a roadmap item is on the meeting's agenda: on a roadmap it reviews, or
        its PRD's item on a run's draft roadmap (no roadmap yet)."""
        if row.roadmap_document_id is None:
            return row.prd_document_id == self.prd_id
        return row.roadmap_document_id in self.roadmap_ids

    def covers_document(self, document_id: uuid.UUID | None) -> bool:
        return document_id is not None and (
            document_id == self.prd_id or document_id in self.roadmap_ids
        )


async def of(db: AsyncSession, m: SimpleMeeting | None) -> Agenda | None:
    if m is None:
        return None
    pinned = (m.agenda or {}).get("roadmap_id")
    if pinned:
        # The roadmap it was started on (meetings.start): only that one.
        return Agenda(meeting_id=m.id, title=m.title, prd_id=m.prd_document_id,
                      roadmap_ids={uuid.UUID(str(pinned))}, session_id=m.session_id)  # fmt: skip
    prd_id = m.prd_document_id
    docs = await batch.many(ROADMAPS, [prd_id], lambda ids: _roadmaps(db, ids))
    return Agenda(
        meeting_id=m.id,
        title=m.title,
        prd_id=m.prd_document_id,
        roadmap_ids=set(docs.get(prd_id, ())),
        session_id=m.session_id,
    )


async def of_many(db: AsyncSession, meetings: list[SimpleMeeting]) -> dict[uuid.UUID, Agenda]:
    """:func:`of` for many meetings, by meeting id, in one read (the change history names the
    agenda of every meeting its changes were made in)."""
    prds = {m.prd_document_id for m in meetings if not (m.agenda or {}).get("roadmap_id")}
    docs: dict[uuid.UUID, set[uuid.UUID]] = {p: set() for p in prds}
    if prds:
        for prd, doc in await db.execute(
            select(RoadmapItem.prd_document_id, RoadmapItem.roadmap_document_id)
            .where(
                RoadmapItem.prd_document_id.in_(prds),
                RoadmapItem.roadmap_document_id.is_not(None),
            )
            .distinct()
        ):
            docs[prd].add(doc)
    out = {}
    for m in meetings:
        pinned = (m.agenda or {}).get("roadmap_id")
        out[m.id] = Agenda(
            meeting_id=m.id,
            title=m.title,
            prd_id=m.prd_document_id,
            roadmap_ids={uuid.UUID(str(pinned))} if pinned else set(docs[m.prd_document_id]),
            session_id=m.session_id,
        )
    return out


async def for_session(db: AsyncSession, session_id: uuid.UUID | None) -> Agenda | None:
    """The agenda of the meeting whose session this is (None: no meeting's)."""
    if session_id is None:
        return None
    m = await db.scalar(select(SimpleMeeting).where(SimpleMeeting.session_id == session_id))
    return await of(db, m)


async def for_meeting(db: AsyncSession, meeting_id: uuid.UUID | None) -> Agenda | None:
    return await of(db, await db.get(SimpleMeeting, meeting_id)) if meeting_id else None


async def meetings_of(db: AsyncSession, session_ids: set) -> dict[uuid.UUID, SimpleMeeting]:
    """The meeting of each of these sessions that is a meeting's, by session id."""
    ids = {i for i in session_ids if i}
    if not ids:
        return {}
    found = {
        m.session_id: m
        for m in await db.scalars(select(SimpleMeeting).where(SimpleMeeting.session_id.in_(ids)))
    }
    if batch.active():
        # In one Inbox call (oracle.runs.batch): the roadmaps of every one of these
        # meetings' PRDs in one read, for each meeting's :func:`of`.
        prds = [m.prd_document_id for m in found.values() if not (m.agenda or {}).get("roadmap_id")]
        await batch.many(ROADMAPS, prds, lambda keys: _roadmaps(db, keys))
    return found


async def _roadmaps(db: AsyncSession, prd_ids: list[uuid.UUID]) -> dict[uuid.UUID, set[uuid.UUID]]:
    """Every roadmap each of these PRDs' items are on, by PRD."""
    out: dict[uuid.UUID, set[uuid.UUID]] = {}
    for prd_id, roadmap_id in (
        await db.execute(
            select(RoadmapItem.prd_document_id, RoadmapItem.roadmap_document_id)
            .where(
                RoadmapItem.prd_document_id.in_(prd_ids),
                RoadmapItem.roadmap_document_id.is_not(None),
            )
            .distinct()
        )
    ).all():
        out.setdefault(prd_id, set()).add(roadmap_id)
    return out


def elsewhere_words(title: str | None) -> str:
    """What the meeting page says when it turns a change into a proposal."""
    name = (title or "").strip() or "This item"
    return f"{name} is on another roadmap: sent to its owner to decide"
