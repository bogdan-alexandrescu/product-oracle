"""goal-map-link-asks: a feature put on a goal milestone (or its link moved from another)
through the change engine, so who may propose but not edit the Goal map (a commenter: map
``can_edit`` is approver and up) suggests it on the Goal ladder instead of being refused.

- ``POST /v1/simple/changes`` op ``link_goal_map``, ``target``
  ``{feature, milestone, from_milestone?}`` (``from_milestone`` null or absent: put the
  feature on ``milestone``, as ``POST /v1/simple/goal-map/links`` does; else move its link
  from that milestone, as ``POST /links/move`` does), ``before`` and ``after`` ``{}``.
  A commenter's is ``proposed``, on the feature's roadmap (``document_id``), routed to who
  decides it (``key_dates.route``: its decider, else its deciding owners, else the
  company's owners); one open ask per feature and milestone. Viewers may not (403); who
  edits the map (approver and up) does it directly (409).
- Accepted by whom it is routed to, an owner or who changes the roadmap directly
  (``key_dates.may_decide``): the same code as the Goal map's routes (``goal_map.attach``,
  in the milestone's first area, else the feature's, else the map's first;
  ``goal_map.move_link``). Declined or withdrawn (the engine's own withdraw): nothing changes.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.authz import has_role
from oracle.roadmap.models import RoadmapItem, TrackMilestone
from oracle.simple import drafts
from oracle.simple.models import FocusArea, MilestoneFeature, SimpleChange

OPS: frozenset[str] = frozenset({"link_goal_map"})


def may_act(principal: Any) -> bool:
    """Edits the Goal map directly (as the goal-map routes allow: map ``can_edit``)."""
    return has_role(principal.role, "approver") and not getattr(principal, "read_only", False)


def may_propose(principal: Any) -> bool:
    return has_role(principal.role, "commenter") and getattr(principal, "user_id", None) is not None


def may_decide(principal: Any, c: SimpleChange, view: Any) -> bool:
    """Whom it is routed to, an owner, or who changes the feature's roadmap directly."""
    from oracle.simple import key_dates

    return key_dates.may_decide(principal, c, view)


def _id(raw: Any, field: str) -> uuid.UUID:
    from oracle.simple.changes import ChangeError

    try:
        return uuid.UUID(str(raw))
    except ValueError:
        raise ChangeError(422, f"target.{field} is not an id") from None


async def _milestone(db: AsyncSession, mid: uuid.UUID) -> TrackMilestone:
    from oracle.simple.changes import ChangeError

    m = await db.get(TrackMilestone, mid)
    if m is None or m.goal_id is None or m.deleted_at is not None:
        raise ChangeError(404, "No such milestone")
    return m


async def _link(db: AsyncSession, feature: uuid.UUID, mid: uuid.UUID) -> MilestoneFeature | None:
    return await db.scalar(
        select(MilestoneFeature).where(
            MilestoneFeature.item_id == feature, MilestoneFeature.milestone_id == mid
        )
    )


async def _area(db: AsyncSession, m: TrackMilestone, feature: uuid.UUID) -> uuid.UUID | None:
    """The cell the feature lands in: the milestone's first area, else the feature's own,
    else the map's first (as the ladder's drop picks it)."""
    for a in m.gate_area_ids or []:
        if await db.get(FocusArea, a) is not None:
            return a
    own = await db.scalar(
        select(MilestoneFeature.area_id)
        .where(MilestoneFeature.item_id == feature, MilestoneFeature.area_id.is_not(None))
        .order_by(MilestoneFeature.created_at)
    )
    if own is not None:
        return own
    return await db.scalar(select(FocusArea.id).order_by(FocusArea.position, FocusArea.id))


