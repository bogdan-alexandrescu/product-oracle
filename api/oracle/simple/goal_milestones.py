"""build-milestones-on-roadmap: milestones per goal on the Simple roadmap, reusing
Oracle's existing milestone model (``oracle.roadmap.models.TrackMilestone``,
``roadmap_id``/``goal_id`` set, ``track_id`` null) rather than a second table.

Own milestones (created here) are created, edited, deleted and restored directly by who
may change the roadmap (the same rule as a key date, ``drafts.can_edit``). A PRD's own
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
from oracle.roadmap.models import TrackMilestone
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
) -> SimpleGoalMilestone:
    pending = None
    if row.pending_change:
        pc = row.pending_change
        pending = SimpleMilestonePending(
            date=date.fromisoformat(pc["date"]) if pc.get("date") else None,
            counts_when=pc.get("counts_when"),
            asked_of=pc.get("asked_of_name"),
            change_id=uuid.UUID(pc["change_id"]) if pc.get("change_id") else None,
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
    return SimpleGoalMilestone(
        id=row.id, roadmap_id=row.roadmap_id, code=row.code or "", name=row.name,
        date=row.target_date, goal_id=row.goal_id, item_ids=list(row.item_ids or []),
        counts_when=row.counts_when, progress=row.progress,  # type: ignore[arg-type]
        prd=SimpleDocRef(id=prd.id, slug=prd.slug, title=prd.title) if prd is not None else None,
        prd_owner=prd_owner, pending=pending, can_change=can_change,
    )  # fmt: skip


async def list_for_roadmaps(
    db: AsyncSession,
    principal: Any,
    docs: dict[uuid.UUID, Document],
    entries: list[Any],
    views: dict[uuid.UUID, Any],
    kd_prds: dict[uuid.UUID, list[Document]],
) -> list[SimpleGoalMilestone]:
    """Each shown roadmap's goal milestones: its own, and each dated-or-not milestone of
    the PRDs its items come from (materialised as rows on first read). One read for all the
    roadmaps' rows, so the roadmap read stays bulk."""
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
    out = [
        await _out(
            db,
            principal,
            r,
            docs[r.roadmap_id],
            prds_by_id.get(r.origin_prd_id),  # type: ignore[arg-type]
            w,
            names,
        )
        for r in shown
    ]
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


async def _roadmap_or_404(db: AsyncSession, roadmap_id: uuid.UUID) -> Document:
    doc = await db.get(Document, roadmap_id)
    if doc is None or doc.kind != "roadmap":
        raise _error(status.HTTP_404_NOT_FOUND, "No such roadmap")
    return doc


async def create(
    db: AsyncSession, principal: Any, body: SimpleGoalMilestoneIn
) -> SimpleGoalMilestone:
    roadmap = await _roadmap_or_404(db, body.roadmap_id)
    w = await drafts.who(db, {body.roadmap_id})
    if not drafts.can_edit(principal, body.roadmap_id, w):
        raise _error(status.HTTP_403_FORBIDDEN,
                     "Only an owner or the roadmap's decider (with none, its owner) "
                     "changes its milestones")  # fmt: skip
    code = await _next_code(db, body.roadmap_id, body.goal_id)
    row = TrackMilestone(
        track_id=None, roadmap_id=body.roadmap_id, goal_id=body.goal_id, code=code,
        name=body.name, target_date=body.date, item_ids=body.item_ids,
        counts_when=body.counts_when, created_by=_me(principal),
    )  # fmt: skip
    db.add(row)
    await db.flush()
    await audit.record(db, principal, "goal_milestone.create", "track_milestone", row.id,
                       data={"roadmap_id": str(body.roadmap_id), "code": code})  # fmt: skip
    await db.commit()
    return await _out(db, principal, row, roadmap, None, w)


async def _get_or_404(db: AsyncSession, milestone_id: uuid.UUID) -> TrackMilestone:
    row = await db.get(TrackMilestone, milestone_id, with_for_update=True)
    if row is None or row.roadmap_id is None:
        raise _error(status.HTTP_404_NOT_FOUND, "No such milestone")
    return row


