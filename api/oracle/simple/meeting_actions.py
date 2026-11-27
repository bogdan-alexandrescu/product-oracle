"""#1817: a meeting's action items reach their owners. The open action items a person owns
(``simple_action_items``) are rows of their Inbox's "Needs you" (counted) and of Home's
waiting list (oracle.simple.waiting_list), each with its due date, linked item and meeting.
Its owner changes or closes one through the change engine (oracle.simple.targets:
``edit_action_item``, ``set_action_item_status``), one Undo each.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimpleActionItem, SimpleMeeting
from oracle.simple.schemas import InboxSimpleActionItem
from oracle.simple.schemas_meetings import SimpleMeetingActionItem


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
    linked = list(await db.scalars(select(RoadmapItem).where(RoadmapItem.id.in_(items))))
    titles = {i.id: i.title for i in linked}
    # inbox-codes (#1786): each linked item's code, so its row names it with its code.
    from oracle.roadmap import codes

    by_feature = await codes.feature_codes(db) if any(i.feature_id for i in linked) else {}
    item_codes = {i.id: codes.code_of(i, by_feature) for i in linked}
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
            item_code=item_codes.get(r.item_id) if r.item_id else None,
            roadmap_id=r.roadmap_document_id,
            meeting_id=r.meeting_id,
            meeting_title=meetings.get(r.meeting_id) if r.meeting_id else None,
            at=r.created_at,
            state="new" if seen is None or r.created_at > seen else "open",
        )
        for r in rows
    ]


async def of_meeting(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID
) -> list[SimpleMeetingActionItem]:
    """A meeting's recorded action items, each with whether ``principal`` changes it: its
    owner, or one who decides its item (oracle.simple.service.can_decide; an owner with none)."""
    from oracle.authz import has_role
    from oracle.simple import service
    from oracle.simple.meetings import _names

    rows = list(await db.scalars(
        select(SimpleActionItem).where(SimpleActionItem.meeting_id == meeting_id)
        .order_by(SimpleActionItem.created_at, SimpleActionItem.title)
    ))  # fmt: skip
    if not rows:
        return []
    me = getattr(principal, "user_id", None)
    read_ = await service.load(db) if any(r.item_id for r in rows) else None
    by_id = read_.by_id() if read_ else {}

    def decides(r: SimpleActionItem) -> bool:
        entry = by_id.get(r.item_id) if r.item_id else None
        if entry is None or read_ is None:
            return has_role(principal.role, "owner")
        return service.can_decide(principal, entry, read_.deciders)

    names = await _names(db, {r.owner_id for r in rows})
    return [
        SimpleMeetingActionItem(
            id=r.id,
            title=r.title,
            owner_id=r.owner_id,
            owner_name=names.get(r.owner_id),
            due_date=r.due_date,
            item_id=r.item_id,
            status=r.status,
            can_change=me is not None and (r.owner_id == me or decides(r)),
        )  # fmt: skip
        for r in rows
    ]
