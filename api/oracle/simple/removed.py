"""removed-tracks: what was removed in Simple, and its tracks.

- ``GET /v1/simple/removed`` (viewer and up): cut features (their roadmap; who cut them
  and when, from the cut's change), archived goals (who archived them and when) and
  removed goal milestones (their goal; who removed them and when), newest first; each
  says whether the reader puts it back directly (else whom the proposal waits for). They
  are put back through the change engine: op ``restore`` (a feature), ``unarchive_goal``
  (oracle.simple.goal_asks) and ``restore_goal_milestone`` (oracle.simple.plan_changes).
- ``GET /v1/simple/tracks`` (viewer and up): every track not in Trash (paused and closed
  too), who may change each, who may own one and the PRDs a new track can take. Tracks
  are added, edited and deleted through the change engine (``add_track``, ``edit_track``,
  ``delete_track``).
"""

import uuid
from collections import Counter
from datetime import datetime
from typing import Any

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import TenantDB
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline.models import Entity
from oracle.docs.models import Document
from oracle.members.names import display_name
from oracle.roadmap.models import ProductTrack, TrackMilestone
from oracle.simple import drafts, goal_asks, goal_buckets, plan_changes, service
from oracle.simple.models import SimpleChange
from oracle.simple.router import Reader
from oracle.simple.schemas import (
    SimplePerson,
    SimplePrdRef,
    SimpleRemovedItem,
    SimpleRemovedList,
    SimpleTrackRow,
    SimpleTracks,
)

router = APIRouter(prefix="/v1/simple", tags=["simple"])

CUT_OPS = ("cut", "cut_with_dependents")
# The feature panel's Status field cuts with set_status: its stored ``after`` says cut.
STATUS_OP = "set_status"


async def _names(db: AsyncSession) -> dict[uuid.UUID, str]:
    """Every member's name, disabled ones too (who removed something long ago)."""
    return {u.id: display_name(u.email, u.name) for u in await db.scalars(select(User))}


async def _who_cut(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, tuple]:
    """Item id -> (by, at) of the latest applied or accepted cut that covers it (not undone):
    a cut, a cut with its dependents, or a Status set to cut."""
    if not ids:
        return {}
    undone = select(SimpleChange.undoes_id).where(SimpleChange.undoes_id.is_not(None))
    rows = await db.scalars(
        select(SimpleChange)
        .where(
            SimpleChange.op.in_((*CUT_OPS, STATUS_OP)),
            SimpleChange.status.in_(("applied", "accepted")),
            SimpleChange.id.not_in(undone),
        )
        .order_by(SimpleChange.at.desc())
    )
    out: dict[uuid.UUID, tuple] = {}
    for c in rows:
        if c.op == STATUS_OP and not (c.after or {}).get("cut"):
            continue
        keys = list(c.after or {}) if c.op == "cut_with_dependents" else [c.target.get("item_id")]
        for k in keys:
            try:
                i = uuid.UUID(str(k))
            except ValueError:
                continue
            if i in ids and i not in out:
                out[i] = (c.decided_by if c.status == "accepted" else c.by, c.decided_at or c.at)
    return out


