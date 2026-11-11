"""build-milestones-on-roadmap: milestones per goal on the Simple roadmap, reusing
Oracle's existing milestone model (``oracle.roadmap.models.TrackMilestone``,
``roadmap_id``/``goal_id`` set, ``track_id`` null) rather than a second table.

Own milestones (created here) are created, edited, deleted and restored directly by who
may change the roadmap (the same rule as a key date, ``drafts.can_edit``). A deleted one
goes to Settings > Trash (goal-map-editing, ``oracle.trash.service.delete_milestone``); its
own restore takes it out of Trash too. A PRD's own
milestones (``origin_prd_id`` set) are read-only from the PRD's plan (its latest approved
version, ``oracle.simple.plan``): materialised here on first read, idempotently, so a
later edit has a row to hold a ``pending_change`` on. Editing one of those does not change
it; it proposes a change (a :class:`~oracle.simple.models.SimpleChange` row, ``op
edit_goal_milestone``, ``document_id`` the PRD) routed to the PRD's owner, who decides it
through the change engine's own routes (``POST /v1/simple/changes/{id}/accept|decline``,
wired in ``oracle.simple.changes.decide``): accepting it writes the date and/or
``counts_when`` onto the milestone and clears ``pending_change``.
"""

import re
import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs.models import Document
from oracle.members.names import display_name
from oracle.roadmap import company
from oracle.roadmap.models import ProductTrack, TrackMilestone
from oracle.simple import drafts
from oracle.simple.models import SimpleChange
from oracle.simple.schemas import (
    SimpleDocRef,
    SimpleGoalMilestone,
    SimpleGoalMilestoneIn,
    SimpleGoalMilestonePatch,
    SimpleMilestonePending,
)
from oracle.tenancy import current_tenant

OPS: frozenset[str] = frozenset({"edit_goal_milestone"})
_CODE = re.compile(r"^M(\d+)$")


def _error(code: int, detail: Any) -> HTTPException:
    return HTTPException(code, detail)


def _me(principal: Any) -> uuid.UUID | None:
    return getattr(principal, "user_id", None)


def _may_propose(principal: Any) -> bool:
    return has_role(principal.role, "commenter") and _me(principal) is not None


async def _name_of(db: AsyncSession, user_id: uuid.UUID | None) -> str | None:
    if user_id is None:
        return None
    u = await db.get(User, user_id)
    return display_name(u.email, u.name) if u is not None else None


async def _company_owners(db: AsyncSession) -> list[uuid.UUID]:
    from oracle.simple.changes import _company_owners as owners

    return await owners(db)


# --------------------------------------------------------------------------- status

MEASURED = frozenset({"goal", "sub_goal"})
# The fields a person writes on a roadmap's own milestone beyond name/date/goal/items/counts.
KIND_FIELDS = ("kind", "done_when_line", "status_set", "status_reason", "measure", "baseline",
               "target", "current", "sub_goal_of_id", "home_track_id", "from_track_id",
               "to_track_id")  # fmt: skip
_UUID_FIELDS = ("sub_goal_of_id", "home_track_id", "from_track_id", "to_track_id")
_NUMBERS = ("baseline", "target", "current")


def _num(v: float | None) -> str:
    if v is None:
        return ""
    return str(int(v)) if float(v).is_integer() else f"{v:g}"


def _f(v: Decimal | float | None) -> float | None:
    return float(v) if v is not None else None


def status_of(
    kind: str,
    day: date | None,
    status_set: str | None,
    status_reason: str | None,
    set_by_name: str | None,
    baseline: float | None,
    target: float | None,
    current: float | None,
    items: list[tuple[str, date | None]],
    today: date,
    down: bool | None = None,
) -> tuple[str, str]:
    """milestone-kinds: a milestone's status and why. A person's wins; else a measured
    (sub-)goal whose reading reached its target is hit (downward when ``down``, a goal's
    ``at_most``/``below``; else upward when the target is at or above the baseline, else
    downward), one whose date passed short of it missed, and one with no reading by its
    date missed; else at risk when a piece of work it serves ends after its date, else on
    track."""
    if status_set:
        return status_set, status_reason or f"Set by {set_by_name or 'a person'}"
    passed = day is not None and today > day
    if kind in MEASURED and current is None and passed:
        return "missed", "No reading came in by its date."
    if kind in MEASURED and current is not None and target is not None:
        if down is None:
            down = baseline is not None and target < baseline
        if (current <= target) if down else (current >= target):
            return "hit", f"Reached {_num(current)} on its target {_num(target)}"
        if day is not None and passed:
            return "missed", (
                f"{_num(current)} on its target {_num(target)} when its date "
                f"{company_time.calendar_day(day, today)} passed"
            )
    if day is not None:
        late = sorted(
            ((end, title) for title, end in items if end is not None and end > day),
            key=lambda x: (-x[0].toordinal(), x[1]),
        )
        if late:
            end, title = late[0]
            return "at_risk", (
                f"{title} ends {company_time.calendar_day(end, today)}, after its date "
                f"{company_time.calendar_day(day, today)}"
            )
    return "on_track", "Every piece of work ends by its date"


# --------------------------------------------------------------------------- reading


# No change waits on it: the column is SQL NULL, or JSON null once a decision cleared it.
_no_pending = func.coalesce(func.jsonb_typeof(TrackMilestone.pending_change), "null") == "null"


async def _rows(
    db: AsyncSession, roadmap_ids: list[uuid.UUID], fresh: bool = False
) -> list[TrackMilestone]:
    q = select(TrackMilestone).where(TrackMilestone.roadmap_id.in_(roadmap_ids))
    if fresh:
        q = q.execution_options(populate_existing=True)
    return list(await db.scalars(q))


