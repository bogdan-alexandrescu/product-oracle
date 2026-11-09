"""The Simple roadmap's draft layer (RP2, the owner's pick 'Draft layer on roadmap', Nov 4).

Each PRD whose run's draft roadmap holds dated items not approved yet shows over the
roadmap's chart, hatched, for every such PRD the reader may see: :func:`draft_prds` reads
its newest drafted version's items as approval would place them (oracle.simple.prd_roadmap:
typed dates, the lead's accepted date, the item's own, its engineering milestone's); an
item with none is not listed, as approval does not place it. Left out: a PRD that was
replaced, a draft whose run was cancelled, and a PRD with a version at or after the drafted
one approved (approval puts its dated items on the roadmap's working draft).

Change dates and Leave out (:func:`change_dates`, :func:`leave_out`) change the run's draft
as the meeting step's own actions do, never the roadmap; approvers and up.
"""

import uuid
from datetime import date
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import company
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.runs.models import Run
from oracle.simple import dates, meeting_draft
from oracle.simple.schemas import SimpleDocRef, SimpleRoadmapDraftItem, SimpleRoadmapDraftPrd
from oracle.tenant_settings_api import company_horizons

# Who changes a draft item from the roadmap: those who decide (approvers and up).
CHANGE_ROLE = "approver"


async def _drafts(db: AsyncSession, principal: Any) -> list[tuple[DraftRoadmap, Document]]:
    """The ready drafts the layer shows, by PRD title: each PRD's newest drafted version's,
    none once a version at or after it is approved (approval reads that version's draft)."""
    rows = await db.execute(
        select(DraftRoadmap, Document, DocumentVersion.number)
        .join(Document, Document.id == DraftRoadmap.prd_document_id)
        .join(DocumentVersion, DocumentVersion.id == DraftRoadmap.prd_version_id)
        .outerjoin(Run, Run.id == DraftRoadmap.run_id)
        .where(
            DraftRoadmap.status == "ready",
            Document.id.not_in(await company.replaced_prd_ids(db)),
            or_(Run.id.is_(None), Run.status != "cancelled"),
            visibility.visible_to(principal),
        )
        .order_by(Document.title, DocumentVersion.number, DraftRoadmap.created_at)
    )
    newest: dict[uuid.UUID, tuple[DraftRoadmap, Document, int]] = {}
    for d, doc, n in rows.all():
        newest[doc.id] = (d, doc, n)  # in version order: the last is the newest
    if not newest:
        return []
    approved = dict(
        (
            await db.execute(
                select(DocumentVersion.document_id, func.max(DocumentVersion.number))
                .where(
                    DocumentVersion.document_id.in_(newest),
                    DocumentVersion.approved_at.is_not(None),
                )
                .group_by(DocumentVersion.document_id)
            )
        ).all()
    )
    return [(d, doc) for d, doc, n in newest.values() if approved.get(doc.id, 0) < n]


async def _items(db: AsyncSession, draft_ids: list[uuid.UUID]) -> list[RoadmapItem]:
    return list(
        await db.scalars(
            select(RoadmapItem)
            .where(
                RoadmapItem.draft_roadmap_id.in_(draft_ids),
                RoadmapItem.cut.is_(False),
                RoadmapItem.merged_into.is_(None),
            )
            .order_by(RoadmapItem.position, RoadmapItem.item_key)
        )
    )


async def _placed(db: AsyncSession, rows: list[RoadmapItem]) -> dict[uuid.UUID, tuple[date, date]]:
    """Each item approval would put on the roadmap, at the dates it would write
    (oracle.simple.prd_roadmap._dated): its typed dates, the lead's accepted date, its own,
    its engineering milestone's; a missing start is estimated as the roadmap does (its
    feature's effort before its end). An item with none of these is left out: approval
    does not place it."""
    from oracle.simple import prd_roadmap
    from oracle.simple.service import efforts

    windows = dates.windows(await company_horizons(db), await company_time.company_today(db))
    effort = await efforts(db, rows)
    accepted: dict[uuid.UUID | None, dict[str, date]] = {}
    out = {}
    for r in rows:
        if r.prd_document_id not in accepted:
            accepted[r.prd_document_id] = (
                await prd_roadmap._accepted(db, r.prd_document_id) if r.prd_document_id else {}
            )
        got = prd_roadmap._dated(r, accepted[r.prd_document_id])
        if got is None:
            continue
        start, end, source = got
        c = dates.Candidate(start, end, source, r.updated_at)  # type: ignore[arg-type]
        resolved = dates.resolve([c], windows.get(r.horizon, windows["now"]), effort.get(r.id))
        out[r.id] = (resolved.start.date, resolved.end.date)
    return out


async def draft_prds(db: AsyncSession, principal: Any) -> list[SimpleRoadmapDraftPrd]:
    drafts = await _drafts(db, principal)
    every = await _items(db, [d.id for d, _ in drafts])
    spans = await _placed(db, every)
    rows = [r for r in every if r.id in spans]
    owners = {r.owner_id for r in rows if r.owner_id is not None}
    names = {
        u: name or email
        for u, name, email in (
            await db.execute(select(User.id, User.name, User.email).where(User.id.in_(owners)))
        ).all()
    } if owners else {}  # fmt: skip
    may = has_role(principal.role, CHANGE_ROLE)
    out = []
    for d, doc in drafts:
        items = [
            SimpleRoadmapDraftItem(
                id=r.id,
                key=r.item_key,
                title=r.title,
                horizon=r.horizon,
                start=spans[r.id][0],
                end=spans[r.id][1],
                owner_name=names.get(r.owner_id) if r.owner_id else None,
            )
            for r in rows
            if r.draft_roadmap_id == d.id
        ]
        if items:
            out.append(SimpleRoadmapDraftPrd(
                prd=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
                run_id=d.run_id, items=items, can_change=may,
            ))  # fmt: skip
    return out


async def _item(db: AsyncSession, principal: Any, item_id: uuid.UUID) -> RoadmapItem | None:
    """The draft item when the layer shows it to ``principal`` (an item approval would
    place), else None."""
    drafts = await _drafts(db, principal)
    rows = await _items(db, [d.id for d, _ in drafts])
    row = next((r for r in rows if r.id == item_id), None)
    return row if row is not None and row.id in await _placed(db, [row]) else None


async def change_dates(
    db: AsyncSession, principal: Any, item_id: uuid.UUID, start: date, end: date
) -> bool:
    """Change dates: the item keeps them, still draft. False: no such draft item. The
    caller commits."""
    row = await _item(db, principal, item_id)
    if row is None:
        return False
    meeting_draft.set_dates(row, start, end)
    return True


async def leave_out(db: AsyncSession, principal: Any, item_id: uuid.UUID) -> bool:
    """Leave out: the item is cut from the run's draft and never goes on the roadmap."""
    row = await _item(db, principal, item_id)
    if row is None:
        return False
    row.cut = True
    return True
