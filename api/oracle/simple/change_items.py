"""home-3 (#1900): the items changes name by an id an older version of their roadmap gave them
(each approved version copies its items under new ids)."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.roadmap.models import RoadmapItem


async def past(db: AsyncSession, changes: list, by_id: dict, deleted: dict) -> dict[str, Any]:
    """By that id: the item as it is now (same roadmap, same key), else None, with its last
    known name. One query for the whole list."""
    ids = set()
    for c in changes:
        try:
            item = uuid.UUID(str(c.target.get("item_id")))
        except ValueError:
            continue
        if item not in by_id and str(item) not in deleted:
            ids.add(item)
    if not ids:
        return {}
    now: dict[tuple[uuid.UUID | None, str], Any] = {
        (e.roadmap.id, e.row.item_key): e for e in by_id.values()
    }
    rows = await db.execute(
        select(RoadmapItem.id, RoadmapItem.roadmap_document_id, RoadmapItem.item_key,
               RoadmapItem.title).where(RoadmapItem.id.in_(ids))
    )  # fmt: skip
    return {str(i): (now.get((doc, key)), title) for i, doc, key, title in rows.all()}
