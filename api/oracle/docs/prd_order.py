"""PRDs keep one company order on every page (prd-order).

A PRD's place is its ``position`` (1 = first), set by an owner's Move up / Move down on
the One-pagers list. PRDs with a position come first, by position; PRDs without one follow,
in the goal order (oracle.baseline.goal_order) of the goal each mainly serves (the goal most
of its roadmap items serve; a PRD serving none comes last), then by title (case-folded, then
as written), then by id.
Every API read that lists PRDs sorts them with :func:`prd_ranks`; the web's twin is
``web/lib/prd-order.ts``, which sorts by the ``order`` the documents list carries.
"""

import uuid
from collections import Counter
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from oracle.baseline.goal_order import sort_goals
from oracle.baseline.models import Entity
from oracle.docs.models import Document


async def main_goals(db: AsyncSession, prd_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Each PRD's main goal, as that goal's place in the goal order (0 = first): the goal
    most of its roadmap items serve, each item's goal as Simple › Roadmap reads it (a goal
    linked to the item first, else the one its feature supports)."""
    from oracle.roadmap.models import RoadmapItem
    from oracle.simple.service import _goals

    ids = list(prd_ids)
    if not ids:
        return {}
    goals = sort_goals(await db.scalars(select(Entity).where(Entity.type == "goal")))
    rank = {g.id: n for n, g in enumerate(goals)}
    rows = (
        await db.execute(
            select(RoadmapItem.prd_document_id, RoadmapItem.goal_ids, RoadmapItem.feature_id).where(
                RoadmapItem.prd_document_id.in_(ids), RoadmapItem.cut.is_(False)
            )
        )
    ).all()
    supported = await _goals(db, {f for _, _, f in rows if f is not None})
    counts: dict[uuid.UUID, Counter[int]] = {}
    for prd_id, goal_ids, feature_id in rows:
        linked = [rank[g] for g in goal_ids or () if g in rank]
        goal = supported.get(feature_id) if feature_id else None
        main = min(linked) if linked else rank.get(goal.id) if goal is not None else None
        if main is not None:
            counts.setdefault(prd_id, Counter())[main] += 1
    # The most items; a tie goes to the goal that comes first.
    return {pid: min(g for g, n in c.items() if n == max(c.values())) for pid, c in counts.items()}


def sort_key(doc: Document, goal: dict[uuid.UUID, int]) -> tuple:
    """The one PRD order: position, then no position; then the main goal's place (none
    last); then title; then id."""
    title = doc.title or ""
    main = goal.get(doc.id)
    return (doc.position is None, doc.position or 0, main is None, main or 0,
            title.casefold(), title, str(doc.id))  # fmt: skip


async def sort_prds(db: AsyncSession, docs: Iterable[Document]) -> list[Document]:
    """``docs`` in the one PRD order."""
    docs = list(docs)
    goal = await main_goals(db, [d.id for d in docs])
    return sorted(docs, key=lambda d: sort_key(d, goal))


async def prd_ranks(db: AsyncSession) -> dict[uuid.UUID, int]:
    """Every PRD's place in the company order (1 = first), by id."""
    prds = await sort_prds(db, await db.scalars(select(Document).where(Document.kind == "prd")))
    return {d.id: n for n, d in enumerate(prds, 1)}


async def lock_prds(db: AsyncSession) -> list[Document]:
    """Every PRD of the company, locked (in id order, so two writers never deadlock) until the
    transaction ends: two owners moving at once never write the same places."""
    stmt = select(Document).where(Document.kind == "prd").order_by(Document.id).with_for_update()
    return list(await db.scalars(stmt))


def _place(doc: Document, position: int | None) -> None:
    if doc.position != position:
        doc.position = position
        # The place is not an edit: "Updated" keeps its time.
        flag_modified(doc, "updated_at")


async def move(db: AsyncSession, doc: Document, to: str) -> bool:
    """Move a PRD one place ``up`` or ``down`` in the company order, storing every PRD's
    place (1..N) so the order stays as shown. False when it is already at that end. The
    caller holds the lock (:func:`lock_prds`)."""
    prds = await sort_prds(db, await db.scalars(select(Document).where(Document.kind == "prd")))
    at = next(n for n, d in enumerate(prds) if d.id == doc.id)
    other = at - 1 if to == "up" else at + 1
    if other < 0 or other >= len(prds):
        return False
    prds[at], prds[other] = prds[other], prds[at]
    for n, d in enumerate(prds, 1):
        _place(d, n)
    await db.flush()
    return True


async def restore(
    db: AsyncSession, prds: list[Document], places: dict[uuid.UUID, int | None]
) -> None:
    """Put back each named PRD's stored place (null: none; the One-pagers' Undo after a
    move). The caller holds the lock (:func:`lock_prds`)."""
    for d in prds:
        if d.id in places:
            _place(d, places[d.id])
    await db.flush()
