"""trash-features-goals (owner's pick, Nov 4): a roadmap feature or a goal deleted to
Settings › Trash, restorable as a document is. Cut (a feature) and Archive (a goal) stay
for "not now"; Delete is for "this should not be here".

- ``DELETE /v1/simple/roadmap/items/{item_id}``: the feature (every row of its key on its
  roadmap, so no version shows it) goes to Trash. Who may decide on it
  (oracle.simple.service.can_decide, its ``can_decide``) deletes it; a commenter or
  approver who may not proposes it through the change engine (op ``delete_item``, "Move
  <name> to Trash"), routed as any proposal on the item, accepted or declined by its
  decider; viewers are refused. Its links (``depends_on``, and the items that depend on
  it), its goal, its milestone membership and the decisions that name it are kept as they
  are, so Restore puts it back exactly; while it is in Trash every read leaves it out
  (oracle.trash.filter), and history and decisions name it with "(deleted)".
- ``DELETE /v1/simple/goal-buckets/goals/{goal_id}``: who may edit the goal (approver and
  up) deletes it; its features first move to ``to_goal_id`` or to no goal, as Archive
  moves them. Restore puts the goal back with its order, measure, target and due.
- ``POST .../restore`` (owners, as Trash): restore one; ``/v1/trash`` lists and restores
  them beside documents, and the ticker purges them after 30 days.
"""

import uuid
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.deps import TenantDB, same_origin
from oracle.authz import has_role
from oracle.baseline.models import Entity
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts, service
from oracle.simple.models import SimpleChange
from oracle.simple.router import Approver, Commenter, Owner
from oracle.simple.schemas import SimpleChangeOut
from oracle.trash import service as trash
from oracle.trash.filter import INCLUDE_TRASHED
from oracle.trash.models import RETENTION_DAYS, TrashEntry
from oracle.trash.schemas import TrashEntryOut

OPS: frozenset[str] = frozenset({"delete_item"})
ALL = {INCLUDE_TRASHED: True}
DELETED = "(deleted)"

router = APIRouter(prefix="/v1/simple", tags=["simple"], dependencies=[Depends(same_origin)])
Reason = Annotated[str | None, Query(max_length=2000)]


class TrashedOut(BaseModel):
    """A delete's answer: the Trash entry when it went to Trash, or the proposal made when
    the caller may not delete it (``change``, routed to its decider). ``can_restore``:
    whether the caller may restore it from Trash (owners); others ask an owner."""

    entry: TrashEntryOut | None = None
    change: SimpleChangeOut | None = None
    can_restore: bool = False


def _me(principal: Any) -> uuid.UUID | None:
    return getattr(principal, "user_id", None)


def describe(row: Any) -> dict[str, Any]:
    if isinstance(row, RoadmapItem):
        return {"type": "feature", "id": str(row.id), "slug": row.item_key,
                "title": row.title, "kind": "feature"}  # fmt: skip
    return {"type": "goal", "id": str(row.id), "slug": row.key, "title": row.title,
            "kind": "goal"}  # fmt: skip


async def _new_entry(
    db: AsyncSession, principal: Any, root: Any, rows: list[Any], extra: dict, reason: str | None
) -> TrashEntry:
    at = trash.now()
    root_type = "feature" if isinstance(root, RoadmapItem) else "goal"
    entry = TrashEntry(
        id=uuid.uuid4(),
        root_type=root_type,
        root_id=root.id,
        root={**describe(root), **extra},
        items=[],
        deleted_by=principal.id,
        deleted_by_name=await trash._actor_name(db, principal),
        reason=reason,
        published=False,
        purge_after=at + timedelta(days=RETENTION_DAYS),
    )
    entry.created_at = at
    db.add(entry)
    await db.flush()
    for row in rows:
        row.deleted_at = at
        row.deleted_by = principal.id
        row.deleted_reason = reason
        row.trash_entry_id = entry.id
    await audit.record(db, principal, "trash.delete", root_type, root.id,
                       {"entry_id": str(entry.id), "root": entry.root, "items": [],
                        "reason": reason})  # fmt: skip
    await db.flush()
    return entry


async def _feature_rows(db: AsyncSession, row: RoadmapItem) -> list[RoadmapItem]:
    """The item and its rows on the roadmap's other versions and drafts (same key), so no
    version the reader may see shows it while it is in Trash."""
    if row.roadmap_document_id is None:
        return [row]
    stmt = (
        select(RoadmapItem)
        .where(
            RoadmapItem.roadmap_document_id == row.roadmap_document_id,
            RoadmapItem.item_key == row.item_key,
        )
        .with_for_update()
    )
    rows = list(await db.scalars(stmt))
    return rows if row in rows else [row, *rows]


