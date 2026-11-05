"""old-milestones (the owner, Nov 4: "Move them over"): goal milestones still on the older
per-PRD roadmaps, history while the company roadmap exists (oracle.roadmap.company), are
carried onto the company roadmap once, by an owner (``POST
/v1/simple/roadmap/milestones/carry-over``), never on a read or a deploy.

Each old milestone of its roadmap's own (``origin_prd_id`` null; a PRD's own milestones are
read from its plan onto the company roadmap already) is copied with its name, date, goal and
counts-when rule, coded the next "M<n>" of its goal there. The items it gates are re-pointed
to the company roadmap's items as Simple shows them: the item with the same feature, else
the same item key. The old milestone links to its copy (``carried_to_id``), which keeps a
second run from copying it again. One none of whose items are left is not copied: it waits
on an owner's Keep (copied with no items) or Drop (``carry_dropped_at``; stays behind).
"""

import uuid
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.authz import has_role
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import company
from oracle.roadmap.models import RoadmapItem, TrackMilestone
from oracle.simple.schemas import (
    SimpleDocRef,
    SimpleOldMilestone,
    SimpleOldMilestones,
    SimpleOldMilestonesResult,
)


def _is_owner(principal: Any) -> bool:
    return has_role(principal.role, "owner")


async def _company_items(db: AsyncSession, company_id: uuid.UUID) -> list[RoadmapItem]:
    """The company roadmap's items as Simple shows them (oracle.simple.service.load): its
    latest approved version with items, else its latest; no replaced PRD's, none shipped."""
    from oracle.simple.service import _versions

    versions = (
        await db.execute(
            select(
                DocumentVersion.id,
                DocumentVersion.document_id,
                DocumentVersion.number,
                DocumentVersion.approved_at,
            ).where(DocumentVersion.document_id == company_id)
        )
    ).all()
    with_items = set(
        await db.scalars(
            select(RoadmapItem.roadmap_version_id)
            .where(RoadmapItem.roadmap_document_id == company_id)
            .distinct()
        )
    )
    shown = _versions(versions, with_items).get(company_id)
    if shown is None:
        return []
    replaced = await company.replaced_prd_ids(db)
    return [
        r
        for r in await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == shown, RoadmapItem.plan_state.is_(None))
            .order_by(RoadmapItem.position, RoadmapItem.item_key)
        )
        if r.prd_document_id not in replaced
    ]


class _Plan:
    """Every old milestone still to bring, with the company items it would gate."""

    def __init__(self) -> None:
        self.company: Document | None = None
        self.rows: list[TrackMilestone] = []
        self.targets: dict[uuid.UUID, list[RoadmapItem]] = {}
        self.roadmaps: dict[uuid.UUID, Document] = {}
        self.goals: dict[uuid.UUID, str] = {}

    def needs_call(self, row: TrackMilestone) -> bool:
        return bool(row.item_ids) and not self.targets[row.id]


async def _plan(db: AsyncSession, lock: bool = False) -> _Plan:
    plan = _Plan()
    plan.company = await company.active(db)
    if plan.company is None:
        return plan
    q = (
        select(TrackMilestone)
        .join(Document, Document.id == TrackMilestone.roadmap_id)
        .where(
            TrackMilestone.roadmap_id != plan.company.id,
            TrackMilestone.origin_prd_id.is_(None),
            TrackMilestone.deleted_at.is_(None),
            TrackMilestone.carried_to_id.is_(None),
            TrackMilestone.carry_dropped_at.is_(None),
            Document.kind == "roadmap",
            Document.deleted_at.is_(None),
        )
        .order_by(TrackMilestone.target_date.nulls_last(), TrackMilestone.name)
    )
    if lock:
        q = q.with_for_update(of=TrackMilestone)
    plan.rows = list(await db.scalars(q))
    if not plan.rows:
        return plan
    items = await _company_items(db, plan.company.id)
    by_feature: dict[uuid.UUID, RoadmapItem] = {}
    by_key: dict[str, RoadmapItem] = {}
    for r in items:
        if r.feature_id is not None:
            by_feature.setdefault(r.feature_id, r)
        by_key.setdefault(r.item_key, r)
    old_ids = {i for row in plan.rows for i in row.item_ids or []}
    olds = {
        r.id: r
        for r in await db.scalars(select(RoadmapItem).where(RoadmapItem.id.in_(old_ids)))
    } if old_ids else {}  # fmt: skip
    for row in plan.rows:
        found: dict[uuid.UUID, RoadmapItem] = {}
        for i in row.item_ids or []:
            old = olds.get(i)
            if old is None:
                continue
            to = (by_feature.get(old.feature_id) if old.feature_id else None) or by_key.get(
                old.item_key
            )
            if to is not None:
                found.setdefault(to.id, to)
        plan.targets[row.id] = list(found.values())
    plan.roadmaps = {
        d.id: d
        for d in await db.scalars(
            select(Document).where(Document.id.in_({r.roadmap_id for r in plan.rows}))
        )
    }
    goal_ids = {r.goal_id for r in plan.rows if r.goal_id}
    plan.goals = {
        e.id: e.title
        for e in await db.scalars(select(Entity).where(Entity.id.in_(goal_ids)))
    } if goal_ids else {}  # fmt: skip
    return plan


