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
  up) deletes it; a commenter proposes it through the change engine (op ``delete_goal``,
  "Move the goal <name> to Trash", routed to the company's owners, decided by an approver
  or up); viewers are refused. With no ``to_goal_id`` nothing that names it is rewritten:
  its features' links and the items' ``goal_ids`` stay, and the trash filter (and the
  roadmap reads, for ``goal_ids``) leave it out. With ``to_goal_id`` its features move
  there as Archive moves them, and the links and ``goal_ids`` as they were are kept on
  the Trash entry for Restore. Restore puts the goal back with its order, measure, target
  and due, and its features' links and the items' goals exactly as they were.
- Item keys: a feature in Trash keeps its key (``trashed_keys``: new features never take
  it), so the items that depend on it still point at it; Restore refuses (409) if another
  live item holds its key all the same. A purge takes its id out of milestones and its key
  out of the items that depended on it. A version published, drafted or submitted while it
  was in Trash was made without it: Restore puts it on the roadmap's current version, the
  working draft's and the one in review too, with its goal, dependencies and milestones
  (a dependency no longer on the roadmap is dropped, and the answer's ``not_restored``
  says which). The approved-roadmap import never gives a new item a trashed key either.
- ``POST .../restore``: an owner, or whoever deleted it (owner's answer, Nov 5;
  oracle.trash.service.may_restore), restores one; ``/v1/trash`` lists and restores them
  beside documents (to those below owner, only what they deleted), and the ticker purges
  them after 30 days.
