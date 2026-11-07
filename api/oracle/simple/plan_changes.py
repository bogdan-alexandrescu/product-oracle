"""removed-tracks: what was removed put back, and tracks added, edited and deleted, through
the change engine (``POST /v1/simple/changes``, wired in ``oracle.simple.changes``).

- An archived goal comes back through ``oracle.simple.goal_asks``' ``unarchive_goal``
  (this line's Archive and Restore of a goal).
- ``restore_goal_milestone`` (target ``{milestone_id}``): a removed goal milestone comes
  back, any time after it was removed. Who changes the roadmap directly
  (``drafts.can_edit``) applies it; else it is proposed as a key date's change is
  (``key_dates.route``).
- ``add_track`` (after ``{title, prd_id, owner_id?}``): a track for an accepted PRD with
  none (a track is its PRD's: ``prd_id`` is required). An owner applies it; else it is
  proposed to the company's owners.
- ``edit_track`` (target ``{track_id}``, after any of ``{title, owner_id, status}``) and
  ``delete_track`` (target ``{track_id}``; the track goes to Settings > Trash, its
  features to no track): an owner, or the track's own owner while an approver or owner,
  applies it; else it is proposed to the track's owner (an approver or owner), else to
  the company's owners.

Each applied change undoes (``POST /v1/simple/changes/{id}/undo``) by whom made it, at
any time, while what it changed is as it left it.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs.models import Document
from oracle.members.names import display_name
from oracle.roadmap.models import TRACK_STATUSES, ProductTrack, TrackMilestone
from oracle.simple import drafts
from oracle.simple.models import SimpleChange

OPS: frozenset[str] = frozenset(
    {"restore_goal_milestone", "add_track", "edit_track", "delete_track"}
)
TRACK_OPS = ("edit_track", "delete_track")
TRACK_FIELDS = ("title", "owner_id", "status")


def _err(code: int, detail: Any) -> Exception:
    from oracle.simple.changes import ChangeError

    return ChangeError(code, detail)


def _me(principal: Any) -> uuid.UUID | None:
    return getattr(principal, "user_id", None)


def _id(value: Any, name: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise _err(422, f"{name}: an id") from None


async def company_owners(db: AsyncSession) -> list[uuid.UUID]:
    from oracle.simple.changes import _company_owners

    return await _company_owners(db)


async def member(db: AsyncSession, user_id: uuid.UUID | None) -> User | None:
    """An enabled member of the company, or None."""
    if user_id is None:
        return None
    u = await db.scalar(select(User).where(User.id == user_id))
    return u if u is not None and getattr(u, "disabled_at", None) is None else None


async def name_of(db: AsyncSession, user_id: uuid.UUID | None) -> str | None:
    u = await member(db, user_id)
    return display_name(u.email, u.name) if u is not None else None


# --------------------------------------------------------------------------- who


async def track_decider(db: AsyncSession, track: ProductTrack) -> list[uuid.UUID]:
    """A track's change waits for its owner (an approver or owner), else the company's
    owners."""
    owner = await member(db, track.owner_id)
    if owner is not None and has_role(owner.role, "approver"):
        return [owner.id]
    return await company_owners(db)


def decides_track(principal: Any, track: ProductTrack) -> bool:
    """An owner; the track's own owner while an approver or owner."""
    if has_role(principal.role, "owner"):
        return True
    me = _me(principal)
    return me is not None and track.owner_id == me and has_role(principal.role, "approver")


def may_decide(principal: Any, c: SimpleChange) -> bool:
    """Who decides a proposal: an owner; for a track's or a milestone's, whom it waits for
    (the track's owner, the roadmap's decider)."""
    if has_role(principal.role, "owner"):
        return True
    me = _me(principal)
    if me is None or c.op not in (*TRACK_OPS, "restore_goal_milestone"):
        return False
    return me in (c.routed_to or []) and has_role(principal.role, "approver")


# --------------------------------------------------------------------------- reading rows


async def _milestone(db: AsyncSession, milestone_id: uuid.UUID) -> TrackMilestone:
    row = await db.get(TrackMilestone, milestone_id, with_for_update=True)
    if row is None or row.roadmap_id is None:
        raise _err(404, "No such milestone")
    return row


