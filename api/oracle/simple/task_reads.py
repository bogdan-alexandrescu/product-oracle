"""walkc-roadmap-tasks: each roadmap item's tasks for the Simple roadmap read, with the tracker
records they are pushed to (task-push, #1816). Split out of oracle.simple.service."""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.members.names import display_name
from oracle.simple.schemas import SimpleItemTask, SimplePersonRef

if TYPE_CHECKING:
    from oracle.simple.service import Entry


async def item_tasks(db: AsyncSession, shown: list[Entry]) -> dict[uuid.UUID, list[SimpleItemTask]]:
    """walkc-roadmap-tasks: each item's tasks (not dropped, in order), found by the item's
    roadmap and key so a later version's item keeps them, with their owners' names."""
    from oracle.simple import drafts
    from oracle.simple.models import RoadmapItemTask
    from oracle.simple.service import _any_of

    if not shown:
        return {}
    keyed = {(e.row.roadmap_document_id, e.row.item_key): e.row.id for e in shown}
    rows = list(
        await db.scalars(
            select(RoadmapItemTask)
            .where(
                RoadmapItemTask.roadmap_document_id.in_({d for d, _ in keyed}),
                _any_of(RoadmapItemTask.item_key, {k for _, k in keyed}),
                RoadmapItemTask.status != "dropped",
            )
            .order_by(RoadmapItemTask.position, RoadmapItemTask.created_at, RoadmapItemTask.id)
        )
    )
    people = {t.owner_id for t in rows if t.owner_id is not None}
    names = {
        u.id: display_name(u.email, u.name) for u in await drafts.all_users(db) if u.id in people
    }
    records = await task_records(db, rows)
    out: dict[uuid.UUID, list[SimpleItemTask]] = defaultdict(list)
    for t in rows:
        item = keyed.get((t.roadmap_document_id, t.item_key))
        if item is not None:
            out[item].append(task_out(t, names, records))
    return out


async def task_records(db: AsyncSession, rows: list[Any]) -> dict[uuid.UUID, Any]:
    """task-push (#1816): the tracker records the tasks are linked to, by id."""
    from oracle.roadmap.models import TrackerRecord

    ids = {t.tracker_record_id for t in rows if t.tracker_record_id is not None}
    if not ids:
        return {}
    return {
        r.id: r for r in await db.scalars(select(TrackerRecord).where(TrackerRecord.id.in_(ids)))
    }


def task_out(
    t: Any, names: dict[uuid.UUID, str], records: dict[uuid.UUID, Any] | None = None
) -> SimpleItemTask:
    owner = (
        SimplePersonRef(id=t.owner_id, name=names[t.owner_id])
        if t.owner_id is not None and t.owner_id in names
        else None
    )
    rec = (records or {}).get(t.tracker_record_id) if t.tracker_record_id else None
    return SimpleItemTask(id=t.id, title=t.title, status=t.status, owner=owner,
                          due_date=t.due_date, tracker_ref=rec.external_ref if rec else None,
                          tracker_url=rec.url if rec else None,
                          tracker_error=t.tracker_push_error)  # fmt: skip