def _out(plan: _Plan, row: TrackMilestone) -> SimpleOldMilestone:
    rm = plan.roadmaps[row.roadmap_id]
    return SimpleOldMilestone(
        id=row.id, name=row.name, date=row.target_date, goal_id=row.goal_id,
        goal_title=plan.goals.get(row.goal_id) if row.goal_id else None,
        from_roadmap=SimpleDocRef(id=rm.id, slug=rm.slug, title=rm.title),
        items=[t.title for t in plan.targets[row.id]],
    )  # fmt: skip


def _view(plan: _Plan) -> SimpleOldMilestones:
    return SimpleOldMilestones(
        can_act=True,
        moves=[_out(plan, r) for r in plan.rows if not plan.needs_call(r)],
        needs_call=[_out(plan, r) for r in plan.rows if plan.needs_call(r)],
    )


async def preview(db: AsyncSession, principal: Any) -> SimpleOldMilestones:
    """What a carry-over would move and what needs a call; an owner's alone."""
    if not _is_owner(principal):
        return SimpleOldMilestones()
    return _view(await _plan(db))


def _refuse(principal: Any) -> None:
    if not _is_owner(principal):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an owner brings old milestones over")


async def _copy(
    db: AsyncSession, principal: Any, plan: _Plan, row: TrackMilestone, items: list[uuid.UUID]
) -> TrackMilestone:
    from oracle.simple.goal_milestones import _next_code

    assert plan.company is not None
    new = TrackMilestone(
        track_id=None, roadmap_id=plan.company.id, goal_id=row.goal_id,
        code=await _next_code(db, plan.company.id, row.goal_id), name=row.name,
        target_date=row.target_date, item_ids=items, counts_when=row.counts_when,
        progress=row.progress, created_by=getattr(principal, "user_id", None),
    )  # fmt: skip
    db.add(new)
    await db.flush()
    row.carried_to_id = new.id
    await db.flush()
    await audit.record(db, principal, "goal_milestone.carried", "track_milestone", row.id,
                       data={"to": str(new.id), "roadmap_id": str(plan.company.id)})  # fmt: skip
    return new


async def carry_over(db: AsyncSession, principal: Any) -> SimpleOldMilestonesResult:
    """Copy every old milestone with items left (or none to begin with) onto the company
    roadmap; those with no items left stay listed for Keep or Drop. A second run copies
    nothing more."""
    _refuse(principal)
    plan = await _plan(db, lock=True)
    carried = [
        (await _copy(db, principal, plan, r, [t.id for t in plan.targets[r.id]])).id
        for r in plan.rows
        if not plan.needs_call(r)
    ]
    await db.commit()
    return SimpleOldMilestonesResult(carried=carried, old_milestones=_view(await _plan(db)))


async def decide(
    db: AsyncSession, principal: Any, milestone_id: uuid.UUID, action: str
) -> SimpleOldMilestonesResult:
    """Keep (copied with no items) or Drop (left behind) an old milestone with no items
    left; one already carried, dropped or with items to bring is 409."""
    _refuse(principal)
    plan = await _plan(db, lock=True)
    row = next((r for r in plan.rows if r.id == milestone_id), None)
    if row is None:
        gone = await db.get(TrackMilestone, milestone_id)
        if gone is None or gone.roadmap_id is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such milestone")
        raise HTTPException(status.HTTP_409_CONFLICT, "That milestone is not waiting on a call")
    if not plan.needs_call(row):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "That milestone still has items: bring it over with the rest"
        )
    carried: list[uuid.UUID] = []
    if action == "keep":
        carried.append((await _copy(db, principal, plan, row, [])).id)
    else:
        row.carry_dropped_at = company_time.now()
        await db.flush()
        await audit.record(db, principal, "goal_milestone.dropped", "track_milestone", row.id,
                           data={})  # fmt: skip
    await db.commit()
    return SimpleOldMilestonesResult(carried=carried, old_milestones=_view(await _plan(db)))