async def _out(
    db: AsyncSession,
    principal: Any,
    row: TrackMilestone,
    roadmap: Document,
    prd: Document | None,
    w: drafts.Who,
    names: dict[uuid.UUID, str] | None = None,
    ends: dict[uuid.UUID, tuple[str, date | None]] | None = None,
    today: date | None = None,
    look: dict[uuid.UUID, str] | None = None,
) -> SimpleGoalMilestone:
    if look is None:
        look = await _lookups(db, [row])
    pending = None
    if row.pending_change:
        pc = row.pending_change
        pending = SimpleMilestonePending(
            date=date.fromisoformat(pc["date"]) if pc.get("date") else None,
            counts_when=pc.get("counts_when"),
            name=pc.get("name"),
            asked_of=pc.get("asked_of_name"),
            change_id=uuid.UUID(pc["change_id"]) if pc.get("change_id") else None,
            can_decide=prd is not None
            and (
                has_role(principal.role, "owner") or _me(principal) in w.owners.get(prd.id, set())
            ),
        )
    prd_owner = None
    can_change: bool
    if prd is not None:
        owners = sorted(w.owners.get(prd.id, set()), key=str)
        if not owners:
            prd_owner = None
        elif names is not None:
            prd_owner = names.get(owners[0])
        else:
            prd_owner = await _name_of(db, owners[0])
        can_change = _may_propose(principal)
    else:
        can_change = drafts.can_edit(principal, row.roadmap_id, w)
    can_propose = prd is None and not can_change and _may_propose(principal)
    set_by = look.get(row.status_set_by) if row.status_set and row.status_set_by else None
    numbers = {k: _f(getattr(row, k)) for k in _NUMBERS}
    st, why = status_of(
        row.kind, row.target_date, row.status_set, row.status_reason, set_by,
        numbers["baseline"], numbers["target"], numbers["current"],
        [(ends or {})[i] for i in row.item_ids or [] if i in (ends or {})],
        today or company_time.today(),
    )  # fmt: skip
    return SimpleGoalMilestone(
        id=row.id, roadmap_id=row.roadmap_id, code=row.code or "", name=row.name,
        date=row.target_date, goal_id=row.goal_id, item_ids=list(row.item_ids or []),
        counts_when=row.counts_when, progress=row.progress,  # type: ignore[arg-type]
        prd=SimpleDocRef(id=prd.id, slug=prd.slug, title=prd.title) if prd is not None else None,
        prd_owner=prd_owner, pending=pending, can_change=can_change, can_propose=can_propose,
        kind=row.kind, done_when_line=row.done_when_line or "", status=st, status_reason=why,
        status_set=row.status_set, status_set_by_name=set_by, measure=row.measure, **numbers,
        sub_goal_of_id=row.sub_goal_of_id, home_track_id=row.home_track_id,
        home_track_name=look.get(row.home_track_id) if row.home_track_id else None,
        from_track_id=row.from_track_id,
        to_track_id=row.to_track_id,
        from_track_name=look.get(row.from_track_id) if row.from_track_id else None,
        to_track_name=look.get(row.to_track_id) if row.to_track_id else None,
    )  # fmt: skip


async def _lookups(db: AsyncSession, rows: list[TrackMilestone]) -> dict[uuid.UUID, str]:
    """The names a milestone shows by id: who set its status, and a hand-off's tracks."""
    users = {r.status_set_by for r in rows if r.status_set_by}
    tracks = {t for r in rows for t in (r.home_track_id, r.from_track_id, r.to_track_id) if t}
    out: dict[uuid.UUID, str] = {}
    if users:
        for u in await db.scalars(select(User).where(User.id.in_(users))):
            out[u.id] = display_name(u.email, u.name)
    if tracks:
        for t in await db.scalars(select(ProductTrack).where(ProductTrack.id.in_(tracks))):
            out[t.id] = t.title
    return out


async def with_asks(
    db: AsyncSession, principal: Any, out: list[SimpleGoalMilestone], w: drafts.Who | None = None
) -> None:
    """milestone-rename: a roadmap's own milestone (or a goal's) with an open
    ``edit_goal_milestone`` proposal reads it as ``pending`` (the name and date asked for,
    who it waits for, whether this person decides it): "Proposed · waits for <name>"."""
    from oracle.simple import key_dates

    mine = {str(m.id): m for m in out if m.prd is None and m.pending is None}
    if not mine:
        return
    asks = list(
        await db.scalars(
            select(SimpleChange)
            .where(
                SimpleChange.op == "edit_goal_milestone",
                SimpleChange.status == "proposed",
                SimpleChange.target["milestone_id"].astext.in_(list(mine)),
            )
            .order_by(SimpleChange.at)
        )
    )
    if not asks:
        return
    if w is None:
        w = await drafts.who(db, {c.document_id for c in asks if c.document_id})
    view = type("V", (), {"deciders": w.deciders, "owners": w.owners})
    users = {c.routed_to[0] for c in asks if c.routed_to}
    names = {
        u.id: display_name(u.email, u.name)
        for u in await db.scalars(select(User).where(User.id.in_(users)))
    } if users else {}  # fmt: skip
    for c in asks:
        m = mine.get(str(c.target.get("milestone_id")))
        after = (c.after or {}).get("milestone")
        if m is None or not isinstance(after, dict):
            continue
        to = date.fromisoformat(after["date"]) if after.get("date") else None
        cw = after.get("counts_when")
        m.pending = SimpleMilestonePending(
            name=after.get("name") if after.get("name") not in (None, m.name) else None,
            date=to if to != m.date else None,
            counts_when=cw if cw not in (None, m.counts_when) else None,
            asked_of=names.get(c.routed_to[0]) if c.routed_to else None,
            change_id=c.id,
            can_decide=key_dates.may_decide(principal, c, view),
        )