"""

import uuid
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.deps import TenantDB, same_origin
from oracle.authz import has_role
from oracle.baseline.models import Entity
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts, service
from oracle.simple.models import SimpleChange
from oracle.simple.router import Commenter
from oracle.simple.schemas import SimpleChangeOut
from oracle.trash import service as trash
from oracle.trash.filter import INCLUDE_TRASHED
from oracle.trash.models import RETENTION_DAYS, TrashEntry
from oracle.trash.schemas import TrashEntryOut

OPS: frozenset[str] = frozenset({"delete_item", "delete_goal"})
ALREADY = "Already in Trash"
ALL = {INCLUDE_TRASHED: True}
DELETED = "(deleted)"

router = APIRouter(prefix="/v1/simple", tags=["simple"], dependencies=[Depends(same_origin)])
Reason = Annotated[str | None, Query(max_length=2000)]


class TrashedOut(BaseModel):
    """A delete's answer: the Trash entry when it went to Trash, or the proposal made when
    the caller may not delete it (``change``, routed to its decider). ``can_restore``:
    whether the caller may restore it from Trash (an owner, or who deleted it)."""

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
    await _close_proposals(db, principal, root, at)
    await audit.record(db, principal, "trash.delete", root_type, root.id,
                       {"entry_id": str(entry.id), "root": entry.root, "items": [],
                        "reason": reason})  # fmt: skip
    await db.flush()
    return entry


async def _close_proposals(db: AsyncSession, principal: Any, root: Any, at: Any) -> None:
    """A proposal to delete what just went to Trash is closed: "Already in Trash"."""
    op, ref = (
        ("delete_item", "item_id") if isinstance(root, RoadmapItem) else ("delete_goal", "goal_id")
    )
    for c in await db.scalars(
        select(SimpleChange).where(
            SimpleChange.op == op,
            SimpleChange.status == "proposed",
            SimpleChange.target[ref].astext == str(root.id),
        )
    ):
        c.status, c.decision_reason = "declined", ALREADY
        c.decided_by, c.decided_at = _me(principal), company_time.now()


async def trashed_keys(db: AsyncSession, roadmap_document_id: Any) -> set[str]:
    """The keys of the roadmap's features in Trash: taken, so a new feature never gets one
    and the items that depend on a trashed feature still point at it on Restore."""
    if roadmap_document_id is None:
        return set()
    stmt = (
        select(RoadmapItem.item_key)
        .where(
            RoadmapItem.roadmap_document_id == roadmap_document_id,
            RoadmapItem.deleted_at.is_not(None),
        )
        .execution_options(**ALL)
    )
    return set(await db.scalars(stmt))


async def trashed_names(db: AsyncSession, roadmap_document_id: Any) -> dict[str, str]:
    """prd-reads-working-draft: the roadmap's features in Trash, key -> title (a PRD's run
    is told to leave them out, oracle.simple.roadmap_of_record)."""
    return {key: title for key, title, _ in await trashed_rows(db, roadmap_document_id)}


async def trashed_rows(
    db: AsyncSession, roadmap_document_id: Any
) -> list[tuple[str, str, uuid.UUID | None]]:
    """The roadmap's features in Trash as (key, title, the PRD they belong to), oldest first
    (a member-view run leaves out those of a PRD a commenter may not see)."""
    if roadmap_document_id is None:
        return []
    stmt = (
        select(RoadmapItem.item_key, RoadmapItem.title, RoadmapItem.prd_document_id)
        .where(
            RoadmapItem.roadmap_document_id == roadmap_document_id,
            RoadmapItem.deleted_at.is_not(None),
        )
        .order_by(RoadmapItem.deleted_at)
        .execution_options(**ALL)
    )
    return [(k, t, p) for k, t, p in (await db.execute(stmt)).all()]


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


async def _delete(
    db: AsyncSession, principal: Any, item_id: uuid.UUID, reason: str | None
) -> tuple[SimpleChange, TrashEntry | None]:
    """Applied (the trash entry made) when the caller decides the item, else proposed to
    whoever does. Either way a ``delete_item`` change, so history says it."""
    entry, read_ = await _entry_of(db, principal, item_id)
    if not service.can_decide(principal, entry, read_.deciders):
        return await _propose(db, principal, entry, read_, reason), None
    row = await trash_feature(db, principal, entry, reason)
    c = SimpleChange(
        document_id=entry.roadmap.id, op="delete_item",
        target={"item_id": str(entry.row.id), "title": entry.row.title, "name": _name(entry)},
        before={"deleted": False}, after={"deleted": True}, status="applied",
        by=_me(principal), at=company_time.now(), reason=reason, routed_to=[],
    )  # fmt: skip
    db.add(c)
    await db.flush()
    return c, row


async def delete_feature(
    db: AsyncSession, principal: Any, item_id: uuid.UUID, reason: str | None
) -> TrashedOut:
    from oracle.simple import changes

    c, row = await _delete(db, principal, item_id, reason)
    out = TrashedOut(entry=_entry_out(row) if row else None, can_restore=_restores(principal, row))
    await db.commit()
    if row is None:
        out.change = await changes.one_out(db, principal, c)
    return out


async def create_change(db: AsyncSession, principal: Any, body: Any) -> Any:
    """``POST /v1/simple/changes`` op ``delete_item`` (``target.item_id``): the same as
    ``DELETE /v1/simple/roadmap/items/{id}``, as a change: applied when the caller decides
    the item, else proposed to whoever does."""
    from oracle.simple import changes
    from oracle.simple.schemas import SimpleChangeResult

    if body.op == "delete_goal":
        from oracle.simple import goal_buckets

        g = await goal_buckets._entity(
            db, changes._uuid(body.target.get("goal_id"), "goal_id"), "goal"
        )
        c = await _propose_goal(db, principal, g, None, body.reason)
        if _may_delete_goal(principal):
            await trash_goal(db, principal, g, None, body.reason)
            c.status, c.routed_to = "applied", []
        await db.commit()
        return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])
    item_id = changes._uuid(body.target.get("item_id"), "item_id")
    c, _ = await _delete(db, principal, item_id, body.reason)
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def decide(
    db: AsyncSession, principal: Any, c: SimpleChange, action: str, reason: str | None
) -> Any:
    """Accept (the feature goes to Trash) or decline a proposed delete, by the feature's
    decider."""
    from oracle.simple.changes import ChangeError, one_out
    from oracle.simple.schemas import SimpleChangeResult

    if c.op == "delete_goal":
        return await _decide_goal(db, principal, c, action, reason)
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    entry = read_.by_id().get(uuid.UUID(c.target["item_id"]))
    if entry is None:
        if c.status == "proposed" and await _in_trash(db, RoadmapItem, c.target["item_id"]):
            return await _closed(db, principal, c)
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


async def _in_trash(db: AsyncSession, model: type, ref: str) -> bool:
    stmt = select(model.deleted_at).where(model.id == uuid.UUID(str(ref))).execution_options(**ALL)  # type: ignore[attr-defined]
    return await db.scalar(stmt) is not None


async def _closed(db: AsyncSession, principal: Any, c: SimpleChange) -> Any:
    """A proposal whose feature or goal went to Trash meanwhile: closed, not left open."""
    from oracle.simple.changes import one_out
    from oracle.simple.schemas import SimpleChangeResult

    c.status, c.decision_reason = "declined", ALREADY
    c.decided_by, c.decided_at = _me(principal), company_time.now()
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])


async def trash_goal(
    db: AsyncSession, principal: Any, goal: Entity, to_goal_id: uuid.UUID | None,
    reason: str | None,
) -> TrashEntry:  # fmt: skip
    """The goal to Trash. With no ``to_goal_id`` nothing is rewritten: its features' links
    and the items' goal_ids stay, and the reads leave the goal out while it is in Trash.
    With ``to_goal_id`` its features move there as Archive moves them (and the items that
    name it as their own goal), and the links and goal_ids as they were go on the entry
    for :func:`after_restore`. Its order, measure, target and due stay on it."""
    from oracle.simple import goal_buckets

    extra: dict[str, Any] = {"to_goal_id": None, "links": [], "goal_ids": {}}
    if to_goal_id is not None:
        before = await goal_buckets.move_off(db, goal, to_goal_id)
        goal_ids = {}
        for row in await db.scalars(
            select(RoadmapItem).where(RoadmapItem.goal_ids.contains([goal.id])).with_for_update()
        ):
            goal_ids[str(row.id)] = [str(i) for i in row.goal_ids]
            ids = [i for i in row.goal_ids if i != goal.id]
            row.goal_ids = ids if to_goal_id in ids else [to_goal_id, *ids]
        extra = {"to_goal_id": str(to_goal_id), "goal_ids": goal_ids,
                 "links": [snap.model_dump(mode="json") for snap in before]}  # fmt: skip
    return await _new_entry(db, principal, goal, [goal], extra, reason)


async def before_restore(db: AsyncSession, entry: TrashEntry) -> None:
    """A feature whose key another live item holds is not restored (409): the two would
    share it and the items that depend on it would point at both."""
    if entry.root_type != "feature":
        return
    rows = await db.execute(
        select(RoadmapItem.roadmap_document_id, RoadmapItem.item_key)
        .where(RoadmapItem.trash_entry_id == entry.id)
        .execution_options(**ALL)
    )
    for doc, key in set(rows.all()):
        clash = await db.scalar(
            select(RoadmapItem.title).where(
                RoadmapItem.roadmap_document_id == doc, RoadmapItem.item_key == key
            ).limit(1)
        )  # fmt: skip
        if clash is not None:
            raise trash.Conflict(
                f"'{clash}' holds this feature's key now: rename or delete it, then restore"
            )


async def after_restore(
    db: AsyncSession, entry: TrashEntry, principal: Any = None
) -> list[dict[str, Any]]:
    """A feature back on its roadmap's current version (:func:`_onto_current`); a goal's
    features' links as before its delete moved them (a feature whose goals or their order
    changed since keeps them), and each item's goal back where it was, less the goal the
    delete added (``links``, ``goal_ids`` and ``to_goal_id`` on the entry; none when nothing was
    moved): a goal given to the item since stays. Returns what did not come back with it
    (a dependency no longer on the roadmap)."""
    from oracle.simple import goal_buckets

    if entry.root_type == "feature":
        return await _onto_current(db, entry, principal)
    if entry.root_type != "goal":
        return []
    to = uuid.UUID(entry.root["to_goal_id"]) if entry.root.get("to_goal_id") else None
    for raw in entry.root.get("links") or []:
        snap = goal_buckets.FeatureSnap.model_validate(raw)
        # A feature whose goals changed since the delete (moved to another goal in the goal
        # buckets, or the same goals with a new first one) keeps them: only links still as
        # the delete left them, in its order, go back.
        left = [lk.goal_id for lk in goal_buckets.moved_off_links(snap, entry.root_id, to)]
        now = [e.dst_id for e in await goal_buckets._links(db, [snap.feature_id])]
        if now == left:
            await goal_buckets._restore_links(db, snap)
    for item_id, ids in (entry.root.get("goal_ids") or {}).items():
        row = await db.scalar(
            select(RoadmapItem).where(RoadmapItem.id == uuid.UUID(item_id))
            .execution_options(**ALL).with_for_update()
        )  # fmt: skip
        if row is None:
            continue
        # Only what the delete did: the goal goes back where it was, and the goal it moved
        # the item to comes off only where the delete added it; later changes stay.
        was = [uuid.UUID(i) for i in ids]
        now = [g for g in row.goal_ids or [] if g != entry.root_id]
        if to is not None and to not in was and now[:1] == [to]:
            now = now[1:]
        at = was.index(entry.root_id) if entry.root_id in was else 0
        row.goal_ids = [*now[:at], entry.root_id, *now[at:]]
    await db.flush()
    return []


# Not copied when a restored feature goes onto a version it is not on.
_OWN = frozenset({"id", "roadmap_version_id", "draft_roadmap_id", "simple_draft_id",
                  "created_at", "updated_at", "deleted_at", "deleted_by", "deleted_reason",
                  "trash_entry_id"})  # fmt: skip


async def _person(db: AsyncSession, user_id: uuid.UUID | None) -> uuid.UUID | None:
    """``user_id`` when it is a person's (an entry's deleted_by may be a token's id)."""
    from oracle.auth.models import User

    return user_id if user_id and await db.get(User, user_id) else None