async def patch(
    db: AsyncSession, principal: Any, milestone_id: uuid.UUID, body: SimpleGoalMilestonePatch
) -> SimpleGoalMilestone:
    row = await _get_or_404(db, milestone_id)
    if row.deleted_at is not None:
        raise _error(status.HTTP_404_NOT_FOUND, "No such milestone")
    fields = body.model_fields_set
    roadmap = await db.get(Document, row.roadmap_id)
    if row.origin_prd_id is not None:
        return await _propose_prd_change(db, principal, row, roadmap, body, fields)
    w = await drafts.who(db, {row.roadmap_id})
    if not drafts.can_edit(principal, row.roadmap_id, w):
        raise _error(status.HTTP_403_FORBIDDEN,
                     "Only an owner or the roadmap's decider (with none, its owner) "
                     "changes its milestones")  # fmt: skip
    if "name" in fields and body.name is not None:
        row.name = body.name
    if "date" in fields:
        row.target_date = body.date
    if "goal_id" in fields:
        row.goal_id = body.goal_id
    if "item_ids" in fields and body.item_ids is not None:
        row.item_ids = body.item_ids
    if "counts_when" in fields and body.counts_when is not None:
        row.counts_when = body.counts_when
    await db.flush()
    await audit.record(db, principal, "goal_milestone.edit", "track_milestone", row.id, data={})
    await db.commit()
    return await _out(db, principal, row, roadmap, None, w)


async def _propose_prd_change(
    db: AsyncSession,
    principal: Any,
    row: TrackMilestone,
    roadmap: Document,
    body: SimpleGoalMilestonePatch,
    fields: set[str],
) -> SimpleGoalMilestone:
    if not (fields & {"date", "counts_when"}):
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY,
                     "A PRD's milestone: only date and counts_when may be proposed "
                     "(name, goal and items are the roadmap's own)")  # fmt: skip
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
        **after, "change_id": str(c.id),
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
    row.deleted_at = company_time.now()
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
    row.deleted_at = None
    await db.flush()
    await audit.record(db, principal, "goal_milestone.restore", "track_milestone", row.id, data={})
    await db.commit()
    roadmap = await db.get(Document, row.roadmap_id)
    return await _out(db, principal, row, roadmap, None, w)


# --------------------------------------------------------------------------- the change engine


async def decide(db: AsyncSession, principal: Any, c: SimpleChange, action: str,
                 reason: str | None) -> Any:  # fmt: skip
    """Wired from ``oracle.simple.changes.decide``: the PRD owner accepts or declines a
    goal milestone's proposed date/counts_when. Accepting writes it onto the milestone and
    clears ``pending_change``; declining only clears it."""
    from oracle.simple.changes import ChangeError, one_out

    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    me, now = _me(principal), company_time.now()
    w = await drafts.who(db, {c.document_id} if c.document_id else set())
    owners = w.owners.get(c.document_id, set()) if c.document_id else set()
    if not (has_role(principal.role, "owner") or (me is not None and me in owners)):
        raise ChangeError(403, "Only the PRD's owner decides this")
    milestone_id = uuid.UUID(c.target["milestone_id"])
    row = await db.get(TrackMilestone, milestone_id, with_for_update=True)
    if row is None:
        raise ChangeError(404, "The milestone is gone")
    pending = row.pending_change or {}
    if str(pending.get("change_id")) != str(c.id):
        raise ChangeError(409, {"message": "This proposal no longer waits on this milestone",
                                "current": None, "changed_by": None,
                                "changed_at": None})  # fmt: skip
    if action == "accept":
        after = c.after
        row.target_date = date.fromisoformat(after["date"]) if after.get("date") else None
        row.counts_when = after.get("counts_when") or ""
    row.pending_change = None
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = me, now, reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    from oracle.simple.schemas import SimpleChangeResult

    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])