async def list_for_roadmaps(
    db: AsyncSession,
    principal: Any,
    docs: dict[uuid.UUID, Document],
    entries: list[Any],
    views: dict[uuid.UUID, Any],
    kd_prds: dict[uuid.UUID, list[Document]],
    ends: dict[uuid.UUID, tuple[str, date | None]] | None = None,
    today: date | None = None,
) -> list[SimpleGoalMilestone]:
    """Each shown roadmap's goal milestones: its own, and each dated-or-not milestone of
    the PRDs its items come from (materialised as rows on first read). One read for all the
    roadmaps' rows, so the roadmap read stays bulk. ``ends``: each item's title and end
    date, for each milestone's status (milestone-kinds)."""
    if not docs:
        return []
    rows = await _rows(db, list(docs))
    prds_by_id = {p.id: p for of in kd_prds.values() for p in of}
    goal_of: dict[tuple[uuid.UUID, uuid.UUID], uuid.UUID] = {}
    for e in entries:
        if e.prd is not None and e.goal is not None:
            goal_of.setdefault((e.roadmap.id, e.prd.id), e.goal.id)
    have = {(r.roadmap_id, r.origin_prd_id, r.code): r for r in rows if r.origin_prd_id}
    new: list[dict[str, Any]] = []
    for doc_id in docs:
        for prd in kd_prds.get(doc_id, []):
            view = views.get(prd.id)
            for m in view.milestones if view is not None else []:
                row = have.get((doc_id, prd.id, m.code))
                if row is None:
                    new.append({
                        "id": uuid.uuid5(prd.id, f"goal-milestone:{doc_id}:{m.code}"),
                        "track_id": None, "roadmap_id": doc_id,
                        "goal_id": goal_of.get((doc_id, prd.id)), "origin_prd_id": prd.id,
                        "code": m.code, "name": m.name, "target_date": m.end_date,
                        "plan_date": m.end_date,
                    })  # fmt: skip
                    continue
                if row.pending_change:
                    continue
                to: dict[str, Any] = {}
                if row.name != m.name:
                    to["name"] = m.name
                if row.plan_date != m.end_date:
                    to["target_date"] = to["plan_date"] = m.end_date
                if to:
                    await db.execute(
                        update(TrackMilestone)
                        .where(TrackMilestone.id == row.id, _no_pending)
                        .values(**to, lock_version=TrackMilestone.lock_version + 1)
                        .execution_options(synchronize_session=False)
                    )
                    new.append({})
    if new:
        # Two first reads at once both insert the same uuid5 row: the later one skips it.
        if rows_in := [n for n in new if n]:
            await db.execute(
                pg_insert(TrackMilestone)
                .values([{**n, "tenant_id": current_tenant(db)} for n in rows_in])
                .on_conflict_do_nothing()
            )
        await db.commit()
        rows = await _rows(db, list(docs), fresh=True)
    in_plan = {
        (doc_id, prd.id, m.code)
        for doc_id in docs
        for prd in kd_prds.get(doc_id, [])
        for m in (views[prd.id].milestones if views.get(prd.id) is not None else [])
    }
    shown = [
        r for r in rows
        if (r.origin_prd_id is None and r.deleted_at is None)
        or (r.roadmap_id, r.origin_prd_id, r.code) in in_plan
    ]  # fmt: skip
    if not shown:
        return []
    w = await drafts.who(db, set(docs) | set(prds_by_id))
    first_owners = {
        sorted(w.owners[p], key=str)[0] for p in prds_by_id if w.owners.get(p)
    }  # fmt: skip
    names = {
        u.id: display_name(u.email, u.name)
        for u in (await db.scalars(select(User).where(User.id.in_(first_owners))))
    } if first_owners else {}  # fmt: skip
    look = await _lookups(db, shown)
    out = [
        await _out(
            db,
            principal,
            r,
            docs[r.roadmap_id],
            prds_by_id.get(r.origin_prd_id),  # type: ignore[arg-type]
            w,
            names,
            ends,
            today,
            look,
        )
        for r in shown
    ]
    await with_asks(db, principal, out, w)
    subs: dict[uuid.UUID, list[uuid.UUID]] = {}
    for m in out:
        if m.sub_goal_of_id is not None:
            subs.setdefault(m.sub_goal_of_id, []).append(m.id)
    for m in out:
        m.sub_goal_ids = subs.get(m.id, [])
    # old-milestones: each one brought over from an older roadmap names it (one read).
    came = (
        await db.execute(
            select(TrackMilestone.carried_to_id, Document)
            .join(Document, Document.id == TrackMilestone.roadmap_id)
            .where(TrackMilestone.carried_to_id.in_([m.id for m in out]))
        )
    ).all()
    from_ = {to: SimpleDocRef(id=d.id, slug=d.slug, title=d.title) for to, d in came}
    for m in out:
        m.carried_from = from_.get(m.id)
    out.sort(key=lambda m: (str(m.roadmap_id), m.goal_id is None, str(m.goal_id), m.code))
    return out


# --------------------------------------------------------------------------- writing


async def _next_code(db: AsyncSession, roadmap_id: uuid.UUID, goal_id: uuid.UUID | None) -> str:
    n = 0
    for c in await db.scalars(
        select(TrackMilestone.code).where(
            TrackMilestone.roadmap_id == roadmap_id,
            TrackMilestone.goal_id == goal_id,
            TrackMilestone.deleted_at.is_(None),
            TrackMilestone.code.is_not(None),
        )
    ):
        m = _CODE.match(c or "")
        if m:
            n = max(n, int(m[1]))
    return f"M{n + 1}"


async def _regoal(db: AsyncSession, row: TrackMilestone, goal_id: uuid.UUID | None) -> None:
    """every-field-editable: a milestone moved to another goal takes that goal's next code
    (M<n> is numbered per goal, so the code it had may be the new goal's already)."""
    if goal_id == row.goal_id:
        return
    if row.roadmap_id is not None and row.code:
        with db.no_autoflush:
            row.code = await _next_code(db, row.roadmap_id, goal_id)
    row.goal_id = goal_id


async def _roadmap_or_404(db: AsyncSession, roadmap_id: uuid.UUID) -> Document:
    doc = await db.get(Document, roadmap_id)
    if doc is None or doc.kind != "roadmap":
        raise _error(status.HTTP_404_NOT_FOUND, "No such roadmap")
    return doc


async def _not_history(db: AsyncSession, roadmap_id: uuid.UUID) -> None:
    """While the company roadmap exists an older per-PRD roadmap is history
    (oracle.roadmap.company.feeding_ids): its milestones are not added to or changed."""
    if not await company.feeding_ids(db, [roadmap_id]):
        raise _error(status.HTTP_409_CONFLICT, "That roadmap is history")


