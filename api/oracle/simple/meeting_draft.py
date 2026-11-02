"""The run's draft roadmap in a review meeting's Roadmap step (build-runplan RP2, 'Meeting
step as draft').

After the engineering dates stop a run's draft roadmap holds the PRD's dated items
(``RoadmapItem.draft_roadmap_id``), not on the roadmap until approved. The meeting reads
them (:func:`draft_out`); whoever may change things in the meeting changes an item's dates
or leaves it out, and it stays draft; Approve these N dates (:func:`approve_dates`) puts
the items on the roadmap with their dates and records the meeting's decision.
"""

import uuid
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.simple import dates
from oracle.simple.schemas import SimpleDraftRoadmap, SimpleDraftRoadmapItem
from oracle.tenant_settings_api import company_horizons


async def _items(db: AsyncSession, document_id: uuid.UUID) -> list[RoadmapItem]:
    """The PRD's ready draft roadmap's items, left in, in roadmap order."""
    return list(
        await db.scalars(
            select(RoadmapItem)
            .join(DraftRoadmap, DraftRoadmap.id == RoadmapItem.draft_roadmap_id)
            .where(
                DraftRoadmap.prd_document_id == document_id,
                DraftRoadmap.status == "ready",
                RoadmapItem.cut.is_(False),
                RoadmapItem.merged_into.is_(None),
            )
            .order_by(RoadmapItem.position, RoadmapItem.item_key)
        )
    )


async def _spans(db: AsyncSession, rows: list[RoadmapItem]) -> dict[uuid.UUID, tuple[date, date]]:
    """Each item's start and end as the Simple roadmap resolves them (its own dates, its
    engineering milestone, else its horizon's window)."""
    from oracle.simple.service import _candidates

    windows = dates.windows(await company_horizons(db), await company_time.company_today(db))
    out = {}
    for r in rows:
        resolved = dates.resolve(_candidates(r, [], {}, {}), windows.get(r.horizon, windows["now"]))
        out[r.id] = (resolved.start.date, resolved.end.date)
    return out


# The ref on the PRD subject of a meeting's Approve these N dates decision: "draft-dates:N".
APPROVED_REF = "draft-dates"


async def _approved_here(
    db: AsyncSession, meeting_id: uuid.UUID, document_id: uuid.UUID
) -> int | None:
    """How many items this meeting's Approve these N dates put on the roadmap, or None."""
    from oracle.decisions.models import Decision
    from oracle.simple.models import SimpleMeetingDecision

    rows = await db.scalars(
        select(Decision.subjects)
        .join(SimpleMeetingDecision, SimpleMeetingDecision.decision_id == Decision.id)
        .where(SimpleMeetingDecision.meeting_id == meeting_id)
        .order_by(SimpleMeetingDecision.at.desc())
    )
    for subjects in rows:
        for s in subjects or []:
            ref = str(s.get("ref") or "")
            if s.get("id") == str(document_id) and ref.startswith(f"{APPROVED_REF}:"):
                n = ref.partition(":")[2]
                return int(n) if n.isdigit() else None
    return None


async def draft_out(
    db: AsyncSession, document: Document, meeting_id: uuid.UUID | None = None
) -> SimpleDraftRoadmap | None:
    rows = await _items(db, document.id)
    if not rows:
        n = await _approved_here(db, meeting_id, document.id) if meeting_id else None
        return SimpleDraftRoadmap(items=[], approved=n) if n is not None else None
    spans = await _spans(db, rows)
    return SimpleDraftRoadmap(
        items=[
            SimpleDraftRoadmapItem(
                id=r.id,
                key=r.item_key,
                title=r.title,
                horizon=r.horizon,
                start=spans[r.id][0],
                end=spans[r.id][1],
            )  # fmt: skip
            for r in rows
        ]
    )