async def trash_feature(
    db: AsyncSession, principal: Any, entry: service.Entry, reason: str | None
) -> TrashEntry:
    """Move the feature to Trash. Nothing that names it is rewritten: Restore puts it back
    with its links, goal, milestone and decisions as they were."""
    rows = await _feature_rows(db, entry.row)
    code = (entry.code or "").strip() or None
    extra = {"code": code, "roadmap_id": str(entry.roadmap.id)}
    return await _new_entry(db, principal, entry.row, rows, extra, reason)


async def _entry_of(db: AsyncSession, principal: Any, item_id: uuid.UUID) -> tuple:
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    entry = read_.by_id().get(item_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such roadmap item")
    return entry, read_


def _name(entry: service.Entry) -> str:
    return f"{entry.code or ''} {entry.row.title}".strip()


async def _propose(
    db: AsyncSession, principal: Any, entry: service.Entry, read_: service.Read, reason: str | None
) -> SimpleChange:
    from oracle.simple import changes

    open_ = await db.scalar(
        select(SimpleChange.id).where(
            SimpleChange.op == "delete_item",
            SimpleChange.status == "proposed",
            SimpleChange.target["item_id"].astext == str(entry.row.id),
        )
    )
    if open_ is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Moving this to Trash is proposed already")
    c = SimpleChange(
        document_id=entry.roadmap.id, op="delete_item",
        target={"item_id": str(entry.row.id), "title": entry.row.title, "name": _name(entry)},
        before={"deleted": False}, after={"deleted": True}, status="proposed",
        by=_me(principal), at=company_time.now(), reason=reason,
        routed_to=await changes.routed_to(db, entry, read_),
    )  # fmt: skip
    db.add(c)
    await db.flush()
    await audit.record(db, principal, "simple_change.proposed", "simple_change", c.id,
                       data={"op": c.op, "target": c.target})  # fmt: skip
    return c


async def delete_feature(
    db: AsyncSession, principal: Any, item_id: uuid.UUID, reason: str | None
) -> TrashedOut:
    from oracle.simple import changes

    entry, read_ = await _entry_of(db, principal, item_id)
    if service.can_decide(principal, entry, read_.deciders):
        row = await trash_feature(db, principal, entry, reason)
        out = TrashedOut(entry=_entry_out(row), can_restore=_restores(principal))
        await db.commit()
        return out
    c = await _propose(db, principal, entry, read_, reason)
    await db.commit()
    return TrashedOut(change=await changes.one_out(db, principal, c),
                      can_restore=_restores(principal))  # fmt: skip


async def create_change(db: AsyncSession, principal: Any, body: Any) -> Any:
    """``POST /v1/simple/changes`` op ``delete_item`` (``target.item_id``): the same as
    ``DELETE /v1/simple/roadmap/items/{id}``, as a change: applied when the caller decides
    the item, else proposed to whoever does."""
    from oracle.simple import changes
    from oracle.simple.schemas import SimpleChangeResult

    item_id = changes._uuid(body.target.get("item_id"), "item_id")
    entry, read_ = await _entry_of(db, principal, item_id)
    if service.can_decide(principal, entry, read_.deciders):
        await trash_feature(db, principal, entry, body.reason)
        c = SimpleChange(
            document_id=entry.roadmap.id, op="delete_item",
            target={"item_id": str(entry.row.id), "title": entry.row.title, "name": _name(entry)},
            before={"deleted": False}, after={"deleted": True}, status="applied",
            by=_me(principal), at=company_time.now(), reason=body.reason, routed_to=[],
        )  # fmt: skip
        db.add(c)
        await db.flush()
    else:
        c = await _propose(db, principal, entry, read_, body.reason)
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def decide(
    db: AsyncSession, principal: Any, c: SimpleChange, action: str, reason: str | None
) -> Any:
    """Accept (the feature goes to Trash) or decline a proposed delete, by the feature's
    decider."""
    from oracle.simple.changes import ChangeError, one_out
    from oracle.simple.schemas import SimpleChangeResult

    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    entry = read_.by_id().get(uuid.UUID(c.target["item_id"]))
    if entry is None:
        raise ChangeError(404, "The feature is gone")
    if not service.can_decide(principal, entry, read_.deciders):
        raise ChangeError(403, "Only an owner or the roadmap's decider (with no decider, its "
                               "owner) decides proposals")  # fmt: skip
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept":
        await trash_feature(db, principal, entry, c.reason)
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = _me(principal), company_time.now(), reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])