async def _reopened(db: AsyncSession, row: RoadmapItem, principal: Any, entry: TrashEntry) -> Any:
    """A feature only ever in a Simple draft that was approved while it was in Trash (so
    without it): its row moves to the roadmap's open draft, the working one (opened on the
    published version when there is none) or, while one waits for approval, that one; the
    change that added it counts in that draft too, so the draft can be sent with it. A
    draft opened here is a person's, as the rest of Simple: whoever restores it, or for a
    workspace API token (no person), whoever deleted it, else who opened the approved one."""
    from oracle.simple.additions import _shown_version
    from oracle.simple.drafts import OPEN
    from oracle.simple.models import SimpleChange, SimpleDraft

    doc = row.roadmap_document_id
    open_ = list(
        await db.scalars(
            select(SimpleDraft)
            .where(SimpleDraft.document_id == doc, SimpleDraft.status.in_(OPEN))
            .with_for_update()
        )
    )
    d = next((x for x in open_ if x.status == "working"), None) or next(iter(open_), None)
    if d is None:
        me = _me(principal) or await _person(db, entry.deleted_by)
        if me is None:
            own = await db.get(SimpleDraft, row.simple_draft_id) if row.simple_draft_id else None
            me = own.created_by if own else entry.deleted_by
        base = await _shown_version(db, doc, draft=False)
        d = SimpleDraft(document_id=doc, base_version_id=base, status="working", overlay={},
                        created_by=me, participant_ids=[me])  # fmt: skip
        db.add(d)
        await db.flush()
    row.simple_draft_id = d.id
    for c in await db.scalars(
        select(SimpleChange).where(
            SimpleChange.op == "add_item", SimpleChange.target["item_id"].astext == str(row.id)
        )
    ):
        if d.id not in (c.draft_ids or []):
            c.draft_ids = [*(c.draft_ids or []), d.id]
    await db.flush()
    return d