async def create(
    db: AsyncSession, principal: Any, body: SimpleGoalMilestoneIn
) -> SimpleGoalMilestone:
    roadmap = await _roadmap_or_404(db, body.roadmap_id)
    await _not_history(db, body.roadmap_id)
    w = await drafts.who(db, {body.roadmap_id})
    if not drafts.can_edit(principal, body.roadmap_id, w):
        raise _error(status.HTTP_403_FORBIDDEN,
                     "Only an owner or the roadmap's decider (with none, its owner) "
                     "changes its milestones")  # fmt: skip
    await _check_refs(db, body.model_dump(include=body.model_fields_set))
    code = await _next_code(db, body.roadmap_id, body.goal_id)
    row = TrackMilestone(
        track_id=None, roadmap_id=body.roadmap_id, goal_id=body.goal_id, code=code,
        name=body.name, target_date=body.date, item_ids=body.item_ids,
        counts_when=body.counts_when, created_by=_me(principal),
    )  # fmt: skip
    _write_kind(row, body, set(body.model_fields_set) | {"kind", "done_when_line"}, principal)
    db.add(row)
    await db.flush()
    await audit.record(db, principal, "goal_milestone.create", "track_milestone", row.id,
                       data={"roadmap_id": str(body.roadmap_id), "code": code})  # fmt: skip
    await db.commit()
    return await _out(db, principal, row, roadmap, None, w)


def _write_kind(row: TrackMilestone, body: Any, fields: set[str], principal: Any) -> None:
    """milestone-kinds: the kind fields sent (``kind`` and ``done_when_line`` are never
    null); setting the status names who set it, clearing it clears who and why."""
    for k in KIND_FIELDS:
        if k not in fields:
            continue
        v = getattr(body, k)
        if k in ("kind", "done_when_line") and v is None:
            continue
        setattr(row, k, Decimal(str(v)) if k in _NUMBERS and v is not None else v)
    if "status_set" in fields:
        row.status_set_by = _me(principal) if body.status_set else None
        if body.status_set is None and "status_reason" not in fields:
            row.status_reason = None


def _uid(v: Any) -> uuid.UUID | None:
    return v if isinstance(v, uuid.UUID) or v is None else uuid.UUID(str(v))


async def _check_refs(
    db: AsyncSession,
    given: dict[str, Any],
    row: TrackMilestone | None = None,
    changed: set[str] | None = None,
) -> None:
    """A sub-goal's goal milestone, and the home, from and to tracks, must exist (422, not a
    500): a sub-goal builds toward another milestone of kind goal (never itself), a hand-off
    goes between two tracks. ``given``: the fields sent (the rest are ``row``'s); ``changed``
    (default: those sent): the refs looked up, so one gone meanwhile does not block an edit
    of something else."""
    keys = ("kind", *_UUID_FIELDS)
    now = {k: (given[k] if k in given else getattr(row, k, None)) for k in keys}
    ids = {k: _uid(now[k]) for k in _UUID_FIELDS}
    looked = set(given) if changed is None else changed
    parent = ids["sub_goal_of_id"]
    if "sub_goal_of_id" in looked and parent is not None:
        if row is not None and parent == row.id:
            raise _error(422, "sub_goal_of_id: a sub-goal builds toward another milestone")
        to = await db.get(TrackMilestone, parent)
        if to is None or to.roadmap_id is None or to.deleted_at is not None:
            raise _error(422, "sub_goal_of_id: no such milestone")
        if (to.kind or "delivery") != "goal":
            raise _error(422, "sub_goal_of_id: a sub-goal builds toward a goal milestone")
        roadmap_id = _uid(given.get("roadmap_id")) or getattr(row, "roadmap_id", None)
        if roadmap_id is not None and to.roadmap_id != roadmap_id:
            raise _error(422, "sub_goal_of_id: a sub-goal builds toward a goal milestone "
                              "on the same roadmap")  # fmt: skip
    # A goal milestone sub-goals build toward stays a goal until none does.
    if row is not None and "kind" in given and (row.kind or "delivery") == "goal":
        if now["kind"] is not None and now["kind"] != "goal":
            subs = list(await db.scalars(
                select(TrackMilestone.name).where(
                    TrackMilestone.sub_goal_of_id == row.id, TrackMilestone.deleted_at.is_(None)
                ).order_by(TrackMilestone.name)
            ))  # fmt: skip
            if subs:
                raise _error(422, "kind: sub-goals build toward this goal ("
                                  f"{', '.join(subs)}); point them elsewhere first")  # fmt: skip
    history: set[uuid.UUID] | None = None
    for k in ("home_track_id", "from_track_id", "to_track_id"):
        if k in looked and ids[k] is not None:
            t = await db.get(ProductTrack, ids[k])
            if t is None or getattr(t, "deleted_at", None) is not None:
                raise _error(422, f"{k}: no such track")
            if history is None:
                history = await company.history_track_ids(db)
            if t.id in history:
                raise _error(422, f"{k}: that track is a replaced PRD's history")
    hand = ids["from_track_id"], ids["to_track_id"]
    if hand[0] is not None and hand[0] == hand[1] and looked & {"from_track_id", "to_track_id"}:
        raise _error(422, "to_track_id: a hand-off goes to another track")


async def _get_or_404(db: AsyncSession, milestone_id: uuid.UUID) -> TrackMilestone:
    row = await db.get(TrackMilestone, milestone_id, with_for_update=True)
    if row is None or row.roadmap_id is None:
        raise _error(status.HTTP_404_NOT_FOUND, "No such milestone")
    return row


