"""Goal buckets in Simple Priorities: add, edit and archive a goal, and move a feature to
another goal, each with Undo. They write the goal entities and the features' "supports"
links, the same records Baseline edits.

- ``GET /v1/simple/goal-buckets``: viewer and up; the goals in the owner's order (their
  measure, target and date) and each feature's goal links, the one it moves most first.
- ``POST /v1/simple/goal-buckets/goals``: approver and up; a new goal (measure, target
  and date all needed). ``PATCH .../goals/{id}``: the same people; edit one.
  With ``seen`` (the name, measure, target and date as the form read them), a goal
  changed since is refused with 409.
- ``POST .../goals/{id}/archive``: archive a goal; features that serve another goal too
  keep it (now first), the rest go to ``to_goal_id`` or are left with no goal.
- ``POST .../features/{id}/move``: the feature's first goal link becomes ``to_goal_id``;
  its link to ``from_goal_id`` is dropped.
- ``POST .../goals/{id}/unarchive``: approver and up; an archived goal (``archived``)
  back in the buckets, with Undo. A goal's ``owner_id`` is a member, saved in its form
  (edit-goals-prds EG1); who may not archive or delete a goal asks ``asks_to`` through
  the change engine (oracle.simple.goal_asks).
- ``POST .../undo``: puts back the goals and links a write's ``undo`` names, each link
  whole (its id, attrs, status, origin and created_at). The ``undo`` is signed: one the
  API did not give is refused.
"""

import hashlib
import hmac
import re
import uuid
from datetime import date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.auth.deps import TenantDB
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline import service as baseline
from oracle.baseline.goal_order import goal_position, sort_goals
from oracle.baseline.goals import figure_words, unit_ok
from oracle.baseline.models import Edge, Entity
from oracle.config import get_settings
from oracle.roadmap.models import RoadmapItem
from oracle.simple.router import Approver, Reader
from oracle.trash.filter import INCLUDE_TRASHED

router = APIRouter(prefix="/v1/simple/goal-buckets", tags=["simple"])

Line = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
TOP = 3  # a "supports" link's highest contribution: the goal a feature moves most


class GoalBucketGoal(BaseModel):
    id: uuid.UUID
    title: str
    order: int
    measure: str | None = None
    target: str | None = None
    due: date | None = None
    can_edit: bool = False
    owner_id: uuid.UUID | None = None
    owner_name: str | None = None
    # milestone-kinds: its target date shows on the roadmap as a goal milestone.
    on_roadmap: bool = True


class ArchivedGoal(BaseModel):
    id: uuid.UUID
    title: str
    owner_name: str | None = None
    archived_at: datetime | None = None