async def _onto_current(
    db: AsyncSession, entry: TrashEntry, principal: Any = None
) -> list[dict[str, Any]]:
    """A version published or proposed while the feature was in Trash was made without it:
    Restore puts a copy of its latest row on the roadmap's published version and on the
    version waiting for approval (a Simple draft in review, a Detailed change set's
    proposal), when newer than the last version it was on and missing it, with its goal,
    dependencies and milestones. An older approved version keeps what it was approved
    with; a version that can no longer be approved (withdrawn from review, superseded, or
    no longer the latest: only the latest is approved) is left as it is. A feature only
    ever in a Simple draft goes back to that draft and onto no version but the draft's
    own version in review, when it was sent for review since; when that draft was approved
    meanwhile, to the roadmap's open draft (:func:`_reopened`), never the published
    version. A dependency on a key no longer on that version (nor in Trash) is dropped,
    and said."""
    from oracle.docs.models import DocumentVersion
    from oracle.roadmap.models import RoadmapChangeSet, TrackMilestone
    from oracle.simple.additions import _shown_version
    from oracle.simple.drafts import withdrawn_message
    from oracle.simple.models import SimpleDraft

    key = entry.root.get("slug")
    doc = entry.root.get("roadmap_id")
    if not key or not doc:
        return []
    doc = uuid.UUID(doc)
    rows = list(
        await db.scalars(
            select(RoadmapItem)
            .outerjoin(DocumentVersion, DocumentVersion.id == RoadmapItem.roadmap_version_id)
            .where(RoadmapItem.roadmap_document_id == doc, RoadmapItem.item_key == key,
                   RoadmapItem.draft_roadmap_id.is_(None))
            .order_by(DocumentVersion.number.desc().nulls_last())
            .execution_options(populate_existing=True)
        )
    )  # fmt: skip
    if not rows:
        return []
    have = {r.roadmap_version_id for r in rows} - {None}
    only: set[uuid.UUID | None] | None = None
    if not have:
        # Only ever in a Simple draft (never approved): its own row is back there. A draft
        # sent for review since has its version in review take it too, and no other version
        # (approving it keeps the version's rows, not the draft's).
        own = rows[0].simple_draft_id
        sent = await db.get(SimpleDraft, own) if own else None
        if sent is None or sent.status not in ("working", "submitted"):
            sent = await _reopened(db, rows[0], principal, entry)
        if sent.status != "submitted" or sent.version_id is None:
            return []
        have, only = {sent.base_version_id} - {None}, {sent.version_id}
    newest = (
        await db.scalar(
            select(func.max(DocumentVersion.number)).where(DocumentVersion.id.in_(have))
        )
        or 0
    )
    latest = await db.scalar(
        select(DocumentVersion).where(DocumentVersion.document_id == doc)
        .order_by(DocumentVersion.number.desc()).limit(1)
    )  # fmt: skip
    targets = {await _shown_version(db, doc, draft=False)}
    superseded = await db.scalar(
        select(RoadmapChangeSet.id).where(
            RoadmapChangeSet.status == "superseded",
            RoadmapChangeSet.proposed_version_id == latest.id,
        )
    )
    if (
        latest.approved_at is None
        and await withdrawn_message(db, latest) is None
        and superseded is None
        and await db.scalar(
            select(RoadmapItem.id).where(RoadmapItem.roadmap_version_id == latest.id).limit(1)
        )
    ):
        targets.add(latest.id)
    targets = set(
        await db.scalars(
            select(DocumentVersion.id).where(
                DocumentVersion.id.in_(targets - {None}), DocumentVersion.number > newest
            )
        )
    )
    if only is not None:
        targets &= only
    if not targets:
        return []
    drafts_ = list(
        await db.scalars(
            select(SimpleDraft).where(
                SimpleDraft.document_id == doc, SimpleDraft.status == "working"
            )
        )
    )
    src, kept = rows[0], await trashed_keys(db, doc)
    added = {d.base_version_id: d.id for d in drafts_}
    dropped: dict[str, str] = {}
    copies = []
    for version in sorted(targets):
        on_it = RoadmapItem.roadmap_version_id == version
        if version in added:
            on_it |= RoadmapItem.simple_draft_id == added[version]
        on = set(await db.scalars(select(RoadmapItem.item_key).where(on_it)))
        deps = [k for k in src.depends_on or [] if k in on or k in kept]
        dropped |= {k: k for k in src.depends_on or [] if k not in deps}
        fields = {
            c.key: getattr(src, c.key)
            for c in RoadmapItem.__mapper__.column_attrs
            if c.key not in _OWN
        }
        copy = RoadmapItem(**fields | {"roadmap_version_id": version, "depends_on": deps})
        db.add(copy)
        copies.append(copy)
    await db.flush()
    ids = {r.id for r in rows}
    for m in await db.scalars(
        select(TrackMilestone).where(TrackMilestone.item_ids.overlap(list(ids)))
    ):
        m.item_ids = [*m.item_ids, *(c.id for c in copies if c.id not in m.item_ids)]
    for k in dropped:
        title = await db.scalar(
            select(RoadmapItem.title)
            .where(RoadmapItem.roadmap_document_id == doc, RoadmapItem.item_key == k)
            .execution_options(**ALL).limit(1)
        )  # fmt: skip
        dropped[k] = title or k
    await db.flush()
    return [
        {"item": entry.root, "reason": f"It depended on '{name}', which is no longer on the "
                                       "roadmap: it is back without that dependency"}
        for name in dropped.values()
    ]  # fmt: skip


