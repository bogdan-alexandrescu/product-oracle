"""removed-tracks: what was removed put back, and tracks added, edited and deleted, through
the change engine (``POST /v1/simple/changes``, wired in ``oracle.simple.changes``).

- An archived goal comes back through ``oracle.simple.goal_asks``' ``unarchive_goal``
  (this line's Archive and Restore of a goal).
- ``restore_goal_milestone`` (target ``{milestone_id}``): a removed goal milestone comes
  back, any time after it was removed. Who changes the roadmap directly
  (``drafts.can_edit``) applies it; else it is proposed as a key date's change is
  (``key_dates.route``).
- ``add_track`` (after ``{title, prd_ids?, owner_id?, goal_id?}``; ``prd_id`` is one PRD):
  a track for accepted PRDs, or for none (tracks-goal, owner Nov 9: a track holds many PRDs,
  a PRD has at most one track: one on another track moves from it, and an undo puts it
  back), tied to a company goal or none. An owner applies it; else it is proposed to the
  company's owners.
- ``edit_track`` (target ``{track_id}``, after any of ``{title, owner_id, status, prd_ids,
  goal_id}``; a PRD taken off is off any track: Oracle starts or suggests none for it) and
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
from oracle.baseline.models import Entity
from oracle.docs.models import Document
from oracle.members.names import display_name
from oracle.roadmap.models import TRACK_STATUSES, ProductTrack, TrackMilestone
from oracle.simple import drafts
from oracle.simple.models import SimpleChange

OPS: frozenset[str] = frozenset(
    {"restore_goal_milestone", "add_track", "edit_track", "delete_track"}
)
TRACK_OPS = ("edit_track", "delete_track")
# tracks-goal (owner Nov 9): ``prd_ids``, the track's PRDs (a track holds many).
TRACK_FIELDS = ("title", "owner_id", "status", "prd_ids", "goal_id")


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


def _str(v: uuid.UUID | None) -> str | None:
    return str(v) if v else None


def _track_value(t: ProductTrack) -> dict[str, Any]:
    return {"title": t.title, "owner_id": _str(t.owner_id), "status": t.status,
            "prd_ids": sorted(str(p) for p in t.prd_ids), "goal_id": _str(t.goal_id)}  # fmt: skip


async def goal_of(db: AsyncSession, goal_id: uuid.UUID | None) -> Entity | None:
    """A live company goal (not archived, not in Trash), or None."""
    if goal_id is None:
        return None
    return await db.scalar(
        select(Entity).where(
            Entity.id == goal_id, Entity.type == "goal", Entity.status != "rejected"
        )  # fmt: skip
    )


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
    if "goal_id" in after:
        if after["goal_id"] is None:
            out["goal_id"] = None
        else:
            goal = await goal_of(db, _id(after["goal_id"], "after.goal_id"))
            if goal is None:
                raise _err(422, "after.goal_id: not one of this company's goals")
            out["goal_id"] = str(goal.id)
    if "prd_id" in after:
        # The one-PRD form: that PRD alone (none: no PRD).
        after = {**after, "prd_ids": [after["prd_id"]] if after["prd_id"] else []}
    if "prd_ids" in after:
        if not isinstance(after["prd_ids"], list):
            raise _err(422, "after.prd_ids: a list of PRD ids")
        out["prd_ids"] = sorted({str(_id(p, "after.prd_ids")) for p in after["prd_ids"]})
    return out


async def _check_prds(db: AsyncSession, t: ProductTrack | None, prd_ids: list[str] | None) -> None:
    """A PRD put on a track is accepted, and on no track in Trash (one on another track
    moves from it)."""
    if not prd_ids:
        return
    takeable = {d.id for d, _ in await takeable_prds(db)}
    held = set(t.prd_ids) if t is not None else set()
    if any(uuid.UUID(p) not in takeable | held for p in prd_ids):
        raise _err(409, "That PRD is in Trash with its track, or is not accepted yet")


async def _prior(db: AsyncSession, prd_ids: list[str]) -> dict[str, Any]:
    """Where each PRD is now (its track and state; none: no row), so an undo puts it back."""
    from oracle.roadmap import tracks

    out: dict[str, Any] = {}
    for p in prd_ids:
        link = await tracks.link_of(db, uuid.UUID(p))
        out[p] = {"track_id": _str(link.track_id), "state": link.state} if link else None
    return out


def _one_prd(after: dict[str, Any]) -> tuple[str, str] | None:
    """An edit_track that puts one PRD on (``add_prd_id``) or takes one off
    (``remove_prd_id``): its key and the PRD."""
    for key in ("add_prd_id", "remove_prd_id"):
        if after.get(key):
            return key, str(_id(after[key], f"after.{key}"))
    return None


def _prds_of(op: str, after: dict[str, Any]) -> set[str]:
    """The PRDs a track change puts on or takes off a track (a whole list: each it names)."""
    if op not in ("add_track", "edit_track"):
        return set()
    one = _one_prd(after)
    return {one[1]} if one else set(after.get("prd_ids") or [])


async def _asked(db: AsyncSession, prd_ids: set[str]) -> bool:
    """A proposed track change, not decided yet, for any of these PRDs."""
    if not prd_ids:
        return False
    open_ = await db.scalars(
        select(SimpleChange).where(
            SimpleChange.status == "proposed", SimpleChange.op.in_(("add_track", "edit_track"))
        )
    )
    return any(prd_ids & _prds_of(c.op, c.after or {}) for c in open_)


async def _close_asked(db: AsyncSession, principal: Any, c: SimpleChange) -> None:
    """tracks-goal: a PRD put on a track directly (each in ``prior``, where it was) closes
    the open proposal that asked to put it on one: declined by who placed it, so it no
    longer waits for a decision it cannot get."""
    tracked = c.op in ("add_track", "edit_track")
    placed = set((c.target or {}).get("prior") or {}) if tracked else set()
    if not placed:
        return
    for p, asked in (await waiting_for(db)).items():
        if str(p) in placed and asked.status == "proposed":
            asked.status = "declined"
            asked.decided_by, asked.decided_at = _me(principal), company_time.now()
            await audit.record(db, principal, "simple_change.declined", "simple_change",
                               asked.id, data={"op": asked.op, "target": asked.target})  # fmt: skip


async def waiting_for(db: AsyncSession) -> dict[uuid.UUID, SimpleChange]:
    """tracks-goal (owner Nov 9): each PRD a proposed track change puts on a track, by PRD
    (its Inbox suggestion waits for that decision)."""
    out: dict[uuid.UUID, SimpleChange] = {}
    open_ = await db.scalars(
        select(SimpleChange)
        .where(SimpleChange.status == "proposed", SimpleChange.op.in_(("add_track", "edit_track")))
        .order_by(SimpleChange.at)
    )
    for c in open_:
        if c.op == "edit_track" and "remove_prd_id" in (c.after or {}):
            continue
        for p in _prds_of(c.op, c.after or {}):
            out.setdefault(uuid.UUID(p), c)
    return out


async def _named(db: AsyncSession, target: dict[str, Any], wanted: dict[str, Any]) -> None:
    """The names a change's words read (never an id)."""
    if wanted.get("owner_id"):
        target["owner_name"] = await name_of(db, uuid.UUID(wanted["owner_id"]))
    if wanted.get("prd_ids"):
        ids = [uuid.UUID(p) for p in wanted["prd_ids"]]
        docs = await db.scalars(select(Document).where(Document.id.in_(ids)))
        titles = {d.id: d.title for d in docs}
        target["prd_titles"] = {p: titles.get(uuid.UUID(p)) for p in wanted["prd_ids"]}
    if wanted.get("goal_id"):
        goal = await goal_of(db, uuid.UUID(wanted["goal_id"]))
        target["goal_name"] = goal.title if goal else None