async def patch(
    db: AsyncSession, principal: Any, milestone_id: uuid.UUID, body: SimpleGoalMilestonePatch
) -> SimpleGoalMilestone:
    if await db.get(TrackMilestone, milestone_id) is None:
        found = await _target(db, milestone_id)
        if found is not None:
            return await rename_target(db, principal, *found, body)
    row = await _get_or_404(db, milestone_id)
    if row.deleted_at is not None:
        raise _error(status.HTTP_404_NOT_FOUND, "No such milestone")
    fields = body.model_fields_set
    roadmap = await db.get(Document, row.roadmap_id)
    await _not_history(db, row.roadmap_id)
    if row.origin_prd_id is not None:
        return await _propose_prd_change(db, principal, row, roadmap, body, fields)
    w = await drafts.who(db, {row.roadmap_id})
    if not drafts.can_edit(principal, row.roadmap_id, w):
        raise _error(status.HTTP_403_FORBIDDEN,
                     "Only an owner or the roadmap's decider (with none, its owner) "
                     "changes its milestones")  # fmt: skip
    await _check_refs(db, body.model_dump(include=fields), row)
    if "name" in fields and body.name is not None:
        row.name = body.name
    if "date" in fields:
        row.target_date = body.date
    if "goal_id" in fields:
        await _regoal(db, row, body.goal_id)
    if "item_ids" in fields and body.item_ids is not None:
        row.item_ids = body.item_ids
    if "counts_when" in fields and body.counts_when is not None:
        row.counts_when = body.counts_when
    _write_kind(row, body, fields, principal)
    await db.flush()
    await audit.record(db, principal, "goal_milestone.edit", "track_milestone", row.id, data={})
    await db.commit()
    return await _out(db, principal, row, roadmap, None, w)


# --------------------------------------------------------------------------- goal targets


def target_name(goal: Any) -> str:
    """milestone-rename: a goal's own milestone's name: its own once renamed, else the
    goal's title (renaming the milestone never renames the goal)."""
    own = (goal.attrs or {}).get("milestone_name")
    return own if isinstance(own, str) and own.strip() else goal.title


async def target_rights(db: AsyncSession, principal: Any, out: list[SimpleGoalMilestone]) -> None:
    """Who decides the roadmap a goal's milestone sits on renames it; anyone else who may
    propose proposes it; its open proposal reads as ``pending``."""
    w = await drafts.who(db, {m.roadmap_id for m in out})
    for m in out:
        m.can_change = drafts.can_edit(principal, m.roadmap_id, w)
        m.can_propose = not m.can_change and _may_propose(principal)
    await with_asks(db, principal, out, w)


async def _target(db: AsyncSession, goal_id: uuid.UUID) -> tuple[Any, uuid.UUID] | None:
    """A goal on the roadmap with a date (its milestone's id is the goal's) and the roadmap
    its milestone sits on (the company roadmap, else the first roadmap), else None."""
    from oracle.baseline.models import Entity
    from oracle.simple.service import _goal_due

    goal = await db.get(Entity, goal_id, with_for_update=True)
    if goal is None or goal.type != "goal" or not goal.on_roadmap or _goal_due(goal) is None:
        return None
    active = await company.active(db)
    rid = getattr(active, "id", None) or await db.scalar(
        select(Document.id).where(Document.kind == "roadmap").order_by(Document.created_at).limit(1)
    )
    return (goal, rid) if rid is not None else None


def _set_target_name(db: AsyncSession, goal: Any, name: str, actor: str) -> None:
    """The goal's own milestone's name, in the goal's attrs, with the goal's revision."""
    from oracle.baseline import service as baseline

    before = baseline.entity_snapshot(goal)
    attrs = dict(goal.attrs or {})
    if name.strip() == goal.title:
        attrs.pop("milestone_name", None)
    else:
        attrs["milestone_name"] = name.strip()
    goal.attrs = attrs
    baseline.revise(db, actor, goal, before, "Goal milestone renamed")


async def rename_target(
    db: AsyncSession, principal: Any, goal: Any, rid: uuid.UUID, body: SimpleGoalMilestonePatch
) -> SimpleGoalMilestone:
    """PATCH on a goal's own milestone: its name alone (date, goal and items are the
    goal's, changed on the goal)."""
    from oracle.simple.service import _goal_due

    fields = body.model_fields_set
    if fields != {"name"} or not (body.name or "").strip():
        raise _error(422, "A goal's milestone: only its name changes here (the rest is the goal's)")
    w = await drafts.who(db, {rid})
    if not drafts.can_edit(principal, rid, w):
        raise _error(status.HTTP_403_FORBIDDEN,
                     "Only an owner or the roadmap's decider (with none, its owner) "
                     "changes its milestones")  # fmt: skip
    _set_target_name(db, goal, body.name, principal.actor)  # type: ignore[arg-type]
    await db.flush()
    await audit.record(db, principal, "goal_milestone.rename", "entity", goal.id, data={})
    await db.commit()
    return SimpleGoalMilestone(
        id=goal.id, roadmap_id=rid, code="", name=target_name(goal), date=_goal_due(goal),
        goal_id=goal.id, kind="goal", goal_target=True, can_change=True,
    )  # fmt: skip


async def _apply_prd(db: AsyncSession, row: TrackMilestone, after: dict[str, Any]) -> None:
    """Writes a PRD milestone's accepted change; a new name also goes into the PRD's
    stored plan (the milestone is re-read from it)."""
    from oracle.simple.models import SimplePrdPlan

    if "date" in after:
        row.target_date = date.fromisoformat(after["date"]) if after.get("date") else None
    if "counts_when" in after:
        row.counts_when = after.get("counts_when") or ""
    if after.get("name"):
        row.name = after["name"]
        plan = await db.scalar(
            select(SimplePrdPlan).where(SimplePrdPlan.document_id == row.origin_prd_id)
        )
        if plan is not None and isinstance(plan.data, dict):
            ms = [
                {**m, "name": after["name"]} if isinstance(m, dict) and m.get("code") == row.code
                else m
                for m in plan.data.get("milestones") or []
            ]  # fmt: skip
            plan.data = {**plan.data, "milestones": ms}