class GoalBucketFeature(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    # The goals it serves, the one it moves most first.
    goal_ids: list[uuid.UUID] = Field(default_factory=list)
    # Those whose contribution is assumed (an approved order's ASSUMED_LINK), for a person to set.
    assumed_goal_ids: list[uuid.UUID] = Field(default_factory=list)


class GoalBucketsOut(BaseModel):
    can_edit: bool
    goals: list[GoalBucketGoal]
    features: list[GoalBucketFeature]
    # Archived goals, newest first: Restore puts one back.
    archived: list[ArchivedGoal] = Field(default_factory=list)
    # Who an Ask to archive or delete a goal goes to: the company's owners, by name.
    asks_to: list[str] = Field(default_factory=list)


class GoalSeen(BaseModel):
    """The goal's fields as the edit form read them when it opened."""

    title: str | None = None
    measure: str | None = None
    target: str | None = None
    due: date | None = None


class GoalIn(BaseModel):
    title: Line
    measure: Line
    target: Line
    due: date
    # A member; left out, the owner stays as it was; null clears it.
    owner_id: uuid.UUID | None = None
    # The goal as the form read it (edit only): a goal changed since is refused with 409.
    seen: GoalSeen | None = None
    # milestone-kinds (edit only): show its target date on the roadmap; left out, as it was.
    on_roadmap: bool | None = None


GOAL_CHANGED = "This goal changed since you opened it. Look again and save."


class GoalLinkSnap(BaseModel):
    goal_id: uuid.UUID
    contribution: int | None = None
    # The link as it was, for Undo (a write's wanted links leave these out).
    id: uuid.UUID | None = None
    attrs: dict[str, Any] | None = None
    status: str | None = None
    origin: str | None = None
    created_at: datetime | None = None


class FeatureSnap(BaseModel):
    feature_id: uuid.UUID
    links: list[GoalLinkSnap]


class GoalSnap(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    attrs: dict[str, Any]
    on_roadmap: bool = True


class GoalBucketsUndo(BaseModel):
    """What a write changed, as it was before: Undo puts exactly this back."""

    goals: list[GoalSnap] = Field(default_factory=list)
    features: list[FeatureSnap] = Field(default_factory=list)
    # A goal the write added: Undo archives it again.
    added_goal_id: uuid.UUID | None = None
    # The API's signature over the rest: Undo takes only an undo a write gave.
    sig: str | None = None


class GoalBucketWrite(BaseModel):
    goal: GoalBucketGoal | None = None
    undo: GoalBucketsUndo


class ArchiveIn(BaseModel):
    to_goal_id: uuid.UUID | None = None


class MoveIn(BaseModel):
    from_goal_id: uuid.UUID | None = None
    to_goal_id: uuid.UUID


def _target(attrs: dict[str, Any]) -> str | None:
    if attrs.get("target_text"):
        return str(attrs["target_text"])
    if attrs.get("target") is None:
        return None
    unit = attrs.get("unit") or ""
    n = attrs["target"]
    if isinstance(n, int | float) and not isinstance(n, bool):
        return figure_words(n, unit)
    return f"{n}{unit}" if unit == "%" else f"{n} {unit}".strip()


# goal-target-kept: a target typed as a number, with or without its unit, before or after
# it ("60", "60 Conversions", "1,200 shops", "60%", "$1,200").
_TYPED_TARGET = re.compile(r"(\D*?)(-?\d[\d,]*(?:\.\d+)?)\s*(.*)")
# Commas only between thousands ("1,200", "12,000,000"), never "1,2".
_NUMBER = re.compile(r"-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?")
# A currency typed as its sign, as the goal's unit is stored (lower-cased).
_SIGNS = {"$": "usd", "€": "eur", "£": "gbp"}
# A stored currency unit as a person reads it ("usd" is "$").
_READ = {v: k for k, v in _SIGNS.items()}
NUMBER_TYPED = "Type the target as a number, like 60"
NUMBER_KEPT = "A measured goal keeps its target: type its new number"


class TargetKept(ValueError):
    """A measured goal's target cleared, or typed in words or another unit: refused (422)."""


def _words(v: Any) -> str | None:
    if v is None:
        return None
    return " ".join(str(v).split()) or None


def typed_target(attrs: dict[str, Any], typed: str | None) -> dict[str, Any]:
    """goal-target-kept: ``attrs`` with the target a person typed in Simple (the goal form,
    the feature panel). The target as it reads now (whitespace aside) changes nothing. A
    measured goal (a number in ``target``) never loses its number or unit here: a number
    typed alone, or with the goal's unit in any case, is its new target in the goal's unit;
    a number in another unit, words only and clearing it are refused (``TargetKept``), so
    no ``target_text`` ever reads apart from its number. A goal with no number keeps what
    is typed as text, as before."""
    out = dict(attrs)
    if _words(typed) == _words(_target(attrs)):
        return out
    measured = isinstance(attrs.get("target"), int | float) and not isinstance(
        attrs.get("target"), bool
    )
    if not measured:
        if typed is None or not typed.strip():
            out.pop("target_text", None)
        else:
            out["target_text"] = typed
            out.pop("target", None)
        return out
    m = _TYPED_TARGET.fullmatch(_words(typed) or "")
    if m is None:
        raise TargetKept(NUMBER_KEPT)
    if not _NUMBER.fullmatch(m.group(2)):
        raise TargetKept(NUMBER_TYPED)
    unit = _words(f"{m.group(1)} {m.group(3)}") or ""
    unit = _SIGNS.get(unit, unit.lower())
    have = out["unit"].strip() if isinstance(out.get("unit"), str) else ""
    if unit and unit != have.lower():
        if have:
            read = _READ.get(have.lower(), have)
            raise TargetKept(f"This goal is measured in {read}: type its new number")
        if not unit_ok(unit):
            raise TargetKept(NUMBER_TYPED)
        have = unit
    n = float(m.group(2).replace(",", ""))
    out["target"] = int(n) if n.is_integer() else n
    if have:
        out["unit"] = have
    out.pop("target_text", None)
    return out


def _due(attrs: dict[str, Any]) -> date | None:
    try:
        return date.fromisoformat(str(attrs.get("due"))) if attrs.get("due") else None
    except ValueError:
        return None


async def _goals(db: AsyncSession) -> list[Entity]:
    from oracle.simple import goal_reads

    return sort_goals(g for g in await goal_reads.all_goals(db) if g.status != "rejected")


def _owner_id(attrs: dict[str, Any]) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(attrs["owner"])) if attrs.get("owner") else None
    except ValueError:
        return None


async def _names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids_ = {i for i in ids if i is not None}
    if not ids_:
        return {}
    return {
        u.id: u.name or u.email for u in await db.scalars(select(User).where(User.id.in_(ids_)))
    }


def _goal_out(
    g: Entity, order: int, edits: bool, names: dict[uuid.UUID, str] | None = None
) -> GoalBucketGoal:
    attrs = g.attrs or {}
    owner = _owner_id(attrs)
    return GoalBucketGoal(
        id=g.id,
        title=g.title,
        order=goal_position(attrs) or order,
        measure=attrs.get("metric") or attrs.get("metric_text"),
        target=_target(attrs),
        due=_due(attrs),
        can_edit=edits,
        owner_id=owner,
        owner_name=(names or {}).get(owner) if owner else None,
        on_roadmap=g.on_roadmap is not False,
    )


async def _goal_full(db: AsyncSession, g: Entity, order: int) -> GoalBucketGoal:
    return _goal_out(g, order, True, await _names(db, {_owner_id(g.attrs or {})}))


async def _links(db: AsyncSession, feature_ids: list[uuid.UUID] | None = None) -> list[Edge]:
    q = select(Edge).where(Edge.type == "supports", Edge.status != "rejected")
    if feature_ids is not None:
        q = q.where(Edge.src_id.in_(feature_ids))
    edges = list(await db.scalars(q))
    edges.sort(key=lambda e: (-int((e.attrs or {}).get("contribution") or 0), e.created_at))
    return edges


async def _snap(db: AsyncSession, feature_ids: list[uuid.UUID]) -> list[FeatureSnap]:
    edges = await _links(db, feature_ids)
    return [
        FeatureSnap(
            feature_id=f,
            links=[
                GoalLinkSnap(
                    goal_id=e.dst_id,
                    contribution=(e.attrs or {}).get("contribution"),
                    id=e.id,
                    attrs=dict(e.attrs or {}),
                    status=e.status,
                    origin=e.origin,
                    created_at=e.created_at,
                )
                for e in edges
                if e.src_id == f
            ],
        )
        for f in feature_ids
    ]


async def _set_links(db: AsyncSession, feature_id: uuid.UUID, links: list[GoalLinkSnap]) -> None:
    """The feature's supports links become exactly ``links``."""
    have = {e.dst_id: e for e in await _links(db, [feature_id])}
    want = {lk.goal_id: lk for lk in links}
    for goal_id, e in have.items():
        if goal_id not in want:
            await db.delete(e)
    for goal_id, lk in want.items():
        attrs = {} if lk.contribution is None else {"contribution": lk.contribution}
        if goal_id in have:
            old = dict(have[goal_id].attrs or {})
            if attrs and attrs["contribution"] != old.get("contribution"):
                old.pop("contribution_assumed", None)  # set here: no longer assumed
            have[goal_id].attrs = {**old, **attrs}
        else:
            db.add(Edge(src_id=feature_id, dst_id=goal_id, type="supports",
                        status="confirmed", origin="user", attrs=attrs))  # fmt: skip
    await db.flush()


async def _restore_links(db: AsyncSession, snap: FeatureSnap) -> None:
    """The feature's supports links become exactly the snapshot's, each whole: a link the
    write added is dropped, one it changed gets its old attrs, status and origin, and one
    it dropped comes back with its old id and created_at."""
    rows = await db.scalars(
        select(Edge).where(Edge.src_id == snap.feature_id, Edge.type == "supports")
    )
    have = {e.id: e for e in rows}
    keep = {lk.id for lk in snap.links}
    wanted_goals = {lk.goal_id for lk in snap.links}
    for e in have.values():
        live_extra = e.status != "rejected" and e.id not in keep
        if live_extra or (e.id not in keep and e.dst_id in wanted_goals):
            await db.delete(e)
    await db.flush()
    for lk in snap.links:
        attrs = dict(lk.attrs or {})
        if lk.id in have:
            e = have[lk.id]
            e.attrs, e.status, e.origin = attrs, lk.status or e.status, lk.origin or e.origin
        else:
            db.add(Edge(id=lk.id, src_id=snap.feature_id, dst_id=lk.goal_id, type="supports",
                        status=lk.status or "confirmed", origin=lk.origin or "user",
                        attrs=attrs, created_at=lk.created_at))  # fmt: skip
    await db.flush()


async def move_links(
    db: AsyncSession, before: FeatureSnap, to_goal_id: uuid.UUID, from_goal_id: uuid.UUID | None
) -> None:
    """A move: ``to_goal_id`` becomes the feature's first goal link, its link to
    ``from_goal_id`` is dropped, and its other links stay, after it. The change engine's
    ``set_goals`` moves an item's feature this way too."""
    links = [lk for lk in before.links if lk.goal_id not in (from_goal_id, to_goal_id)]
    links = [GoalLinkSnap(goal_id=lk.goal_id, contribution=min(lk.contribution or 0, TOP - 1))
             for lk in links]  # fmt: skip
    await _set_links(
        db, before.feature_id, [GoalLinkSnap(goal_id=to_goal_id, contribution=TOP), *links]
    )


def _sig(tenant_id: uuid.UUID, undo: GoalBucketsUndo) -> str:
    body = undo.model_dump_json(exclude={"sig"})
    key = get_settings().secret_key.encode()
    msg = f"goal-buckets-undo:{tenant_id}:{body}".encode()
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def _signed(tenant_id: uuid.UUID, undo: GoalBucketsUndo) -> GoalBucketsUndo:
    undo.sig = _sig(tenant_id, undo)
    return undo


async def _entity(db: AsyncSession, id_: uuid.UUID, type_: str) -> Entity:
    e = await db.get(Entity, id_)
    if e is None or e.type != type_:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No such {type_}")
    return e


def _slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "goal"
    return f"{base}-{uuid.uuid4().hex[:6]}"


async def _check_owner(db: AsyncSession, body: GoalIn) -> None:
    if body.owner_id is None:
        return
    u = await db.get(User, body.owner_id)
    if u is None or u.disabled_at is not None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Pick a member as its owner")


def _fields(g: Entity, body: GoalIn) -> None:
    g.title = body.title
    attrs = dict(g.attrs or {})
    attrs.update({"metric": body.measure, "due": body.due.isoformat()})
    if "owner_id" in body.model_fields_set:
        if body.owner_id is None:
            attrs.pop("owner", None)
        else:
            attrs["owner"] = str(body.owner_id)
    if body.on_roadmap is not None:
        g.on_roadmap = body.on_roadmap
    try:
        attrs = typed_target(attrs, body.target)
    except TargetKept as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    g.attrs = attrs


def _changed_since(g: Entity, seen: GoalSeen) -> bool:
    """Whether the goal's name, measure, target or date differ from what the form read."""

    def norm(v: Any) -> Any:
        return (" ".join(v.split()) or None) if isinstance(v, str) else v

    now = _goal_out(g, 1, True)
    fields = ("title", "measure", "target", "due")
    return any(norm(getattr(now, f)) != norm(getattr(seen, f)) for f in fields)


def _goal_snap(g: Entity) -> GoalSnap:
    return GoalSnap(id=g.id, title=g.title, status=g.status, attrs=dict(g.attrs or {}),
                    on_roadmap=g.on_roadmap is not False)  # fmt: skip


async def _trashed_without_live(db: AsyncSession, feature_ids: set[uuid.UUID]) -> set[uuid.UUID]:
    """Feature ids with at least one roadmap item in Trash and no live one anywhere
    (trash-features-goals): those leave the goal buckets with their roadmap item. A feature
    with no roadmap item at all, or whose only item sits on a roadmap this reader cannot
    see, keeps showing as it did: this only drops a feature actually in Trash."""
    if not feature_ids:
        return set()
    rows = await db.execute(
        select(RoadmapItem.feature_id, RoadmapItem.deleted_at)
        .where(RoadmapItem.feature_id.in_(feature_ids))
        .execution_options(**{INCLUDE_TRASHED: True})
    )
    trashed: set[uuid.UUID] = set()
    live: set[uuid.UUID] = set()
    for feature_id, deleted_at in rows:
        (live if deleted_at is None else trashed).add(feature_id)
    return trashed - live


@router.get("", response_model=GoalBucketsOut, name="list_goal_buckets")
async def list_goal_buckets(principal: Reader, db: TenantDB) -> GoalBucketsOut:
    """The goals in order and each feature's goal links."""
    edits = has_role(principal.role, "approver")
    goals = await _goals(db)
    live = {g.id for g in goals}
    live_features = select(Entity).where(Entity.type == "feature", Entity.status != "rejected")
    features = list(await db.scalars(live_features))
    trashed = await _trashed_without_live(db, {f.id for f in features})
    features = [f for f in features if f.id not in trashed]
    edges = await _links(db)
    from oracle.simple.changes import _company_owners

    archived = list(await db.scalars(
        select(Entity).where(Entity.type == "goal", Entity.status == "rejected")
    ))  # fmt: skip
    archived.sort(key=_archived_at, reverse=True)
    deciders = await _company_owners(db)
    owners = {_owner_id(g.attrs or {}) for g in [*goals, *archived]}
    names = await _names(db, {*owners, *deciders})
    return GoalBucketsOut(
        can_edit=edits,
        goals=[_goal_out(g, i + 1, edits, names) for i, g in enumerate(goals)],
        archived=[
            ArchivedGoal(
                id=g.id,
                title=g.title,
                owner_name=names.get(_owner_id(g.attrs or {})),
                archived_at=_archived_at(g),
            )  # fmt: skip
            for g in archived
        ],
        asks_to=[names[i] for i in deciders if i in names],
        features=[
            GoalBucketFeature(
                id=f.id,
                key=f.key,
                title=f.title,
                goal_ids=[e.dst_id for e in edges if e.src_id == f.id and e.dst_id in live],
                assumed_goal_ids=[
                    e.dst_id
                    for e in edges
                    if e.src_id == f.id
                    and e.dst_id in live
                    and (e.attrs or {}).get("contribution_assumed") is True
                ],
            )
            for f in sorted(features, key=lambda f: f.key)
        ],
    )


def _archived_at(g: Entity) -> datetime:
    try:
        return datetime.fromisoformat(str((g.attrs or {})["archived_at"]))
    except (KeyError, ValueError):
        return g.updated_at


@router.post("/goals", response_model=GoalBucketWrite, status_code=201, name="create_bucket_goal")
async def create_bucket_goal(body: GoalIn, principal: Approver, db: TenantDB) -> GoalBucketWrite:
    """A new goal, after the others."""
    goals = await _goals(db)
    last = max([goal_position(g.attrs) or i + 1 for i, g in enumerate(goals)], default=0)
    g = Entity(type="goal", key=_slug(body.title), title=body.title, status="confirmed",
               origin="user", attrs={"position": last + 1})  # fmt: skip
    await _check_owner(db, body)
    _fields(g, body)
    db.add(g)
    await db.flush()
    baseline.revise(db, principal.actor, g, None, "Added in Simple")
    out = await _goal_full(db, g, last + 1)
    await db.commit()
    undo = _signed(principal.tenant_id, GoalBucketsUndo(added_goal_id=g.id))
    return GoalBucketWrite(goal=out, undo=undo)


@router.patch("/goals/{goal_id}", response_model=GoalBucketWrite, name="update_bucket_goal")
async def update_bucket_goal(
    goal_id: uuid.UUID, body: GoalIn, principal: Approver, db: TenantDB
) -> GoalBucketWrite:
    """Edit a goal's name, measure, target and date (its order stays the Ground Truth's)."""
    g = await _entity(db, goal_id, "goal")
    if body.seen is not None and _changed_since(g, body.seen):
        raise HTTPException(status.HTTP_409_CONFLICT, GOAL_CHANGED)
    undo = GoalBucketsUndo(goals=[_goal_snap(g)])
    await _check_owner(db, body)
    before = baseline.entity_snapshot(g)
    _fields(g, body)
    await db.flush()
    baseline.revise(db, principal.actor, g, before, "Edited in Simple")
    order = next((i + 1 for i, x in enumerate(await _goals(db)) if x.id == g.id), 1)
    out = await _goal_full(db, g, order)
    await db.commit()
    return GoalBucketWrite(goal=out, undo=_signed(principal.tenant_id, undo))


async def move_off(db: AsyncSession, g: Entity, to_goal_id: uuid.UUID | None) -> list[FeatureSnap]:
    """Move the goal's features off it (Archive, and a delete to Trash): those that serve
    another goal too keep it (now first), the rest go to ``to_goal_id`` or to no goal.
    The links as they were, for Undo."""
    held = sorted({e.src_id for e in await _links(db) if e.dst_id == g.id})
    before = await _snap(db, held)
    for snap in before:
        await _set_links(db, snap.feature_id, moved_off_links(snap, g.id, to_goal_id))
    return before


def moved_off_links(
    snap: FeatureSnap, goal_id: uuid.UUID, to_goal_id: uuid.UUID | None
) -> list[GoalLinkSnap]:
    """The feature's links once :func:`move_off` took them off ``goal_id``."""
    first_here = bool(snap.links) and snap.links[0].goal_id == goal_id
    rest = [lk for lk in snap.links if lk.goal_id != goal_id]
    if first_here and rest:
        return [GoalLinkSnap(goal_id=rest[0].goal_id, contribution=TOP), *rest[1:]]
    if first_here and to_goal_id is not None:
        return [GoalLinkSnap(goal_id=to_goal_id, contribution=TOP)]
    return rest


@router.post("/goals/{goal_id}/archive", response_model=GoalBucketWrite, name="archive_bucket_goal")
async def archive_bucket_goal(
    goal_id: uuid.UUID, body: ArchiveIn, principal: Approver, db: TenantDB
) -> GoalBucketWrite:
    """Archive a goal and move its features' links in one step."""
    undo = await archive(db, goal_id, body.to_goal_id, principal.user_id, principal.actor)
    await db.commit()
    return GoalBucketWrite(undo=_signed(principal.tenant_id, undo))


async def archive(
    db: AsyncSession,
    goal_id: uuid.UUID,
    to_goal_id: uuid.UUID | None,
    by: uuid.UUID | None,
    actor: str | None = None,
) -> GoalBucketsUndo:
    """Archive the goal, its features moved off it (also an accepted Ask to archive).
    ``actor``: its revision's (default: ``by``'s)."""
    g = await _entity(db, goal_id, "goal")
    if g.status == "rejected":
        raise HTTPException(status.HTTP_409_CONFLICT, f"{g.title} is archived already")
    if to_goal_id is not None:
        to = await _entity(db, to_goal_id, "goal")
        if to.id == g.id or to.status == "rejected":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Pick another goal")
    undo = GoalBucketsUndo(goals=[_goal_snap(g)], features=await move_off(db, g, to_goal_id))
    before = baseline.entity_snapshot(g)
    g.status = "rejected"
    now = company_time.now()
    g.attrs = {**(g.attrs or {}), "archived_at": now.isoformat()}
    # removed-tracks: who archived it and when (Simple's Removed list).
    g.archived_at, g.archived_by = now, by
    await db.flush()
    baseline.revise(db, actor or (f"user:{by}" if by else "system"), g, before, "Archived")
    return undo


@router.post(
    "/goals/{goal_id}/unarchive", response_model=GoalBucketWrite, name="unarchive_bucket_goal"
)
async def unarchive_bucket_goal(
    goal_id: uuid.UUID, principal: Approver, db: TenantDB
) -> GoalBucketWrite:
    """Restore an archived goal to the buckets (its features stay where Archive moved them)."""
    g = await _entity(db, goal_id, "goal")
    undo = await unarchive(db, g, principal.actor)
    order = next((i + 1 for i, x in enumerate(await _goals(db)) if x.id == g.id), 1)
    out = await _goal_full(db, g, order)
    await db.commit()
    return GoalBucketWrite(goal=out, undo=_signed(principal.tenant_id, undo))


async def unarchive(db: AsyncSession, g: Entity, actor: str = "system") -> GoalBucketsUndo:
    """Put an archived goal back in the buckets (Restore, and an accepted ask); ``actor``:
    its revision's."""
    if g.status != "rejected":
        raise HTTPException(status.HTTP_409_CONFLICT, f"{g.title} is not archived")
    undo = GoalBucketsUndo(goals=[_goal_snap(g)])
    before = baseline.entity_snapshot(g)
    g.status = "confirmed"
    g.attrs = {k: v for k, v in (g.attrs or {}).items() if k != "archived_at"}
    g.archived_at = g.archived_by = None
    await db.flush()
    baseline.revise(db, actor, g, before, "Restored")
    return undo


@router.post(
    "/features/{feature_id}/move", response_model=GoalBucketWrite, name="move_bucket_feature"
)
async def move_bucket_feature(
    feature_id: uuid.UUID, body: MoveIn, principal: Approver, db: TenantDB
) -> GoalBucketWrite:
    """The feature's first goal link becomes the goal it was dropped on."""
    await _entity(db, feature_id, "feature")
    await _entity(db, body.to_goal_id, "goal")
    (before,) = await _snap(db, [feature_id])
    await move_links(db, before, body.to_goal_id, body.from_goal_id)
    await db.commit()
    undo = GoalBucketsUndo(features=[before])
    return GoalBucketWrite(undo=_signed(principal.tenant_id, undo))


@router.post("/undo", response_model=GoalBucketsOut, name="undo_goal_buckets")
async def undo_goal_buckets(
    body: GoalBucketsUndo, principal: Approver, db: TenantDB
) -> GoalBucketsOut:
    """Puts back every goal and link a write changed."""
    if not body.sig or not hmac.compare_digest(body.sig, _sig(principal.tenant_id, body)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This Undo is not one Oracle gave")
    for snap in body.goals:
        g = await _entity(db, snap.id, "goal")
        before = baseline.entity_snapshot(g)
        g.title, g.status, g.attrs = snap.title, snap.status, snap.attrs
        g.on_roadmap = snap.on_roadmap
        if g.status != "rejected":
            g.archived_at = g.archived_by = None
        baseline.revise(db, principal.actor, g, before, "Undone in Simple")
    for f in body.features:
        await _entity(db, f.feature_id, "feature")
        await _restore_links(db, f)
    if body.added_goal_id is not None:
        (await _entity(db, body.added_goal_id, "goal")).status = "rejected"
    await db.commit()
    return await list_goal_buckets(principal, db)
