"""Section links whose evidence or source item is about to be deleted (0014_trace).

A link has at least one target: an entity, evidence or a source item. A link that keeps
another target outlives the one deleted: ``implements -> entity X`` citing item I still
traces the section to X once I's source is gone, so a later change to X still reaches
it. Only a link left with no target goes. The delete paths call :func:`release` after
recording the change (whose trace handler snapshots the links that go, using
:func:`left_without_target`) and before the delete, so the target check always holds.
"""

import uuid
from collections.abc import Collection

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.v2.models import DocumentSectionLink


def left_without_target(
    link: DocumentSectionLink,
    evidence_ids: Collection[uuid.UUID] = (),
    source_item_ids: Collection[uuid.UUID] = (),
) -> bool:
    """Whether ``link`` has no target once that evidence and those items are deleted."""
    return (
        link.entity_id is None
        and (link.evidence_id is None or link.evidence_id in evidence_ids)
        and (link.source_item_id is None or link.source_item_id in source_item_ids)
    )


async def release(
    db: AsyncSession,
    *,
    evidence_ids: Collection[uuid.UUID] = (),
    source_item_ids: Collection[uuid.UUID] = (),
) -> int:
    """Before that evidence and those items are deleted: drop the reference from the
    links that keep another target, delete the links left with none. Returns how many
    were deleted."""
    conditions = []
    if evidence_ids:
        conditions.append(DocumentSectionLink.evidence_id.in_(evidence_ids))
    if source_item_ids:
        conditions.append(DocumentSectionLink.source_item_id.in_(source_item_ids))
    if not conditions:
        return 0
    deleted = 0
    for link in (await db.scalars(select(DocumentSectionLink).where(or_(*conditions)))).all():
        if left_without_target(link, evidence_ids, source_item_ids):
            await db.delete(link)
            deleted += 1
            continue
        if link.evidence_id in evidence_ids:
            link.evidence_id = None
        if link.source_item_id in source_item_ids:
            link.source_item_id = None
    await db.flush()
    return deleted