async def trash_goal(
    db: AsyncSession, principal: Any, goal: Entity, to_goal_id: uuid.UUID | None,
    reason: str | None,
) -> TrashEntry:  # fmt: skip
    """Move the goal's features off it (to ``to_goal_id`` or to no goal, as Archive does,
    and the items that name it as their own goal), then the goal to Trash. Its order,
    measure, target and due stay on it for Restore."""
    from oracle.simple import goal_buckets

    await goal_buckets.move_off(db, goal, to_goal_id)
    moved = []
    for row in await db.scalars(
        select(RoadmapItem).where(RoadmapItem.goal_ids.contains([goal.id])).with_for_update()
    ):
        ids = [i for i in row.goal_ids if i != goal.id]
        if to_goal_id is not None and to_goal_id not in ids:
            ids = [to_goal_id, *ids]
        row.goal_ids = ids
        moved.append(str(row.id))
    to = str(to_goal_id) if to_goal_id else None
    return await _new_entry(db, principal, goal, [goal],
                            {"to_goal_id": to, "moved_items": moved}, reason)  # fmt: skip


def _restores(principal: Any) -> bool:
    return has_role(principal.role, "owner")


def _entry_out(entry: TrashEntry) -> TrashEntryOut:
    from oracle.trash.router import _entry_out as out

    return out(entry)


async def deleted_names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """The features and goals of ``ids`` in Trash, by id: their name with "(deleted)", for
    history and decisions that keep pointing at them."""
    if not ids:
        return {}
    out: dict[uuid.UUID, str] = {}
    for model in (RoadmapItem, Entity):
        rows = await db.execute(
            select(model.id, model.title)
            .where(model.id.in_(ids), model.deleted_at.is_not(None))
            .execution_options(**ALL)
        )
        out |= {i: f"{t} {DELETED}" for i, t in rows.all()}
    return out


# --- routes ---------------------------------------------------------------------------


async def _call(op: Any) -> Any:
    try:
        return await op
    except trash.TrashError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.delete("/roadmap/items/{item_id}", response_model=TrashedOut, name="delete_simple_item")
async def delete_item(
    item_id: uuid.UUID, db: TenantDB, principal: Commenter, reason: Reason = None
) -> TrashedOut:
    """Move the feature to Trash (30 days, then deleted for good). Who may not decide on it
    proposes it to its decider instead (``change``); viewers are refused."""
    return await delete_feature(db, principal, item_id, reason)


@router.post(
    "/roadmap/items/{item_id}/restore", response_model=TrashEntryOut, name="restore_simple_item"
)
async def restore_item(item_id: uuid.UUID, db: TenantDB, principal: Owner) -> TrashEntryOut:
    """Put the feature back from Trash with its links, goal and milestone."""
    return await _restore(db, principal, "feature", item_id)


@router.delete(
    "/goal-buckets/goals/{goal_id}", response_model=TrashedOut, name="delete_bucket_goal"
)
async def delete_goal(
    goal_id: uuid.UUID,
    db: TenantDB,
    principal: Approver,
    to_goal_id: uuid.UUID | None = None,
    reason: Reason = None,
) -> TrashedOut:
    """Move the goal to Trash, after its features move to ``to_goal_id`` (absent: to no
    goal), as Archive moves them."""
    from oracle.simple import goal_buckets

    g = await goal_buckets._entity(db, goal_id, "goal")
    if to_goal_id is not None:
        to = await goal_buckets._entity(db, to_goal_id, "goal")
        if to.id == g.id or to.status == "rejected":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Pick another goal")
    entry = await trash_goal(db, principal, g, to_goal_id, reason)
    out = TrashedOut(entry=_entry_out(entry), can_restore=_restores(principal))
    await db.commit()
    return out


@router.post(
    "/goal-buckets/goals/{goal_id}/restore",
    response_model=TrashEntryOut,
    name="restore_bucket_goal",
)
async def restore_goal(goal_id: uuid.UUID, db: TenantDB, principal: Owner) -> TrashEntryOut:
    """Put the goal back from Trash with its order, measure, target and due."""
    return await _restore(db, principal, "goal", goal_id)


async def _restore(db: TenantDB, principal: Any, root_type: str, ref: uuid.UUID) -> TrashEntryOut:
    from oracle.trash.router import _entry_out as out

    entry, not_restored = await _call(trash.restore_root(db, principal, root_type, str(ref)))
    res = out(entry, not_restored)
    await db.commit()
    return res