async def _propose_prd_change(
    db: AsyncSession,
    principal: Any,
    row: TrackMilestone,
    roadmap: Document,
    body: SimpleGoalMilestonePatch,
    fields: set[str],
) -> SimpleGoalMilestone:
    if (
        fields & {"goal_id", "item_ids", *KIND_FIELDS}
        or not (fields & {"name", "date", "counts_when"})
        or ("name" in fields and not (body.name or "").strip())
    ):
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY,
                     "A PRD's milestone: only name, date and counts_when may be proposed "
                     "(goal and items are the roadmap's own)")  # fmt: skip
    if not _may_propose(principal):
        raise _error(status.HTTP_403_FORBIDDEN, "Viewers may not propose a change")
    w = await drafts.who(db, {row.origin_prd_id})
    owners = sorted(w.owners.get(row.origin_prd_id, set()), key=str)
    routed = owners or await _company_owners(db)
    before = {
        "date": row.target_date.isoformat() if row.target_date else None,
        "counts_when": row.counts_when,
    }
    after = {
        "date": (body.date.isoformat() if body.date else None) if "date" in fields
        else before["date"],
        "counts_when": body.counts_when if "counts_when" in fields else before["counts_when"],
    }  # fmt: skip
    if "name" in fields:
        before["name"], after["name"] = row.name, (body.name or "").strip()
    # milestone-rename: the PRD's owner (or a company owner) renames its milestone directly;
    # the PRD's stored plan takes the name, so a later read keeps it.
    me = _me(principal)
    if fields == {"name"} and (has_role(principal.role, "owner") or me in owners):
        await _apply_prd(db, row, after)
        await db.flush()
        await audit.record(db, principal, "goal_milestone.edit", "track_milestone", row.id,
                           data={})  # fmt: skip
        await db.commit()
        prd = await db.get(Document, row.origin_prd_id)
        return await _out(db, principal, row, roadmap, prd, w)
    c = SimpleChange(
        document_id=row.origin_prd_id, op="edit_goal_milestone",
        target={"milestone_id": str(row.id), "roadmap_id": str(row.roadmap_id),
                "name": row.name},
        before=before, after=after, status="proposed", by=_me(principal),
        at=company_time.now(), routed_to=routed,
    )  # fmt: skip
    db.add(c)
    await db.flush()
    row.pending_change = {
        **after, "name": after["name"] if after.get("name") != before.get("name") else None,
        "change_id": str(c.id),
        "asked_of_name": await _name_of(db, routed[0]) if routed else None,
    }  # fmt: skip
    await db.flush()
    await audit.record(db, principal, "simple_change.proposed", "simple_change", c.id,
                       data={"op": c.op, "target": c.target})  # fmt: skip
    await db.commit()
    prd = await db.get(Document, row.origin_prd_id)
    return await _out(db, principal, row, roadmap, prd, w)


async def delete(db: AsyncSession, principal: Any, milestone_id: uuid.UUID) -> None:
    row = await _get_or_404(db, milestone_id)
    if row.deleted_at is not None:
        raise _error(status.HTTP_404_NOT_FOUND, "No such milestone")
    if row.origin_prd_id is not None:
        raise _error(status.HTTP_409_CONFLICT, "A PRD's milestone is not deleted here")
    w = await drafts.who(db, {row.roadmap_id})
    if not drafts.can_edit(principal, row.roadmap_id, w):
        raise _error(status.HTTP_403_FORBIDDEN,
                     "Only an owner or the roadmap's decider (with none, its owner) "
                     "changes its milestones")  # fmt: skip
    # goal-map-editing: it goes to Settings > Trash (its features stay linked to it).
    from oracle.trash import service as trash

    await trash.delete_milestone(db, principal, row)
    row.deleted_by = _me(principal)
    await db.flush()
    await audit.record(db, principal, "goal_milestone.delete", "track_milestone", row.id, data={})
    await db.commit()


async def restore(db: AsyncSession, principal: Any, milestone_id: uuid.UUID) -> SimpleGoalMilestone:
    row = await _get_or_404(db, milestone_id)
    if row.deleted_at is None:
        raise _error(status.HTTP_404_NOT_FOUND, "No such deleted milestone")
    w = await drafts.who(db, {row.roadmap_id})
    if not drafts.can_edit(principal, row.roadmap_id, w):
        raise _error(status.HTTP_403_FORBIDDEN,
                     "Only an owner or the roadmap's decider (with none, its owner) "
                     "changes its milestones")  # fmt: skip
    await put_back(db, row)
    from oracle.trash import service as trash

    await trash.milestone_restored(db, row.id)
    await db.flush()
    await audit.record(db, principal, "goal_milestone.restore", "track_milestone", row.id, data={})
    await db.commit()
    roadmap = await db.get(Document, row.roadmap_id)
    return await _out(db, principal, row, roadmap, None, w)


async def put_back(db: AsyncSession, row: TrackMilestone) -> None:
    """Restore a removed milestone, any time after it was removed (removed-tracks): its
    code again unless another milestone of its goal took it meanwhile (then the next)."""
    if row.roadmap_id is not None and row.code:
        taken = await db.scalar(
            select(TrackMilestone.id).where(
                TrackMilestone.roadmap_id == row.roadmap_id,
                TrackMilestone.goal_id.is_(None) if row.goal_id is None
                else TrackMilestone.goal_id == row.goal_id,
                TrackMilestone.code == row.code,
                TrackMilestone.deleted_at.is_(None),
                TrackMilestone.id != row.id,
            )
        )  # fmt: skip
        if taken is not None:
            row.code = await _next_code(db, row.roadmap_id, row.goal_id)
    row.deleted_at = row.deleted_by = None


# --------------------------------------------------------------------------- the change engine

FIELDS = ("name", "date", "goal_id", "item_ids", "counts_when", *KIND_FIELDS)
# Fields a proposal may set to null (the rest keep their value when sent null).
_NULLABLE = {"goal_id", "status_set", "status_reason", "measure", *_NUMBERS, *_UUID_FIELDS}


def _value(row: TrackMilestone) -> dict[str, Any]:
    """A roadmap's own milestone as a proposal's ``before``/``after.milestone`` holds it."""
    return {
        "name": row.name,
        "date": row.target_date.isoformat() if row.target_date else None,
        "goal_id": str(row.goal_id) if row.goal_id else None,
        "item_ids": [str(i) for i in row.item_ids or []],
        "counts_when": row.counts_when or "",
        "kind": row.kind or "delivery",
        "done_when_line": row.done_when_line or "",
        "status_set": row.status_set,
        "status_reason": row.status_reason,
        "measure": row.measure,
        **{k: _f(getattr(row, k)) for k in _NUMBERS},
        **{k: str(getattr(row, k)) if getattr(row, k) else None for k in _UUID_FIELDS},
    }