async def _apply(db: AsyncSession, c: SimpleChange) -> None:
    from oracle.simple import goal_map
    from oracle.simple.changes import ChangeError

    feature = _id(c.target.get("feature"), "feature")
    mid = _id(c.target.get("milestone"), "milestone")
    frm = c.target.get("from_milestone")
    try:
        if frm:
            body = goal_map.MoveLinkIn(feature=feature, from_milestone=_id(frm, "from_milestone"),
                                       to_milestone=mid)  # fmt: skip
            await goal_map.move_link(db, body)
            return
        m = await _milestone(db, mid)
        area = await _area(db, m, feature)
        if area is None:
            raise ChangeError(422, "The map has no area to put it in")
        await goal_map.attach(db, goal_map.AttachIn(feature=feature, milestone=mid, area=area))
    except goal_map.GoalMapError as e:
        raise ChangeError(e.status, e.detail) from None


async def create_change(db: AsyncSession, principal: Any, body: Any) -> Any:
    from oracle.simple import key_dates
    from oracle.simple.changes import ChangeError, _me, one_out
    from oracle.simple.schemas import SimpleChangeResult

    if not may_propose(principal):
        raise ChangeError(403, "Viewers may not propose a change")
    if may_act(principal):
        raise ChangeError(409, "You change this directly on the Goal map")
    t = body.target or {}
    feature, mid = _id(t.get("feature"), "feature"), _id(t.get("milestone"), "milestone")
    frm = _id(t["from_milestone"], "from_milestone") if t.get("from_milestone") else None
    item = await db.get(RoadmapItem, feature)
    if item is None:
        raise ChangeError(404, "No such feature")
    m = await _milestone(db, mid)
    if frm == mid:
        raise ChangeError(422, "It is on that milestone already")
    was = None
    if frm is not None:
        if await _link(db, feature, frm) is None:
            raise ChangeError(404, "The feature is not on that milestone")
        was = await db.get(TrackMilestone, frm)
    elif await _link(db, feature, mid) is not None:
        raise ChangeError(422, "It is on that milestone already")
    elif await _area(db, m, feature) is None:
        raise ChangeError(422, "The map has no area to put it in")
    open_ = await db.scalar(
        select(SimpleChange.id).where(
            SimpleChange.op == body.op,
            SimpleChange.status == "proposed",
            SimpleChange.target["feature"].astext == str(feature),
            SimpleChange.target["milestone"].astext == str(mid),
        )
    )
    if open_ is not None:
        raise ChangeError(409, "This is asked already")
    doc = item.roadmap_document_id or m.roadmap_id
    w = await drafts.who(db, {doc} if doc else set())
    target = {
        "feature": str(feature), "milestone": str(mid),
        "from_milestone": str(frm) if frm else None,
        # The engine's own keys: the item it names in words, the milestones by name.
        "item_id": str(feature), "title": item.title, "name": m.name,
        "from_name": was.name if was is not None else None,
    }  # fmt: skip
    c = SimpleChange(
        document_id=doc, op=body.op, target=target, before={}, after={}, status="proposed",
        by=_me(principal), at=company_time.now(), reason=body.reason,
        routed_to=await key_dates.route(db, doc, w) if doc else [],
    )  # fmt: skip
    db.add(c)
    await db.flush()
    await audit.record(db, principal, "simple_change.proposed", "simple_change", c.id,
                       data={"op": c.op, "target": c.target})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])


async def decide(
    db: AsyncSession, principal: Any, c: SimpleChange, action: str, reason: str | None
) -> Any:
    """Accept (put the feature on the milestone, or move its link) or decline."""
    from oracle.simple.changes import ChangeError, _me, one_out
    from oracle.simple.schemas import SimpleChangeResult

    w = await drafts.who(db, {c.document_id} if c.document_id else set())
    view = type("V", (), {"deciders": w.deciders, "owners": w.owners})
    if not may_decide(principal, c, view):
        raise ChangeError(403, "Only an owner or the roadmap's decider (with none, its owner) "
                               "decides this proposal")  # fmt: skip
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept":
        await _apply(db, c)
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = _me(principal), company_time.now(), reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])