async def takeable_prds(db: AsyncSession) -> list[tuple[Document, ProductTrack | None]]:
    """tracks-goal: the PRDs a track can take: accepted (an approved version), with no track
    or on another live track (it moves from there); never one whose track is in Trash. Each
    with the track it is on now."""
    from oracle.docs.models import DocumentVersion
    from oracle.roadmap import tracks

    approved = select(DocumentVersion.document_id).where(DocumentVersion.approved_at.is_not(None))
    rows = list(
        await db.scalars(
            select(Document)
            .where(Document.kind == "prd", Document.id.in_(approved))
            .order_by(Document.title, Document.id)
        )
    )
    on = await tracks.tracks_of_prds(db, [d.id for d in rows], trashed=True)
    return [(d, on.get(d.id)) for d in rows if d.id not in on or on[d.id].deleted_at is None]


async def free_prds(db: AsyncSession) -> list[Document]:
    """The accepted PRDs on no track (one in Trash either)."""
    return [d for d, t in await takeable_prds(db) if t is None]


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
        # tracks-goal: its PRD and its goal are optional.
        wanted = await _wanted_track(db, {k: body.after[k] for k in ("title", "owner_id",
                                          "prd_id", "prd_ids", "goal_id")
                                          if body.after.get(k)})  # fmt: skip
        if "title" not in wanted:
            raise _err(422, "after.title: the track's name")
        await _check_prds(db, None, wanted.get("prd_ids"))
        target = {"prd_ids": wanted.get("prd_ids", []),
                  "prior": await _prior(db, wanted.get("prd_ids", []))}  # fmt: skip
        await _named(db, target, wanted)
        after = {**wanted, "prd_ids": wanted.get("prd_ids", [])}
        applies = has_role(principal.role, "owner")
        route = [] if applies else await company_owners(db)
    else:
        t = await _track(db, _id(body.target.get("track_id"), "track_id"))
        target = {"track_id": str(t.id), "title": t.title}
        if body.op == "edit_track" and (one := _one_prd(body.after)):
            # tracks-goal: one PRD put on the track (an Inbox suggestion confirmed) or taken
            # off it. The change holds only that PRD, so accepting it later leaves the
            # track's other PRDs as they are then.
            key, p = one
            held = [str(x) for x in t.prd_ids]
            if (key == "add_prd_id") == (p in held):
                raise _err(422, f"after.{key}: that PRD is {'on' if p in held else 'not on'} "
                                "the track already")  # fmt: skip
            if key == "add_prd_id":
                await _check_prds(db, t, [p])
                target["prior"] = await _prior(db, [p])
            after = {key: p}
            await _named(db, target, {"prd_ids": [p]})
        elif body.op == "edit_track":
            given = dict(body.after)
            wanted = await _wanted_track(db, {k: given[k] for k in (*TRACK_FIELDS, "prd_id")
                                              if k in given})  # fmt: skip
            current = _track_value(t)
            wanted = {k: v for k, v in wanted.items() if current[k] != v}
            if not wanted:
                raise _err(422, "after: nothing changes (title, owner_id, status, prd_ids or "
                                "goal_id)")  # fmt: skip
            await _check_prds(db, t, wanted.get("prd_ids"))
            if "prd_ids" in wanted:
                moved = [p for p in wanted["prd_ids"] if p not in current["prd_ids"]]
                target["prior"] = await _prior(db, moved)
            before = {k: current[k] for k in wanted}
            after = wanted
            both = [*before.get("prd_ids", []), *wanted.get("prd_ids", [])]
            await _named(db, target, {**wanted, "prd_ids": both})
        applies = decides_track(principal, t)
        route = [] if applies else await track_decider(db, t)
    if not applies and await _asked(db, _prds_of(body.op, after)):
        # tracks-goal (owner Nov 9): one proposal at a time for a PRD's track.
        raise _err(409, "A change to that PRD's track waits for a decision already")
    c = SimpleChange(document_id=document_id, op=body.op, target=target, before=before,
                     after=after, status="applied" if applies else "proposed", by=me,
                     at=now, reason=body.reason, routed_to=route)  # fmt: skip
    if applies:
        await _apply(db, principal, c)
        await _close_asked(db, principal, c)
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
        await _check_prds(db, None, c.after.get("prd_ids"))
        c.target = {**c.target, "prior": await _prior(db, c.after.get("prd_ids") or [])}
        t = ProductTrack(title=c.after["title"], status="active", created_by=_me(principal))
        db.add(t)
        await db.flush()
        await db.refresh(t, ["prd_links"])
        for p in c.after.get("prd_ids") or []:
            # tracks-goal: each PRD joins it (moving from its track) as a started track
            # takes it: its roadmap and its issues.
            await tracks.link_prd(db, t, uuid.UUID(p))
        t.title = c.after["title"]
        if c.after.get("owner_id"):
            t.owner_id = uuid.UUID(c.after["owner_id"])
        if c.after.get("goal_id"):
            if await goal_of(db, uuid.UUID(c.after["goal_id"])) is None:
                raise _err(409, "outdated: that goal is archived or gone")
            t.goal_id = uuid.UUID(c.after["goal_id"])
        await db.flush()
        c.after = {**c.after, "track_id": str(t.id)}
    elif c.op == "edit_track" and (one := _one_prd(c.after)):
        t = await _track(db, uuid.UUID(c.target["track_id"]))
        key, p = one
        held = [str(x) for x in t.prd_ids]
        if (key == "add_prd_id") == (p in held):
            raise _err(409, "outdated: that PRD's track changed since")
        if key == "add_prd_id":
            await _check_prds(db, t, [p])
            c.target = {**c.target, "prior": await _prior(db, [p])}
        await _write_track(db, t, {"prd_ids": [*held, p] if key == "add_prd_id"
                                   else [x for x in held if x != p]})  # fmt: skip
    elif c.op == "edit_track":
        t = await _track(db, uuid.UUID(c.target["track_id"]))
        current = _track_value(t)
        if any(current[k] != v for k, v in c.before.items()):
            raise _err(409, {"message": "outdated: the track changed since", "current": current,
                             "changed_by": None, "changed_at": None})  # fmt: skip
        await _check_prds(db, t, c.after.get("prd_ids"))
        if c.after.get("goal_id") and await goal_of(db, uuid.UUID(c.after["goal_id"])) is None:
            raise _err(409, "outdated: that goal is archived or gone")
        if "prd_ids" in c.after:
            # Where each PRD it puts on the track is as it applies, for an undo.
            moved = [p for p in c.after["prd_ids"] if p not in current["prd_ids"]]
            c.target = {**c.target, "prior": await _prior(db, moved)}
        await _write_track(db, t, c.after)
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