def _moved(current: dict[str, Any], after: dict[str, Any]) -> set[str]:
    """The refs a proposal's ``after.milestone`` changes from the milestone as it is."""
    return {k for k in ("kind", *_UUID_FIELDS) if k in after and after[k] != current.get(k)}


def _same(row: TrackMilestone, seen: dict[str, Any]) -> bool:
    """The milestone is as ``seen`` names it (only the fields named: a proposal made before
    milestone-kinds names none of the kind fields)."""
    now = _value(row)
    return seen == {k: now[k] for k in seen}


def _checked(given: Any) -> dict[str, Any]:
    if not isinstance(given, dict):
        raise _error(422, "after.milestone: the milestone as it should be (or null to remove it)")
    try:
        v = SimpleGoalMilestonePatch.model_validate({k: given[k] for k in FIELDS if k in given})
    except ValueError as e:
        raise _error(422, f"after.milestone: {e}") from None
    return {k: getattr(v, k) for k in v.model_fields_set}


async def create_change(db: AsyncSession, principal: Any, body: Any) -> Any:
    """milestone-rights: ``POST /v1/simple/changes`` op ``edit_goal_milestone`` on a roadmap's
    own milestone (``target.milestone_id``; ``before.milestone`` as the caller saw it,
    ``after.milestone`` as it should be, null: removed). Who may propose but not change it
    (an approver who is not its owner, a commenter) proposes it, routed as a key date's
    proposal is (``key_dates.route``); who changes it directly changes it on its card."""
    from oracle.simple import changes, key_dates
    from oracle.simple.schemas import SimpleChangeResult

    if not _may_propose(principal):
        raise _error(status.HTTP_403_FORBIDDEN, "Viewers may not propose a change")
    milestone_id = changes._uuid(body.target.get("milestone_id"), "milestone_id")
    row = await db.get(TrackMilestone, milestone_id, with_for_update=True)
    if row is None and (found := await _target(db, milestone_id)) is not None:
        return await _propose_target(db, principal, *found, body)
    if row is None or row.roadmap_id is None or row.deleted_at is not None:
        raise _error(status.HTTP_404_NOT_FOUND, "No such milestone")
    if row.origin_prd_id is not None:
        raise _error(422, "A PRD's milestone: change it on its card (it asks the PRD's owner)")
    w = await drafts.who(db, {row.roadmap_id})
    if drafts.can_edit(principal, row.roadmap_id, w):
        raise _error(status.HTTP_409_CONFLICT, "You change this milestone directly")
    if "milestone" not in body.before or "milestone" not in body.after:
        raise _error(422, "before.milestone and after.milestone (null: remove it)")
    current = _value(row)
    # every-field-editable: ``before.milestone`` may name only the fields the caller saw (the
    # Goal ladder moves a key result by its goal alone); each one named is checked.
    seen_ = body.before["milestone"]
    if not isinstance(seen_, dict) or not seen_ or set(seen_) - set(FIELDS):
        raise _error(422, f"before.milestone: the milestone as you saw it ({', '.join(FIELDS)})")
    if seen_ != {k: current[k] for k in seen_}:
        raise _error(status.HTTP_409_CONFLICT,
                     {"message": "Changed since you saw it", "current": {"milestone": current},
                      "changed_by": None, "changed_at": None})  # fmt: skip
    wanted = body.after["milestone"]
    after = None
    if wanted is not None:
        given = _checked(wanted)
        after = {**current, **{k: v for k, v in given.items() if v is not None or k in _NULLABLE}}
        after = {**after, "date": str(after["date"]) if after["date"] else None,
                 "goal_id": str(after["goal_id"]) if after["goal_id"] else None,
                 "item_ids": [str(i) for i in after["item_ids"]],
                 **{k: str(after[k]) if after[k] else None for k in _UUID_FIELDS}}  # fmt: skip
        if after == current:
            raise _error(422, "after.milestone: nothing changes")
        await _check_refs(db, after, row, _moved(current, after))
    c = SimpleChange(
        document_id=row.roadmap_id, op="edit_goal_milestone",
        target={"milestone_id": str(row.id), "roadmap_id": str(row.roadmap_id),
                "name": row.name},
        before={"milestone": current}, after={"milestone": after}, status="proposed",
        by=_me(principal), at=company_time.now(), reason=body.reason,
        routed_to=await key_dates.route(db, row.roadmap_id, w),
    )  # fmt: skip
    db.add(c)
    await db.flush()
    await audit.record(db, principal, "simple_change.proposed", "simple_change", c.id,
                       data={"op": c.op, "target": c.target})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def _propose_target(db: AsyncSession, principal: Any, goal: Any, rid: uuid.UUID,
                          body: Any) -> Any:  # fmt: skip
    """milestone-rename: a proposed name for a goal's own milestone (``before`` and
    ``after.milestone``: its name alone), routed to who decides its roadmap."""
    from oracle.simple import changes, key_dates
    from oracle.simple.schemas import SimpleChangeResult

    w = await drafts.who(db, {rid})
    if drafts.can_edit(principal, rid, w):
        raise _error(status.HTTP_409_CONFLICT, "You change this milestone directly")
    seen_, wanted = (body.before or {}).get("milestone"), (body.after or {}).get("milestone")
    if not isinstance(seen_, dict) or set(seen_) != {"name"} or not isinstance(wanted, dict) \
            or set(wanted) != {"name"} or not str(wanted["name"] or "").strip():  # fmt: skip
        raise _error(422, "A goal's milestone: before.milestone and after.milestone name it alone")
    current = target_name(goal)
    if seen_["name"] != current:
        raise _error(status.HTTP_409_CONFLICT,
                     {"message": "Changed since you saw it",
                      "current": {"milestone": {"name": current}},
                      "changed_by": None, "changed_at": None})  # fmt: skip
    name = str(wanted["name"]).strip()[:200]
    if name == current:
        raise _error(422, "after.milestone: nothing changes")
    c = SimpleChange(
        document_id=rid, op="edit_goal_milestone",
        target={"milestone_id": str(goal.id), "roadmap_id": str(rid), "name": current,
                "goal_target": True},
        before={"milestone": {"name": current}}, after={"milestone": {"name": name}},
        status="proposed", by=_me(principal), at=company_time.now(), reason=body.reason,
        routed_to=await key_dates.route(db, rid, w),
    )  # fmt: skip
    db.add(c)
    await db.flush()
    await audit.record(db, principal, "simple_change.proposed", "simple_change", c.id,
                       data={"op": c.op, "target": c.target})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