async def _changing(db: AsyncSession, principal: Any, meeting_id: uuid.UUID):
    """The live meeting and its PRD when the caller may change things in it, else 403/409."""
    from oracle.simple.meetings import MeetingError, _get, _me, _rules

    m, document = await _get(db, principal, meeting_id, lock=True)
    if m.status != "live":
        raise MeetingError(409, "The meeting has ended")
    if not (_rules(m).may_change(_me(principal)) and has_role(principal.role, "commenter")):
        raise MeetingError(403, "You cannot change things in this meeting")
    return m, document


async def _item(db: AsyncSession, document: Document, item_id: uuid.UUID) -> RoadmapItem:
    from oracle.simple.meetings import MeetingError

    for r in await _items(db, document.id):
        if r.id == item_id:
            return r
    raise MeetingError(404, "No such draft item")


async def change_dates(
    db: AsyncSession,
    principal: Any,
    meeting_id: uuid.UUID,
    item_id: uuid.UUID,
    start: date,
    end: date,
) -> None:
    """Change dates: the item keeps them as typed, still draft. The caller commits."""
    _, document = await _changing(db, principal, meeting_id)
    row = await _item(db, document, item_id)
    row.start_date, row.end_date, row.date_source = start, end, "typed"


async def leave_out(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, item_id: uuid.UUID
) -> None:
    """Leave out: the item is cut from the draft and never goes on the roadmap."""
    _, document = await _changing(db, principal, meeting_id)
    row = await _item(db, document, item_id)
    row.cut = True


async def _target(db: AsyncSession, document: Document) -> tuple[uuid.UUID, uuid.UUID] | None:
    """The roadmap the dates go on and its version shown in Simple: the roadmap the PRD's
    other items are on, else the company's first; its newest version holding items."""
    from oracle.simple.meetings import _prd_items

    _, roadmap_ids = await _prd_items(db, document)
    roadmap = await db.scalar(
        select(Document.id)
        .where(Document.kind == "roadmap", *([Document.id.in_(roadmap_ids)] if roadmap_ids else []))
        .order_by(Document.created_at)
        .limit(1)
    )
    if roadmap is None:
        return None
    version = await db.scalar(
        select(DocumentVersion.id)
        .join(RoadmapItem, RoadmapItem.roadmap_version_id == DocumentVersion.id)
        .where(DocumentVersion.document_id == roadmap)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    ) or await db.scalar(
        select(DocumentVersion.id)
        .where(DocumentVersion.document_id == roadmap)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    return (roadmap, version) if version is not None else None


async def approve_dates(db: AsyncSession, principal: Any, meeting_id: uuid.UUID) -> None:
    """Approve these N dates: the draft's items go on the roadmap with the dates shown, and
    the meeting records the decision. The PRD still needs its own approval."""
    from oracle.simple.meetings import MeetingError, record_meeting_decision

    _, document = await _changing(db, principal, meeting_id)
    rows = await _items(db, document.id)
    if not rows:
        raise MeetingError(409, "No draft dates to approve")
    target = await _target(db, document)
    if target is None:
        raise MeetingError(409, "There is no roadmap to put the dates on yet")
    roadmap_id, version_id = target
    spans = await _spans(db, rows)
    last = await db.scalar(
        select(func.max(RoadmapItem.position)).where(RoadmapItem.roadmap_version_id == version_id)
    )
    for i, r in enumerate(rows, start=1):
        r.start_date, r.end_date = spans[r.id]
        r.date_source = r.date_source or "engineering"
        r.draft_roadmap_id = None
        r.roadmap_document_id, r.roadmap_version_id = roadmap_id, version_id
        r.position = (last or 0) + i
    await db.flush()
    n = len(rows)
    title = f"{document.title} dates approved: {n} item{'' if n == 1 else 's'} on the roadmap"
    subject = {"kind": "document", "id": str(document.id), "ref": f"{APPROVED_REF}:{n}"}
    await record_meeting_decision(db, principal, meeting_id, title, [subject], [])