@router.get("/removed", response_model=SimpleRemovedList, name="list_simple_removed")
async def list_simple_removed(principal: Reader, db: TenantDB) -> SimpleRemovedList:
    names = await _names(db)
    owners = await plan_changes.company_owners(db)
    owner_name = names.get(owners[0]) if owners else None
    items: list[SimpleRemovedItem] = []

    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    cut = [e for e in read_.entries if e.row.cut]
    who = await _who_cut(db, {e.row.id for e in cut})
    for e in cut:
        by, at = who.get(e.row.id, (None, None))
        decides = service.can_decide(principal, e, read_.deciders)
        route = service.decider_ids(e, read_.deciders) or owners
        items.append(SimpleRemovedItem(
            kind="feature", id=e.row.id, title=e.row.title, where=e.roadmap.title, at=at,
            by_name=names.get(by) if by else None, can_decide=decides,
            decider_name=None if decides else (names.get(route[0]) if route else None),
            roadmap_id=e.roadmap.id,
        ))  # fmt: skip

    # An archived goal comes back through goal_asks' unarchive_goal: an approver or owner
    # restores it, anyone else asks the company's owners. A goal archived before the
    # who/when columns has its day in attrs (goal_buckets._archived_at).
    restores = goal_asks.may_act(principal)
    goals = await db.scalars(
        select(Entity).where(Entity.type == "goal", Entity.status == "rejected")
    )
    # Archived in Simple, not a goal rejected for another reason.
    for g in (g for g in goals if g.archived_at or "archived_at" in (g.attrs or {})):
        items.append(SimpleRemovedItem(
            kind="goal", id=g.id, title=g.title, where="Goals",
            at=g.archived_at or goal_buckets._archived_at(g),
            by_name=names.get(g.archived_by) if g.archived_by else None, can_decide=restores,
            decider_name=None if restores else owner_name,
        ))  # fmt: skip

    milestones = list(
        await db.scalars(
            select(TrackMilestone).where(
                TrackMilestone.roadmap_id.is_not(None), TrackMilestone.deleted_at.is_not(None)
            )
        )
    )
    if milestones:
        from oracle.simple import key_dates

        rm_ids = {m.roadmap_id for m in milestones if m.roadmap_id}
        w = await drafts.who(db, rm_ids)  # type: ignore[arg-type]
        roadmaps = {
            d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(rm_ids)))
        }
        goal_ids = {m.goal_id for m in milestones if m.goal_id}
        titles = {
            g.id: g.title for g in await db.scalars(select(Entity).where(Entity.id.in_(goal_ids)))
        }
        routes: dict[uuid.UUID, list[uuid.UUID]] = {}
        for m in milestones:
            rm = roadmaps.get(m.roadmap_id)  # type: ignore[arg-type]
            if rm is None:
                continue
            decides = drafts.can_edit(principal, rm.id, w)
            if not decides and rm.id not in routes:
                routes[rm.id] = await key_dates.route(db, rm.id, w)
            route = routes.get(rm.id) or []
            items.append(SimpleRemovedItem(
                kind="milestone", id=m.id, title=m.name,
                where=titles.get(m.goal_id) or rm.title,  # type: ignore[arg-type]
                at=m.deleted_at, by_name=names.get(m.deleted_by) if m.deleted_by else None,
                can_decide=decides,
                decider_name=None if decides else (names.get(route[0]) if route else None),
                roadmap_id=rm.id,
            ))  # fmt: skip

    def newest(i: SimpleRemovedItem) -> tuple[bool, datetime | Any]:
        return (i.at is not None, i.at.timestamp() if i.at else 0)

    items.sort(key=newest, reverse=True)
    return SimpleRemovedList(items=items)


@router.get("/tracks", response_model=SimpleTracks, name="list_simple_tracks")
async def list_simple_tracks(principal: Reader, db: TenantDB) -> SimpleTracks:
    users = list(await db.scalars(select(User)))
    names = {u.id: display_name(u.email, u.name) for u in users}
    owners = await plan_changes.company_owners(db)
    is_owner = has_role(principal.role, "owner")
    rows = list(
        await db.scalars(select(ProductTrack).order_by(ProductTrack.created_at, ProductTrack.id))
    )
    prd_ids = {t.prd_document_id for t in rows}
    prds = (
        {d.id: d.title for d in await db.scalars(select(Document).where(Document.id.in_(prd_ids)))}
        if prd_ids
        else {}
    )
    read = await service.load(db)
    features = Counter(
        e.track.id for e in read.entries if e.track and e.status not in ("cut", "merged")
    )
    # What Move to Trash moves: the features Simple's roadmap shows, cut and merged ones too. It
    # leaves out the rows trash.delete_track also clears that a person no longer sees (trashed,
    # shipped, moved on, older versions).
    moves = Counter(e.track.id for e in read.entries if e.track)
    out = []
    for t in rows:
        decides = plan_changes.decides_track(principal, t)
        route = [] if decides else await plan_changes.track_decider(db, t)
        out.append(SimpleTrackRow(
            id=t.id, title=t.title, status=t.status, owner_id=t.owner_id,  # type: ignore[arg-type]
            owner_name=names.get(t.owner_id) if t.owner_id else None, prd_id=t.prd_document_id,
            prd_title=prds.get(t.prd_document_id), can_decide=decides,
            decider_name=names.get(route[0]) if route else None,
            feature_count=features[t.id], moves_count=moves[t.id],
        ))  # fmt: skip
    people = sorted(
        (
            SimplePerson(id=u.id, name=names[u.id])
            for u in users
            if getattr(u, "disabled_at", None) is None
        ),
        key=lambda p: (p.name.lower(), str(p.id)),
    )
    return SimpleTracks(
        tracks=out,
        can_add=is_owner,
        add_decider_name=None if is_owner or not owners else names.get(owners[0]),
        people=people,
        prds=[SimplePrdRef(id=d.id, title=d.title) for d in await plan_changes.free_prds(db)],
    )