async def _following(db: AsyncSession, t: ProductTrack) -> uuid.UUID | None:
    from oracle.docs.models import DocumentVersion

    return await db.scalar(
        select(DocumentVersion.document_id).where(DocumentVersion.id == t.current_version_id)
    )


async def _put_back(db: AsyncSession, prior: dict[str, Any], t: ProductTrack) -> None:
    """Undo: each PRD a change put on ``t`` goes back where it was (its old track, if that
    still holds nothing in Trash; off; suggested; or no row)."""
    from oracle.roadmap import tracks

    for p, was in prior.items():
        prd = uuid.UUID(p)
        now = await tracks.link_of(db, prd)
        if now is not None and now.track_id not in (None, t.id):
            continue  # another track took it since
        old_id = (was or {}).get("track_id")
        old = await db.get(ProductTrack, uuid.UUID(old_id)) if old_id else None
        if old is not None:
            await tracks.set_link(db, prd, old.id, "linked")
        elif was is not None:
            # Its old track is gone: off any track.
            await tracks.set_link(db, prd, None, "off" if old_id else was["state"])
        elif (link := await tracks.link_of(db, prd)) is not None:
            await db.delete(link)
            await db.flush()
            await tracks.refresh(db, t.id)


async def _write_track(db: AsyncSession, t: ProductTrack, values: dict[str, Any]) -> None:
    from oracle.roadmap import tracks

    for k, v in values.items():
        if k == "prd_ids":
            # tracks-goal: a PRD taken off the track is off any track (Oracle starts or
            # suggests none for it again); one put on joins it, moving from its track.
            wanted = [uuid.UUID(p) for p in v]
            for p in [p for p in t.prd_ids if p not in wanted]:
                await tracks.set_link(db, p, None, "off")
            for p in [p for p in wanted if p not in t.prd_ids]:
                await tracks.link_prd(db, t, p)
            if (lead := next(iter(t.prd_ids), None)) is None:
                t.current_version_id = t.started_version_id = None
            elif await tracks.lead_prd(db, t) != await _following(db, t):
                version = await tracks.latest_approved(db, lead)
                t.current_version_id = version.id if version else None
        else:
            setattr(t, k, uuid.UUID(v) if k in ("owner_id", "goal_id") and v else v)
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
    from oracle.roadmap import tracks
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
        # tracks-goal: its PRDs go back where they were (a moved one to its old track).
        await _put_back(db, c.target.get("prior") or {}, t)
        if await _holds_anything(db, t.id):
            # Never hard-deleted once it holds anything: it goes to Trash, restorable.
            entry = await trash.delete_track(db, principal, t)
            undone_after = {"in_trash": True, "trash_entry_id": str(entry.id)}
        else:
            await db.delete(t)
    elif c.op == "edit_track" and (one := _one_prd(c.after)):
        t = await _track(db, uuid.UUID(c.target["track_id"]))
        key, p = one
        held = [str(x) for x in t.prd_ids]
        if (key == "add_prd_id") != (p in held):
            raise _err(409, "Changed since: that PRD's track changed")
        if key == "add_prd_id":
            await _write_track(db, t, {"prd_ids": [x for x in held if x != p]})
            await _put_back(db, c.target.get("prior") or {}, t)
        else:
            link = await tracks.link_of(db, uuid.UUID(p))
            if link is not None and link.state == "linked":
                raise _err(409, "Changed since: that PRD has another track now")
            await _write_track(db, t, {"prd_ids": [*held, p]})
    elif c.op == "edit_track":
        t = await _track(db, uuid.UUID(c.target["track_id"]))
        current = _track_value(t)
        if any(current[k] != v for k, v in c.after.items()):
            raise _err(409, {"message": "Changed since", "current": current,
                             "changed_by": None, "changed_at": None})  # fmt: skip
        # A PRD put back is one no other track took since; a goal put back may be archived
        # since (it reads as no goal until restored).
        if "prd_ids" in c.before:
            for p in c.before["prd_ids"]:
                if p in c.after["prd_ids"]:
                    continue
                link = await tracks.link_of(db, uuid.UUID(p))
                if link is not None and link.state == "linked":
                    raise _err(409, "Changed since: that PRD has another track now")
        await _write_track(db, t, c.before)
        await _put_back(db, c.target.get("prior") or {}, t)
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
            names = target.get("prd_titles") or {}
            for key, verb, word in (("add_prd_id", "put", "on"), ("remove_prd_id", "took", "off")):
                # tracks-goal: one PRD put on or taken off (an undo reads it as before).
                if after.get(key):
                    parts.append(f"{verb} {names.get(after[key]) or 'a PRD'} {word} {title}")
                elif before.get(key):
                    verb, word = ("took", "off") if verb == "put" else ("put", "on")
                    parts.append(f"{verb} {names.get(before[key]) or 'a PRD'} {word} {title}")
            if "prd_ids" in after:
                # tracks-goal: the PRDs put on the track and taken off it, by name.
                names = target.get("prd_titles") or {}
                put = [names.get(p) or "a PRD" for p in after["prd_ids"]
                       if p not in before.get("prd_ids", [])]  # fmt: skip
                off = [names.get(p) or "a PRD" for p in before.get("prd_ids", [])
                       if p not in after["prd_ids"]]  # fmt: skip
                if put:
                    parts.append(f"put {', '.join(put)} on {title}")
                if off:
                    parts.append(f"took {', '.join(off)} off {title}")
            if "goal_id" in after:
                goal = target.get("goal_name") if after.get("goal_id") else None
                parts.append(f"tied {title} to the goal {goal}" if goal
                             else f"took the goal off {title}")  # fmt: skip
            return ", ".join(parts) or f"changed the track {title}"
    return "changed something"
