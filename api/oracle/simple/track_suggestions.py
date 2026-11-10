"""tracks-goal (owner Nov 9): "Oracle suggests, person confirms" a newly accepted PRD's track.

A PRD accepted while on no track gets no track of its own (``oracle.roadmap.tracks``
``auto_track``): Oracle records the existing track that fits it best (``track_prds`` row in
state ``suggested``), shown as one Inbox item to the PRD's owner, with Confirm, Pick a track
and New track. Each goes through the change engine; once the PRD is on a track the row is
``linked`` and the item leaves every Inbox at once. Until then its features read in the
Roadmap's No track band.

The PRD's owner: who brought in its first version, else who accepted its latest accepted
version, while an enabled member; else the company's owners.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import ProductTrack, TrackPrd


async def prd_owners(db: AsyncSession, prd_id: uuid.UUID) -> set[uuid.UUID]:
    from oracle.simple.plan_changes import company_owners, member

    first = await db.scalar(
        select(DocumentVersion.imported_by)
        .where(DocumentVersion.document_id == prd_id)
        .order_by(DocumentVersion.number)
        .limit(1)
    )
    accepted = await db.scalar(
        select(DocumentVersion.approved_by)
        .where(DocumentVersion.document_id == prd_id, DocumentVersion.approved_at.is_not(None))
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    for who in (first, accepted):
        if (m := await member(db, who)) is not None:
            return {m.id}
    return set(await company_owners(db))


async def inbox_rows(db: AsyncSession, principal: Any, seen: Any) -> list[Any]:
    """The suggested tracks of the PRDs I own, oldest first."""
    from oracle.simple.schemas import InboxSimpleTrackSuggestion, SimplePrdRef, SimpleTrackChoice

    me = getattr(principal, "user_id", None)
    if me is None or getattr(principal, "is_run", False):
        return []
    rows = list(
        await db.scalars(
            select(TrackPrd)
            .where(TrackPrd.state == "suggested")
            .order_by(TrackPrd.created_at, TrackPrd.id)
        )
    )
    rows = [r for r in rows if me in await prd_owners(db, r.prd_document_id)]
    if not rows:
        return []
    docs = {
        d.id: d
        for d in await db.scalars(
            select(Document).where(Document.id.in_({r.prd_document_id for r in rows}))
        )
    }
    live = [
        SimpleTrackChoice(id=t.id, title=t.title)
        for t in await db.scalars(
            select(ProductTrack)
            .where(ProductTrack.status != "closed")
            .order_by(ProductTrack.title, ProductTrack.id)
        )
    ]
    by_id = {t.id: t for t in live}
    return [
        InboxSimpleTrackSuggestion(
            id=r.id,
            prd=SimplePrdRef(id=r.prd_document_id, title=docs[r.prd_document_id].title),
            track=by_id.get(r.suggested_track_id) if r.suggested_track_id else None,
            tracks=live,
            at=r.created_at,
            state="new" if seen is None or r.created_at > seen else "open",
        )
        for r in rows
        if r.prd_document_id in docs
    ]