async def before_purge(db: AsyncSession, entry: TrashEntry) -> None:
    """A purged feature leaves nothing pointing at it: its id out of the milestones, its key
    out of the depends_on of the roadmap's other items (every version and draft); a purged
    goal's id leaves the items' goal_ids."""
    from oracle.roadmap.models import TrackMilestone

    if entry.root_type == "goal":
        # Its links go by cascade; the items that name it as their goal drop it.
        for row in await db.scalars(
            select(RoadmapItem).where(RoadmapItem.goal_ids.contains([entry.root_id]))
            .execution_options(**ALL)
        ):  # fmt: skip
            row.goal_ids = [i for i in row.goal_ids if i != entry.root_id]
        await db.flush()
    if entry.root_type != "feature":
        return
    rows = (
        await db.execute(
            select(RoadmapItem.id, RoadmapItem.roadmap_document_id, RoadmapItem.item_key)
            .where(RoadmapItem.trash_entry_id == entry.id)
            .execution_options(**ALL)
        )
    ).all()
    ids = {i for i, _, _ in rows}
    for m in await db.scalars(
        select(TrackMilestone).where(TrackMilestone.item_ids.overlap(list(ids)))
    ):
        m.item_ids = [i for i in m.item_ids if i not in ids]
    for doc, key in {(d, k) for _, d, k in rows}:
        for row in await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_document_id == doc,
                   RoadmapItem.depends_on.contains([key]), RoadmapItem.id.not_in(ids))
            .execution_options(**ALL)
        ):  # fmt: skip
            row.depends_on = [k for k in row.depends_on if k != key]
    await db.flush()


