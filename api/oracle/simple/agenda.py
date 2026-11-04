"""meeting-changes-only-its-agenda (owner, Nov 3): a meeting changes only what it reviews.

A review meeting's agenda is its PRD and the roadmaps that PRD's items are on. A change a
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
from oracle.simple.models import SimpleMeeting


@dataclass
class Agenda:
    meeting_id: uuid.UUID
    title: str
    prd_id: uuid.UUID
    roadmap_ids: set[uuid.UUID] = field(default_factory=set)

    session_id: uuid.UUID | None = None

    def covers(self, row: RoadmapItem) -> bool:
        """Whether a roadmap item is on the meeting's agenda: its PRD's, or on a roadmap
        the meeting reviews (a run's draft roadmap item is its PRD's)."""
        if row.prd_document_id == self.prd_id:
            return True
        return row.roadmap_document_id is not None and row.roadmap_document_id in self.roadmap_ids

    def covers_document(self, document_id: uuid.UUID | None) -> bool:
        return document_id is not None and (
            document_id == self.prd_id or document_id in self.roadmap_ids
        )


async def of(db: AsyncSession, m: SimpleMeeting | None) -> Agenda | None:
    if m is None:
        return None
    docs = set(
        await db.scalars(
            select(RoadmapItem.roadmap_document_id)
            .where(
                RoadmapItem.prd_document_id == m.prd_document_id,
                RoadmapItem.roadmap_document_id.is_not(None),
            )
            .distinct()
        )
    )
    return Agenda(
        meeting_id=m.id,
        title=m.title,
        prd_id=m.prd_document_id,
        roadmap_ids=docs,
        session_id=m.session_id,
    )


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
    return {
        m.session_id: m
        for m in await db.scalars(select(SimpleMeeting).where(SimpleMeeting.session_id.in_(ids)))
    }


def elsewhere_words(title: str | None) -> str:
    """What the meeting page says when it turns a change into a proposal."""
    name = (title or "").strip() or "This item"
    return f"{name} is on another roadmap: sent to its owner to decide"