async def _track(db: AsyncSession, track_id: uuid.UUID) -> ProductTrack:
    t = await db.scalar(select(ProductTrack).where(ProductTrack.id == track_id).with_for_update())
    if t is None:
        raise _err(404, "No such track")
    return t


def _iso(at: datetime | None) -> str | None:
    return at.isoformat() if at else None


def _track_value(t: ProductTrack) -> dict[str, Any]:
    return {"title": t.title, "owner_id": str(t.owner_id) if t.owner_id else None,
            "status": t.status}  # fmt: skip


async def _wanted_track(db: AsyncSession, after: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "title" in after:
        title = " ".join(str(after["title"] or "").split())
        if not title or len(title) > 200:
            raise _err(422, "after.title: a name (up to 200 characters)")
        out["title"] = title
    if "owner_id" in after:
        if after["owner_id"] is None:
            out["owner_id"] = None
        else:
            owner = await member(db, _id(after["owner_id"], "after.owner_id"))
            if owner is None:
                raise _err(422, "after.owner_id: not an enabled member of this company")
            out["owner_id"] = str(owner.id)
    if "status" in after:
        if after["status"] not in TRACK_STATUSES:
            raise _err(422, f"after.status: one of {', '.join(TRACK_STATUSES)}")
        out["status"] = after["status"]
    return out


async def free_prds(db: AsyncSession) -> list[Document]:
    """The PRDs a new track can take: accepted (an approved version), with no track, not
    one in Trash either."""
    from oracle.docs.models import DocumentVersion
    from oracle.trash.filter import INCLUDE_TRASHED

    taken = set(
        await db.scalars(
            select(ProductTrack.prd_document_id).execution_options(**{INCLUDE_TRASHED: True})
        )
    )
    approved = select(DocumentVersion.document_id).where(DocumentVersion.approved_at.is_not(None))
    rows = await db.scalars(
        select(Document)
        .where(Document.kind == "prd", Document.id.in_(approved))
        .order_by(Document.title, Document.id)
    )
    return [d for d in rows if d.id not in taken]


# --------------------------------------------------------------------------- create


async def create_change(db: AsyncSession, principal: Any, body: Any) -> Any:
    from oracle.simple import key_dates
    from oracle.simple.changes import one_out
    from oracle.simple.schemas import SimpleChangeResult

    if not has_role(principal.role, "commenter"):
        raise _err(403, "Viewers may not change or propose a change")
    me, now = _me(principal), company_time.now()
    target: dict[str, Any] = {}
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    document_id = None
    if body.op == "restore_goal_milestone":
        row = await _milestone(db, _id(body.target.get("milestone_id"), "milestone_id"))
        if row.deleted_at is None:
            raise _err(409, "This milestone is not removed")
        w = await drafts.who(db, {row.roadmap_id})
        target = {"milestone_id": str(row.id), "roadmap_id": str(row.roadmap_id),
                  "name": row.name}  # fmt: skip
        before = {"removed": True, "deleted_at": _iso(row.deleted_at),
                  "deleted_by": str(row.deleted_by) if row.deleted_by else None}  # fmt: skip
        after = {"removed": False}
        document_id = row.roadmap_id
        applies = drafts.can_edit(principal, row.roadmap_id, w)  # type: ignore[arg-type]
        route = [] if applies else await key_dates.route(db, row.roadmap_id, w)  # type: ignore[arg-type]
    elif body.op == "add_track":
        wanted = await _wanted_track(db, {k: body.after[k] for k in ("title", "owner_id")
                                          if k in body.after})  # fmt: skip
        if "title" not in wanted:
            raise _err(422, "after.title: the track's name")
        if not body.after.get("prd_id"):
            raise _err(422, "after.prd_id: a track is its PRD's; pick an accepted PRD")
        prd_id = _id(body.after["prd_id"], "after.prd_id")
        if prd_id not in {d.id for d in await free_prds(db)}:
            raise _err(409, "That PRD has a track already, or is not accepted yet")
        prd = await db.get(Document, prd_id)
        target = {"prd_id": str(prd_id), "prd_title": prd.title if prd else None}
        after = {**wanted, "prd_id": str(prd_id)}
        if wanted.get("owner_id"):
            target["owner_name"] = await name_of(db, uuid.UUID(wanted["owner_id"]))
        applies = has_role(principal.role, "owner")
        route = [] if applies else await company_owners(db)
    else:
        t = await _track(db, _id(body.target.get("track_id"), "track_id"))
        target = {"track_id": str(t.id), "title": t.title}
        if body.op == "edit_track":
            wanted = await _wanted_track(db, {k: body.after[k] for k in TRACK_FIELDS
                                              if k in body.after})  # fmt: skip
            current = _track_value(t)
            wanted = {k: v for k, v in wanted.items() if current[k] != v}
            if not wanted:
                raise _err(422, "after: nothing changes (title, owner_id or status)")
            before = {k: current[k] for k in wanted}
            after = wanted
            if wanted.get("owner_id"):
                target["owner_name"] = await name_of(db, uuid.UUID(wanted["owner_id"]))
        applies = decides_track(principal, t)
        route = [] if applies else await track_decider(db, t)
    c = SimpleChange(document_id=document_id, op=body.op, target=target, before=before,
                     after=after, status="applied" if applies else "proposed", by=me,
                     at=now, reason=body.reason, routed_to=route)  # fmt: skip
    if applies:
        await _apply(db, principal, c)
    db.add(c)
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "before": c.before,
                             "after": c.after})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])