def _may_delete_goal(principal: Any) -> bool:
    return has_role(principal.role, "approver")


async def _propose_goal(
    db: AsyncSession, principal: Any, goal: Entity, to_goal_id: uuid.UUID | None,
    reason: str | None,
) -> SimpleChange:  # fmt: skip
    """A commenter's goal delete: a proposal to the company's owners (an approver or up
    decides it), as a feature's goes to its decider."""
    from oracle.simple import changes

    open_ = await db.scalar(
        select(SimpleChange.id).where(
            SimpleChange.op == "delete_goal",
            SimpleChange.status == "proposed",
            SimpleChange.target["goal_id"].astext == str(goal.id),
        )
    )
    if open_ is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Moving this to Trash is proposed already")
    to = str(to_goal_id) if to_goal_id else None
    c = SimpleChange(
        document_id=None, op="delete_goal",
        target={"goal_id": str(goal.id), "title": goal.title, "to_goal_id": to},
        before={"deleted": False}, after={"deleted": True}, status="proposed",
        by=_me(principal), at=company_time.now(), reason=reason,
        routed_to=await changes._company_owners(db),
    )  # fmt: skip
    db.add(c)
    await db.flush()
    await audit.record(db, principal, "simple_change.proposed", "simple_change", c.id,
                       data={"op": c.op, "target": c.target})  # fmt: skip
    return c


