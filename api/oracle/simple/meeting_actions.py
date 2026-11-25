"""#1817: a meeting's action items reach their owners. The open action items a person owns
(``simple_action_items``) are rows of their Inbox's "Needs you" (counted) and of Home's
waiting list (oracle.simple.waiting_list), each with its due date, linked item and meeting.
Its owner changes or closes one through the change engine (oracle.simple.targets:
``edit_action_item``, ``set_action_item_status``), one Undo each.
"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimpleActionItem, SimpleMeeting
from oracle.simple.schemas import InboxSimpleActionItem


async def mine(db: AsyncSession, principal: Any) -> list[SimpleActionItem]:
    """The open action items ``principal`` owns, due first."""
    me = getattr(principal, "user_id", None)
    if me is None or getattr(principal, "run_token_id", None) is not None:
        return []
    return list(
        await db.scalars(
            select(SimpleActionItem)
            .where(SimpleActionItem.owner_id == me, SimpleActionItem.status == "open")
            .order_by(SimpleActionItem.due_date.asc().nulls_last(), SimpleActionItem.created_at)
        )
    )


async def may_close(db: AsyncSession, principal: Any, target: dict[str, Any]) -> bool:
    """Whether ``principal`` owns the action item a change targets (its owner applies)."""
    import uuid

    me = getattr(principal, "user_id", None)
    try:
        aid = uuid.UUID(str(target.get("action_item_id")))
    except ValueError:
        return False
    row = await db.get(SimpleActionItem, aid)
    return me is not None and row is not None and row.owner_id == me


async def inbox_rows(db: AsyncSession, principal: Any, seen: Any) -> list[InboxSimpleActionItem]:
    rows = await mine(db, principal)
    if not rows:
        return []
    items = {i for i in (r.item_id for r in rows) if i}
    titles = dict((await db.execute(
        select(RoadmapItem.id, RoadmapItem.title).where(RoadmapItem.id.in_(items))
    )).all()) if items else {}  # fmt: skip
    meets = {i for i in (r.meeting_id for r in rows) if i}
    meetings = dict((await db.execute(
        select(SimpleMeeting.id, SimpleMeeting.title).where(SimpleMeeting.id.in_(meets))
    )).all()) if meets else {}  # fmt: skip
    today = await company_time.company_today(db)
    return [
        InboxSimpleActionItem(
            id=r.id,
            title=r.title,
            due_date=r.due_date,
            late=r.due_date is not None and r.due_date < today,
            item_id=r.item_id,
            item_title=titles.get(r.item_id, r.item_key) if r.item_id else None,
            roadmap_id=r.roadmap_document_id,
            meeting_id=r.meeting_id,
            meeting_title=meetings.get(r.meeting_id) if r.meeting_id else None,
            at=r.created_at,
            state="new" if seen is None or r.created_at > seen else "open",
        )
        for r in rows
    ]