# --------------------------------------------------------------------------- apply


async def _apply(db: AsyncSession, principal: Any, c: SimpleChange) -> None:
    """Write the change; 409 when what it changes is not as it was when made."""
    from oracle.roadmap import tracks
    from oracle.simple import goal_milestones
    from oracle.trash import service as trash

    if c.op == "restore_goal_milestone":
        row = await _milestone(db, uuid.UUID(c.target["milestone_id"]))
        if row.deleted_at is None:
            raise _err(409, "outdated: the milestone is back already")
        await goal_milestones.put_back(db, row)
        await trash.milestone_restored(db, row.id)
    elif c.op == "add_track":
        prd_id = uuid.UUID(c.after["prd_id"])
        prd = await db.get(Document, prd_id)
        version = await tracks.latest_approved(db, prd_id) if prd is not None else None
        if prd is None or version is None:
            raise _err(409, "outdated: the PRD is gone or has no accepted version")
        if await tracks.any_track_of_prd(db, prd_id) is not None:
            raise _err(409, "outdated: that PRD has a track already")
        t, _ = await tracks.ensure_track(db, prd, version, actor=principal, cause="started")
        t.title = c.after["title"]
        if c.after.get("owner_id"):
            t.owner_id = uuid.UUID(c.after["owner_id"])
        await db.flush()
        c.after = {**c.after, "track_id": str(t.id)}
    elif c.op == "edit_track":
        t = await _track(db, uuid.UUID(c.target["track_id"]))
        current = _track_value(t)
        if any(current[k] != v for k, v in c.before.items()):
            raise _err(409, {"message": "outdated: the track changed since", "current": current,
                             "changed_by": None, "changed_at": None})  # fmt: skip
        _write_track(t, c.after)
    elif c.op == "delete_track":
        t = await _track(db, uuid.UUID(c.target["track_id"]))
        entry = await trash.delete_track(db, principal, t)
        c.after = {**(c.after or {}), "trash_entry_id": str(entry.id)}


async def _holds_anything(db: AsyncSession, track_id: uuid.UUID) -> bool:
    """Anything references the track (one in Trash too): a milestone, a tracker link, a
    feature, an alert (deleted with it), a launch or an outcome (unlinked by a delete)."""
    from oracle.launches.models import Launch
    from oracle.quality.models import OutcomeRecord
    from oracle.roadmap.models import RoadmapItem, TrackAlert, TrackerRecord
    from oracle.trash.filter import INCLUDE_TRASHED

    for model in (TrackMilestone, TrackerRecord, RoadmapItem, TrackAlert, Launch, OutcomeRecord):
        found = await db.scalar(
            select(model.id)
            .where(model.track_id == track_id)
            .limit(1)
            .execution_options(**{INCLUDE_TRASHED: True})
        )
        if found is not None:
            return True
    return False


def _write_track(t: ProductTrack, values: dict[str, Any]) -> None:
    for k, v in values.items():
        setattr(t, k, uuid.UUID(v) if k == "owner_id" and v else v)
    t.lock_version += 1


# --------------------------------------------------------------------------- decide / undo