def may_decide_goal(principal: Any) -> bool:
    return _may_delete_goal(principal)


async def _decide_goal(
    db: AsyncSession, principal: Any, c: SimpleChange, action: str, reason: str | None
) -> Any:
    from oracle.simple import goal_buckets
    from oracle.simple.changes import ChangeError, one_out
    from oracle.simple.schemas import SimpleChangeResult

    if not _may_delete_goal(principal):
        raise ChangeError(403, "Only an approver or an owner decides on deleting a goal")
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    goal = await db.get(Entity, uuid.UUID(c.target["goal_id"]))
    if goal is None:
        if await _in_trash(db, Entity, c.target["goal_id"]):
            return await _closed(db, principal, c)
        raise ChangeError(404, "The goal is gone")
    if action == "accept":
        to = c.target.get("to_goal_id")
        to_goal = await db.get(Entity, uuid.UUID(to)) if to else None
        live_to = to_goal is not None and to_goal.type == "goal" and to_goal.status != "rejected"
        await trash_goal(db, principal, await goal_buckets._entity(db, goal.id, "goal"),
                         to_goal.id if live_to else None, c.reason)  # type: ignore[union-attr]  # fmt: skip
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = _me(principal), company_time.now(), reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])


def _restores(principal: Any, entry: TrashEntry | None) -> bool:
    if entry is None:
        return has_role(principal.role, "owner")
    return trash.may_restore(principal, entry)


def _entry_out(entry: TrashEntry) -> TrashEntryOut:
    from oracle.trash.router import _entry_out as out

    return out(entry, can_restore=True)


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
async def restore_item(item_id: uuid.UUID, db: TenantDB, principal: Commenter) -> TrashEntryOut:
    """Put the feature back from Trash with its links, goal and milestone: an owner, or
    whoever deleted it."""
    return await _restore(db, principal, "feature", item_id)


@router.delete(
    "/goal-buckets/goals/{goal_id}", response_model=TrashedOut, name="delete_bucket_goal"
)
async def delete_goal(
    goal_id: uuid.UUID,
    db: TenantDB,
    principal: Commenter,
    to_goal_id: uuid.UUID | None = None,
    reason: Reason = None,
) -> TrashedOut:
    """Move the goal to Trash; its features move to ``to_goal_id`` when one is picked, as
    Archive moves them. A commenter proposes it instead (``change``); viewers are refused."""
    from oracle.simple import changes, goal_buckets

    g = await goal_buckets._entity(db, goal_id, "goal")
    if to_goal_id is not None:
        to = await goal_buckets._entity(db, to_goal_id, "goal")
        if to.id == g.id or to.status == "rejected":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Pick another goal")
    if not _may_delete_goal(principal):
        c = await _propose_goal(db, principal, g, to_goal_id, reason)
        await db.commit()
        return TrashedOut(change=await changes.one_out(db, principal, c))
    entry = await trash_goal(db, principal, g, to_goal_id, reason)
    out = TrashedOut(entry=_entry_out(entry), can_restore=_restores(principal, entry))
    await db.commit()
    return out


@router.post(
    "/goal-buckets/goals/{goal_id}/restore",
    response_model=TrashEntryOut,
    name="restore_bucket_goal",
)
async def restore_goal(goal_id: uuid.UUID, db: TenantDB, principal: Commenter) -> TrashEntryOut:
    """Put the goal back from Trash with its order, measure, target and due: an owner, or
    whoever deleted it."""
    return await _restore(db, principal, "goal", goal_id)


async def _restore(db: TenantDB, principal: Any, root_type: str, ref: uuid.UUID) -> TrashEntryOut:
    from oracle.trash.router import _entry_out as out

    entry, not_restored = await _call(trash.restore_root(db, principal, root_type, str(ref)))
    res = out(entry, not_restored)
    await db.commit()
    return res