def may_decide(principal: Any, c: SimpleChange, view: Any) -> bool:
    """A PRD's milestone: an owner or the PRD's owner; a roadmap's own: as a key date's."""
    from oracle.simple import key_dates

    if "milestone" in (c.before or {}):
        return key_dates.may_decide(principal, c, view)
    me = _me(principal)
    owners = view.owners.get(c.document_id, set()) if c.document_id else set()
    return has_role(principal.role, "owner") or (me is not None and me in owners)


async def _decide_own(db: AsyncSession, principal: Any, c: SimpleChange, action: str,
                      reason: str | None) -> Any:  # fmt: skip
    from oracle.simple.changes import ChangeError, one_out
    from oracle.simple.schemas import SimpleChangeResult

    me, now = _me(principal), company_time.now()
    w = await drafts.who(db, {c.document_id} if c.document_id else set())
    view = type("V", (), {"deciders": w.deciders, "owners": w.owners})
    if not may_decide(principal, c, view):
        raise ChangeError(403, "Only an owner or the roadmap's decider (with none, its owner) "
                               "decides this proposal")  # fmt: skip
    if action == "accept" and c.target.get("goal_target"):
        found = await _target(db, uuid.UUID(c.target["milestone_id"]))
        if found is None:
            raise ChangeError(404, "The milestone is gone")
        if target_name(found[0]) != c.before["milestone"]["name"]:
            raise ChangeError(409, {"message": "outdated: the milestone changed since the proposal",
                                    "current": {"milestone": {"name": target_name(found[0])}},
                                    "changed_by": None, "changed_at": None})  # fmt: skip
        _set_target_name(db, found[0], c.after["milestone"]["name"], principal.actor)
    elif action == "accept":
        row = await db.get(TrackMilestone, uuid.UUID(c.target["milestone_id"]),
                           with_for_update=True)  # fmt: skip
        if row is None or row.deleted_at is not None:
            raise ChangeError(404, "The milestone is gone")
        seen = c.before.get("milestone")
        if not isinstance(seen, dict) or not _same(row, seen):
            raise ChangeError(409, {"message": "outdated: the milestone changed since the proposal",
                                    "current": {"milestone": _value(row)}, "changed_by": None,
                                    "changed_at": None})  # fmt: skip
        after = c.after.get("milestone")
        if after is None:
            row.deleted_at = now
        else:
            # What it names may have gone since it was proposed: refused (422), not a 500.
            try:
                await _check_refs(db, after, row, _moved(_value(row), after))
            except HTTPException as e:
                raise ChangeError(e.status_code, e.detail) from None
            row.name = after["name"]
            row.target_date = date.fromisoformat(after["date"]) if after["date"] else None
            await _regoal(db, row, uuid.UUID(after["goal_id"]) if after["goal_id"] else None)
            row.item_ids = [uuid.UUID(i) for i in after["item_ids"]]
            row.counts_when = after["counts_when"]
            was = row.status_set
            for k in KIND_FIELDS:
                if k not in after:
                    continue
                v = after[k]
                if k in _UUID_FIELDS:
                    v = uuid.UUID(v) if v else None
                elif k in _NUMBERS:
                    v = Decimal(str(v)) if v is not None else None
                if k in ("kind", "done_when_line") and v is None:
                    continue
                setattr(row, k, v)
            if row.status_set != was:
                row.status_set_by = c.by if row.status_set else None
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = me, now, reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])


async def decide(db: AsyncSession, principal: Any, c: SimpleChange, action: str,
                 reason: str | None) -> Any:  # fmt: skip
    """Wired from ``oracle.simple.changes.decide``: the PRD owner accepts or declines a
    goal milestone's proposed date/counts_when. Accepting writes it onto the milestone and
    clears ``pending_change``; declining only clears it (or, when the milestone is gone or
    its ``pending_change`` names another change, only closes the proposal). A milestone in the
    Trash counts as gone: it is declined, never accepted."""
    from oracle.simple.changes import ChangeError, one_out

    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if "milestone" in (c.before or {}):
        return await _decide_own(db, principal, c, action, reason)
    me, now = _me(principal), company_time.now()
    w = await drafts.who(db, {c.document_id} if c.document_id else set())
    owners = w.owners.get(c.document_id, set()) if c.document_id else set()
    if not (has_role(principal.role, "owner") or (me is not None and me in owners)):
        raise ChangeError(403, "Only the PRD's owner decides this")
    milestone_id = uuid.UUID(c.target["milestone_id"])
    row = await db.get(TrackMilestone, milestone_id, with_for_update=True)
    pending = (row.pending_change if row is not None else None) or {}
    waits = str(pending.get("change_id")) == str(c.id)
    # A proposal whose milestone is gone (or in the Trash) or moved on to another change is
    # still declined (only the proposal closes; the milestone and its other change are left
    # as they are), so it never waits forever; accepting it is refused.
    if action == "accept" and (row is None or row.deleted_at is not None):
        raise ChangeError(404, "The milestone is gone")
    if action == "accept" and not waits:
        raise ChangeError(409, {"message": "This proposal no longer waits on this milestone",
                                "current": None, "changed_by": None,
                                "changed_at": None})  # fmt: skip
    if action == "accept":
        await _apply_prd(db, row, c.after)
    if waits:
        row.pending_change = None
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = me, now, reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    from oracle.simple.schemas import SimpleChangeResult

    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])
