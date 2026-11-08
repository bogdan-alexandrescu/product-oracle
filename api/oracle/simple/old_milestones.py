"""old-milestones (the owner, Nov 4: "Move them over"): goal milestones still on the older
per-PRD roadmaps, history while the company roadmap exists (oracle.roadmap.company), are
carried onto the company roadmap once, by an owner (``POST
/v1/simple/roadmap/milestones/carry-over``), never on a read or a deploy.

Each old milestone is copied with its name, date, goal and counts-when rule, coded the next
"M<n>" of its goal there, as the company roadmap's own. A PRD's own milestone (``origin_prd_id``)
is carried only while that PRD has no item on the company roadmap (a replaced PRD): one that
does is read from its plan onto the company roadmap already. The same PRD milestone on two
older roadmaps is carried once, both linked to the copy. The items it gates are re-pointed
to the company roadmap's items as Simple shows them: the item with the same feature, else
the same item key. The old milestone links to its copy (``carried_to_id``), which keeps a
second run from copying it again. One none of whose items are left is not copied: it waits
on an owner's Keep (copied with no items) or Drop (``carry_dropped_at``; stays behind).
"""

import uuid
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import or_, select, true
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


async def _shown_version(db: AsyncSession, company_id: uuid.UUID) -> uuid.UUID | None:
    """The company roadmap's version Simple shows (oracle.simple.service._versions): its
    latest approved version with items, else its latest with items."""
    has_items = (
        select(RoadmapItem.id).where(RoadmapItem.roadmap_version_id == DocumentVersion.id).exists()
    )
    return await db.scalar(
        select(DocumentVersion.id)
        .where(DocumentVersion.document_id == company_id, has_items)
        .order_by(DocumentVersion.approved_at.is_(None), DocumentVersion.number.desc())
        .limit(1)
    )


async def _replaced(db: AsyncSession) -> set[uuid.UUID]:
    """The PRDs a live PRD replaces (oracle.roadmap.company.replaced_prd_ids)."""
    return await company.replaced_prd_ids(db)


class _Plan:
    """Every old milestone still to bring, with the company items it would gate."""

    def __init__(self) -> None:
        self.company: Document | None = None
        self.rows: list[TrackMilestone] = []
        self.targets: dict[uuid.UUID, list[RoadmapItem]] = {}
        self.roadmaps: dict[uuid.UUID, Document] = {}
        self.goals: dict[uuid.UUID, str] = {}
        # The same PRD milestone on other older roadmaps: carried or dropped with the first.
        self.twins: dict[uuid.UUID, list[TrackMilestone]] = {}

    def with_twins(self, row: TrackMilestone) -> list[TrackMilestone]:
        return [row, *self.twins.get(row.id, [])]

    def first_of(self, milestone_id: uuid.UUID) -> TrackMilestone | None:
        """The row waiting for ``milestone_id``: itself, or the first copy of its twin."""
        return next(
            (r for r in self.rows if milestone_id in {t.id for t in self.with_twins(r)}), None
        )

    def needs_call(self, row: TrackMilestone) -> bool:
        return bool(row.item_ids) and not self.targets[row.id]


async def _plan(db: AsyncSession, lock: bool = False) -> _Plan:
    """A bounded read however many old milestones there are: the company roadmap, its shown
    version and the old milestones (with their roadmaps and goals) left to bring; only while
    some are left, the company items and the old items they gated."""
    plan = _Plan()
    plan.company = await company.active(db)
    if plan.company is None:
        return plan
    shown = await _shown_version(db, plan.company.id)
    # A PRD's own milestone is read from its plan while the PRD has an item on the company
    # roadmap as Simple shows it; it is never carried, so it is left out here.
    feeds = (
        select(RoadmapItem.id)
        .where(
            RoadmapItem.roadmap_version_id == shown,
            RoadmapItem.plan_state.is_(None),
            RoadmapItem.prd_document_id == TrackMilestone.origin_prd_id,
            RoadmapItem.prd_document_id.not_in(await _replaced(db)),
        )
        .exists()
    )
    q = (
        select(TrackMilestone, Document, Entity.title)
        .join(Document, Document.id == TrackMilestone.roadmap_id)
        .outerjoin(Entity, Entity.id == TrackMilestone.goal_id)
        .where(
            TrackMilestone.roadmap_id != plan.company.id,
            TrackMilestone.deleted_at.is_(None),
            TrackMilestone.carried_to_id.is_(None),
            TrackMilestone.carry_dropped_at.is_(None),
            Document.kind == "roadmap",
            Document.deleted_at.is_(None),
            or_(TrackMilestone.origin_prd_id.is_(None), ~feeds) if shown else true(),
        )
        .order_by(TrackMilestone.target_date.nulls_last(), TrackMilestone.name)
    )
    if lock:
        q = q.with_for_update(of=TrackMilestone)
    first: dict[tuple[uuid.UUID, str | None], TrackMilestone] = {}
    for row, rm, goal in (await db.execute(q)).all():
        plan.roadmaps[rm.id] = rm
        if row.goal_id and goal is not None:
            plan.goals[row.goal_id] = goal
        if row.origin_prd_id is not None:
            key = (row.origin_prd_id, row.code)
            if key in first:
                plan.twins.setdefault(first[key].id, []).append(row)
                continue
            first[key] = row
        plan.rows.append(row)
    if not plan.rows:
        return plan
    items = list(
        await db.scalars(
            select(RoadmapItem)
            .where(
                RoadmapItem.roadmap_version_id == shown,
                RoadmapItem.plan_state.is_(None),
                or_(
                    RoadmapItem.prd_document_id.is_(None),
                    RoadmapItem.prd_document_id.not_in(await _replaced(db)),
                ),
            )
            .order_by(RoadmapItem.position, RoadmapItem.item_key)
        )
    ) if shown else []  # fmt: skip
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
    for r in plan.with_twins(row):
        r.carried_to_id = new.id
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
    row = plan.first_of(milestone_id)
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
        for r in plan.with_twins(row):
            r.carry_dropped_at = company_time.now()
        await db.flush()
        await audit.record(db, principal, "goal_milestone.dropped", "track_milestone", row.id,
                           data={})  # fmt: skip
    await db.commit()
    return SimpleOldMilestonesResult(carried=carried, old_milestones=_view(await _plan(db)))