async def decide(db: AsyncSession, principal: Any, c: SimpleChange, action: str,
                 reason: str | None) -> Any:  # fmt: skip
    from oracle.simple.changes import one_out
    from oracle.simple.schemas import SimpleChangeResult

    if not may_decide(principal, c):
        raise _err(403, "Only an owner or whom this waits for decides it")
    if c.status != "proposed":
        raise _err(409, f"This change is {c.status} already")
    if action == "accept":
        await _apply(db, principal, c)
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = _me(principal), company_time.now(), reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])


async def undo(db: AsyncSession, principal: Any, c: SimpleChange) -> Any:
    """Put back what an applied change changed, by who made it."""
    from oracle.simple.changes import one_out
    from oracle.simple.schemas import SimpleChangeResult
    from oracle.trash import service as trash

    me, now = _me(principal), company_time.now()
    if c.status != "applied":
        raise _err(409, f"Only an applied change undoes; this one is {c.status}")
    if c.by != me:
        raise _err(403, "Only the person who made a change undoes it")
    if await db.scalar(select(SimpleChange.id).where(SimpleChange.undoes_id == c.id)):
        raise _err(409, "This change is undone already")
    undone_after: dict[str, Any] = {}
    if c.op == "restore_goal_milestone":
        row = await _milestone(db, uuid.UUID(c.target["milestone_id"]))
        if row.deleted_at is not None:
            raise _err(409, "Changed since: the milestone is removed again")
        row.deleted_at = now
        row.deleted_by = me
    elif c.op == "add_track":
        t = await db.scalar(
            select(ProductTrack).where(ProductTrack.id == uuid.UUID(c.after["track_id"]))
        )
        if t is None:
            raise _err(409, "Changed since: the track is gone")
        if await _holds_anything(db, t.id):
            # Never hard-deleted once it holds anything: it goes to Trash, restorable.
            entry = await trash.delete_track(db, principal, t)
            undone_after = {"in_trash": True, "trash_entry_id": str(entry.id)}
        else:
            await db.delete(t)
    elif c.op == "edit_track":
        t = await _track(db, uuid.UUID(c.target["track_id"]))
        current = _track_value(t)
        if any(current[k] != v for k, v in c.after.items()):
            raise _err(409, {"message": "Changed since", "current": current,
                             "changed_by": None, "changed_at": None})  # fmt: skip
        _write_track(t, c.before)
    elif c.op == "delete_track":
        from oracle.trash.models import TrashEntry

        entry_id = uuid.UUID(c.after["trash_entry_id"])
        if await db.get(TrashEntry, entry_id) is None:
            raise _err(409, "Changed since: the track is no longer in Trash")
        await trash.restore_entry(db, principal, entry_id)
    u = SimpleChange(session_id=c.session_id, document_id=c.document_id, op=c.op,
                     target=c.target, before=c.after, after={**c.before, **undone_after},
                     status="undone", by=me,
                     at=now, undoes_id=c.id, routed_to=[])  # fmt: skip
    db.add(u)
    await db.flush()
    await audit.record(db, principal, "simple_change.undone", "simple_change", u.id,
                       data={"op": c.op, "target": c.target, "undoes_id": str(c.id)})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, u), flags=[])


# --------------------------------------------------------------------------- words


def phrase(op: str, target: dict, before: dict, after: dict, item: str | None = None) -> str:
    """In plain words, without who (``item``: the name when the change names none)."""
    title = target.get("title") or item or "a track"
    match op:
        case "restore_goal_milestone":
            return f"restored the milestone {target.get('name') or item or ''}".rstrip()
        case "add_track":
            return f"added the track {after.get('title') or item or ''}".rstrip()
        case "delete_track":
            return f"moved the track {title} to Trash"
        case "edit_track":
            parts = []
            if "title" in after and after.get("title") != before.get("title"):
                parts.append(f"renamed the track {before.get('title') or title} to "
                             f"{after['title']}")  # fmt: skip
                title = after["title"]
            if "owner_id" in after:
                who = target.get("owner_name") if after.get("owner_id") else None
                parts.append(f"set {title}'s owner to {who}" if who
                             else f"took the owner off {title}")  # fmt: skip
            if "status" in after:
                verb = {"paused": "paused", "closed": "closed"}.get(after["status"], "reopened")
                parts.append(f"{verb} the track {title}")
            return ", ".join(parts) or f"changed the track {title}"
    return "changed something"
