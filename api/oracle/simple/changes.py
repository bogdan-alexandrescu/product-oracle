"""Simple S3a (#723): the change engine. Every Simple edit of a roadmap item is a change
(``simple_changes``): ``{op, target, before, after, by, at}``.

**Who** (D4 and the owner's answers): an owner, the roadmap's decider, or, when the
roadmap names no decider, its owner (the item's track owner) applies a change directly
(oracle.simple.service.can_decide, the rule that decides date suggestions); approvers and
commenters propose it, routed to the decider, else the roadmap's owner, else the
company's owners, any one of whom accepts or declines it; viewers and runs are refused.
S3b: applied changes of a roadmap's items go into the roadmap's working draft
(oracle.simple.drafts), never into the published version's rows; readers who may see the
draft read the items as it has them, everyone else the published version.

**Concurrency**: ``before`` holds the fields the change writes as the caller saw them. When
the stored values differ, nothing is written: 409 with the current values and who changed
them last through Simple. Accepting a proposal checks its ``before`` the same way ("outdated:
changed by X"); an undo checks that the target still holds the change's ``after``.

**Sessions**: one open editing session per person (reused), or a meeting's. A session
closes when its starter closes it or after 30 minutes without a change (:func:`close_idle`,
from the minute tick); undo works only in the change's own open session, by its author,
and writes an ``undone`` row: history is never deleted.

**Flags**: every change re-runs S2's constraint checker (oracle.simple.constraints) and
returns the flags of the items it touched and their dependents; a proposal's are computed
as if applied, inside a savepoint that is rolled back.

Ops and the fields they write (``before`` must name the key fields):

- ``move_dates``: start_date, end_date (``date_source`` becomes typed).
- ``accept_date_suggestion``: the open suggestion's dates, or with ``after`` start_date
  and end_date the person's (the edit variant, D-b); ``date_source`` accepted; the
  suggestion is accepted (edited), reopened by an undo. 409 ``outdated`` when the item has
  dates now (``before`` names the undated item the suggestion was made for).
- ``confirm_item`` (S6): draft becomes false (422 unless the item is a draft); merging a
  draft is a ``cut`` with the reason "Merged into <code>".
- ``change_horizon``: horizon. ``reorder``: position. ``cut`` / ``restore``: cut.
- ``edit_title``: title. ``edit_outcome``: outcome.
- ``set_milestone`` (S9): the item's own milestone, ``{"milestone": {name, date,
  date_source: "typed"}}`` (date optional), or null to clear it.
- ``set_owner`` / ``set_decider`` (chat-actions): the item's own owner_id / decider_id, a
  member of the company (null: back to its track's owner / its roadmap's decider).
- ``accept_risk``: the risk accepted on one flag (``target.flag``, ``target.subject``),
  ``{"risk": {"note"}}``; ``before`` ``{"risk": null}`` when none is.
- ``shift_dependents``: the flagged item (``target.item_id``) starts the day after its
  dependency (``target.subject``) ends, keeping its length; its own dependents that would
  now overlap move the same way, transitively.
- ``move_dependency``: the dependency ends the day before the item starts, keeping its
  length. Both fixes key ``before``/``after`` by item id.
- ``add_key_date`` / ``edit_key_date`` / ``remove_key_date`` (roadmap-plus): a roadmap's
  key dates, into its working draft (oracle.simple.key_dates).
- ``add_item`` (S7): a new draft item; oracle.simple.additions makes it (its own rules for
  who applies, its undo removes the item).
- ``merge_item`` (S7): a draft (``target.item_id``) merged into another item of its
  roadmap (``target.into_id``): the kept item takes the draft's goal links, dependencies
  and note, the draft's dependents depend on the kept item, the draft closes
  (``merged_into``: the kept item's key); or linked to a baseline feature
  (``target.feature_id``). Keyed by item id like the fixes; ``before`` is read, not given.
- ``keep_both`` (S7): kept_both; the draft's look-alikes are no longer offered.
- ``cut_with_dependents`` (fix5-cut-dependents): the item and every item that waits on it,
  transitively (``dependents``), cut as one change, undone as one; ``before`` is the
  item's own ``{"cut"}`` as seen, and optionally ``"dependents"``, the ids of the
  dependents the caller saw (409 when the cut would take others); keyed by item id like
  the fixes; ``target.titles`` names every item it cut, the item first. It applies only
  when the caller decides every item it cuts (:func:`decides_all`); else it is proposed to
  the people who decide them all (:func:`cut_route`), else the company's owners.
"""

import uuid
from collections import deque
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import HORIZONS, RoadmapItem
from oracle.simple import drafts, service
from oracle.simple.models import RoadmapDateSuggestion, SimpleChange, SimpleDraft, SimpleSession
from oracle.simple.schemas import (
    InboxSimpleChange,
    SimpleChangeIn,
    SimpleChangeOut,
    SimpleChangeResult,
    SimpleFlag,
    SimpleItemFlags,
    SimpleSessionOut,
)

IDLE = timedelta(minutes=30)
# S8: a meeting's session closes when the meeting ends; idle this long, it closes anyway.
MEETING_IDLE = timedelta(hours=4)
DONE_DAYS = 30
TITLE_MAX = 200
OUTCOME_MAX = 1000
NOTE_MAX = 500
DATES = ("start_date", "end_date")
# Each single-item op's key fields: ``before`` must name them all.
FIELDS: dict[str, tuple[str, ...]] = {
    "move_dates": DATES,
    "accept_date_suggestion": DATES,
    "change_horizon": ("horizon",),
    "reorder": ("position",),
    "cut": ("cut",),
    "restore": ("cut",),
    "edit_title": ("title",),
    "edit_outcome": ("outcome",),
    "accept_risk": ("risk",),
    "confirm_item": ("draft",),
    "keep_both": ("kept_both",),
    "set_milestone": ("milestone",),
    "set_owner": ("owner_id",),
    "set_decider": ("decider_id",),
}
FIXES = ("shift_dependents", "move_dependency")
# fix5-cut-dependents: the item and every item that waits on it, cut as one change.
CUT_ALL = "cut_with_dependents"
# The ops that key ``before``/``after`` by item id.
KEYED = (*FIXES, "merge_item", CUT_ALL)
FLAG_KINDS = (
    "dependency_order",
    "blocker_date",
    "outside_milestone",
    "cut_with_dependents",
    "draft_without_owner",
)
WRITTEN = ("applied", "accepted", "undone")
# Roadmap-plus: a roadmap's key dates (oracle.simple.key_dates).
KEY_DATE_OPS = ("add_key_date", "edit_key_date", "remove_key_date")


class ChangeError(Exception):
    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(detail if isinstance(detail, str) else detail.get("message"))
        self.status = status
        self.detail = detail


def _me(principal: Any) -> uuid.UUID:
    me = getattr(principal, "user_id", None)
    if me is None:
        raise ChangeError(403, "Simple's changes are made by people")
    return me


# --------------------------------------------------------------------------- sessions


def _idle(s: SimpleSession, now: datetime) -> bool:
    return (s.last_change_at or s.started_at) <= now - (
        MEETING_IDLE if s.kind == "meeting" else IDLE
    )


def session_out(s: SimpleSession) -> SimpleSessionOut:
    return SimpleSessionOut(id=s.id, kind=s.kind, started_by=s.started_by, started_at=s.started_at,  # type: ignore[arg-type]
                      last_change_at=s.last_change_at, closed_at=s.closed_at)  # fmt: skip


async def close_idle(db: AsyncSession) -> int:
    """Close the sessions idle 30 minutes (the caller commits); how many."""
    now = company_time.now()
    n = 0
    for kind, idle in (("editing", IDLE), ("meeting", MEETING_IDLE)):
        res = await db.execute(
            update(SimpleSession)
            .where(
                SimpleSession.kind == kind,
                SimpleSession.closed_at.is_(None),
                (SimpleSession.last_change_at.is_(None) & (SimpleSession.started_at <= now - idle))
                | (SimpleSession.last_change_at <= now - idle),
            )
            .values(closed_at=now)
        )
        n += res.rowcount or 0
    return n


async def _open_editing(db: AsyncSession, me: uuid.UUID, now: datetime) -> SimpleSession | None:
    # One person's session starts one at a time: two crossing calls reuse one session
    # instead of meeting on the open-editing unique index (a 500).
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
        {"k": f"simple_sessions.editing:{me}"},
    )
    s = await db.scalar(
        select(SimpleSession)
        .where(
            SimpleSession.started_by == me,
            SimpleSession.kind == "editing",
            SimpleSession.closed_at.is_(None),
        )
        .with_for_update()
    )
    if s is not None and _idle(s, now):
        s.closed_at = now
        await db.flush()
        return None
    return s


async def start_session(db: AsyncSession, principal: Any, kind: str) -> SimpleSession:
    """The caller's open editing session (reused), or a new one; a new meeting session."""
    me, now = _me(principal), company_time.now()
    if kind == "editing":
        s = await _open_editing(db, me, now)
        if s is not None:
            return s
    s = SimpleSession(kind=kind, started_by=me, started_at=now)
    db.add(s)
    await db.flush()
    await audit.record(db, principal, "simple_session.started", "simple_session", s.id,
                       data={"kind": kind})  # fmt: skip
    return s


async def current_session(db: AsyncSession, principal: Any) -> SimpleSession | None:
    return await _open_editing(db, _me(principal), company_time.now())


async def close_session(db: AsyncSession, principal: Any, session_id: uuid.UUID) -> SimpleSession:
    me = _me(principal)
    s = await db.get(SimpleSession, session_id, with_for_update=True)
    if s is None:
        raise ChangeError(404, "No such session")
    if s.started_by != me:
        raise ChangeError(403, "Only the person who started a session closes it")
    if s.closed_at is None:
        s.closed_at = company_time.now()
        await audit.record(db, principal, "simple_session.closed", "simple_session", s.id)
    return s


async def _session_for_change(
    db: AsyncSession, me: uuid.UUID, session_id: uuid.UUID | None, applies: bool, now: datetime
) -> SimpleSession | None:
    if session_id is None:
        if not applies:
            return None
        s = await _open_editing(db, me, now)
        if s is None:
            s = SimpleSession(kind="editing", started_by=me, started_at=now)
            db.add(s)
            await db.flush()
        return s
    s = await db.get(SimpleSession, session_id, with_for_update=True)
    if s is None:
        raise ChangeError(404, "No such session of yours")
    if s.started_by != me:
        # S8: a meeting's session takes the changes of those its presenter lets change
        # things (oracle.simple.meetings.MeetingRules); their own rights still decide.
        from oracle.simple import meetings

        rules = await meetings.rules_for_session(db, s.id) if s.kind == "meeting" else None
        if rules is None:
            raise ChangeError(404, "No such session of yours")
        if not rules.may_change(me):
            raise ChangeError(403, "The presenter has not let you change things in this meeting")
    if s.closed_at is not None or _idle(s, now):
        if s.closed_at is None:
            s.closed_at = now
            await db.commit()
        raise ChangeError(409, "This session is closed; start a new one")
    return s


# --------------------------------------------------------------------------- fields


def _iso(d: date | None) -> str | None:
    return d.isoformat() if d is not None else None


def _day(value: Any, name: str) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError as e:
        raise ChangeError(422, f"{name}: a day as YYYY-MM-DD") from e


def _risk_of(row: RoadmapItem, target: dict[str, Any]) -> dict[str, Any] | None:
    for r in row.accepted_risks or []:
        if (
            isinstance(r, dict)
            and r.get("flag") == target.get("flag")
            and (r.get("subject") or None) == (target.get("subject") or None)
        ):
            return r
    return None


def read(row: RoadmapItem, fields: tuple[str, ...] | list[str], target: dict[str, Any]) -> dict:
    """The item's stored values of ``fields``, as JSON."""
    out: dict[str, Any] = {}
    for f in fields:
        if f == "risk":
            out[f] = _risk_of(row, target)
        else:
            out[f] = drafts._json(f, getattr(row, f))
    return out


def write(row: RoadmapItem, values: dict[str, Any], target: dict[str, Any]) -> None:
    for f, v in values.items():
        if f in DATES:
            setattr(row, f, _day(v, f))
        elif f == "risk":
            kept = [
                r
                for r in row.accepted_risks or []
                if not (
                    isinstance(r, dict)
                    and r.get("flag") == target.get("flag")
                    and (r.get("subject") or None) == (target.get("subject") or None)
                )
            ]
            row.accepted_risks = kept + ([v] if v is not None else [])
        else:
            setattr(row, f, drafts._typed(f, v))


def _normal(fields: tuple[str, ...], values: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for f in fields:
        v = values[f]
        out[f] = _iso(_day(v, f)) if f in DATES else v
    return out


# --------------------------------------------------------------------------- who


async def _company_owners(db: AsyncSession) -> list[uuid.UUID]:
    return list(
        await db.scalars(
            select(User.id)
            .where(User.role == "owner", User.disabled_at.is_(None))
            .order_by(User.created_at, User.id)
        )
    )


async def routed_to(db: AsyncSession, entry: service.Entry, read_: service.Read) -> list:
    """Who decides a proposal on this item (D-a): the roadmap's decider, else its track
    owner when an approver or owner, else the company's owners. Stored on the proposal as
    made; an open proposal is shown routed to whoever decides now (:meth:`_View.route`)."""
    return service.decider_ids(entry, read_.deciders) or await _company_owners(db)


def decides_all(principal: Any, entries: list[service.Entry], deciders: dict) -> bool:
    """Review major: a cut with its dependents is the caller's to apply (or accept) only when
    they decide every item it cuts (service.can_decide, item by item)."""
    return bool(entries) and all(service.can_decide(principal, e, deciders) for e in entries)


def cut_route(entries: list[service.Entry], deciders: dict) -> list[uuid.UUID]:
    """Who decides every item of a cut with its dependents: the deciders all its items share
    (service.decider_ids), else [] (the company's owners)."""
    common: list[uuid.UUID] | None = None
    for e in entries:
        ids = service.decider_ids(e, deciders)
        common = ids if common is None else [i for i in common if i in ids]
    return common or []


def cut_entries(c: SimpleChange, by_id: dict[uuid.UUID, service.Entry]) -> list[service.Entry]:
    """The items a cut_with_dependents change cuts (its ``after``'s keys), as read."""
    out = []
    for key in c.after or {}:
        try:
            e = by_id.get(uuid.UUID(str(key)))
        except ValueError:
            e = None
        if e is not None:
            out.append(e)
    return out


def current_route(
    c: SimpleChange, by_id: dict[uuid.UUID, service.Entry], deciders: dict, owners: list
) -> list[uuid.UUID]:
    """An open proposal's decider now (S3a-minor: the decider may have changed since it
    was made); its stored route when its item is not read."""
    if c.status != "proposed" or c.op == "edit_line" or c.op in KEY_DATE_OPS:
        return list(c.routed_to or [])
    if c.op == CUT_ALL:
        cut = cut_entries(c, by_id)
        return (cut_route(cut, deciders) or list(owners)) if cut else list(c.routed_to or [])
    item_id = c.target.get("item_id")
    if not item_id:
        return list(owners)
    try:
        e = by_id.get(uuid.UUID(str(item_id)))
    except ValueError:
        e = None
    if e is None:
        return list(c.routed_to or [])
    return service.decider_ids(e, deciders) or list(owners)


async def _names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    return {u.id: u.name or u.email for u in await db.scalars(select(User).where(User.id.in_(ids)))}


def _touched(c: SimpleChange) -> set[str]:
    if c.op in KEYED:
        return set(c.after) | set(c.before)
    return {str(c.target.get("item_id"))}


async def _last_writer(db: AsyncSession, item_ids: set[str]) -> tuple[Any, Any]:
    """(SimplePersonRef dict, when) of the last change through Simple that wrote these items."""
    rows = await db.scalars(
        select(SimpleChange)
        .where(SimpleChange.status.in_(WRITTEN))
        .order_by(SimpleChange.decided_at.desc().nulls_last(), SimpleChange.at.desc())
        .limit(500)
    )
    best: tuple[datetime, uuid.UUID] | None = None
    for c in rows:
        if not (_touched(c) & item_ids):
            continue
        at = c.decided_at if c.status == "accepted" and c.decided_at else c.at
        who = c.decided_by if c.status == "accepted" and c.decided_by else c.by
        if best is None or at > best[0]:
            best = (at, who)
    if best is None:
        return None, None
    names = await _names(db, {best[1]})
    return {"id": str(best[1]), "name": names.get(best[1], "someone")}, best[0]


async def _conflict(
    db: AsyncSession, current: dict[str, Any], item_ids: set[str], lead: str
) -> ChangeError:
    who, at = await _last_writer(db, item_ids)
    name = who["name"] if who else "someone outside Simple"
    return ChangeError(
        409,
        {
            "message": f"{lead}: changed by {name}",
            "current": current,
            "changed_by": who,
            "changed_at": at.isoformat() if at else None,
        },
    )


# --------------------------------------------------------------------------- computing


async def _lock(db: AsyncSession, ids: list[uuid.UUID]) -> None:
    if ids:
        await db.execute(
            select(RoadmapItem.id)
            .where(RoadmapItem.id.in_(ids))
            .order_by(RoadmapItem.id)
            .with_for_update()
        )


def _uuid(value: Any, name: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError as e:
        raise ChangeError(422, f"target.{name}: an id") from e


def _accepted_order(n: service.Entry, dep: service.Entry) -> bool:
    return any(
        f.kind == "dependency_order" and f.state == "amber" and str(f.subject) == str(dep.row.id)
        for f in n.flags
    )


def _fix_plan(
    op: str, entry: service.Entry, dep: service.Entry, by_id: dict[uuid.UUID, service.Entry]
) -> dict[uuid.UUID, tuple[date, date]]:
    """The new (start, end) of every item a fix moves."""
    one = timedelta(days=1)
    if op == "move_dependency":
        new_end = entry.resolved.start.date - one
        shift = new_end - dep.resolved.end.date
        return {dep.row.id: (dep.resolved.start.date + shift, new_end)}
    # #9: every direct dependent of `dep` that starts too early moves, not only the one
    # whose callout was clicked (two items can share a dependency, each estimated or
    # slice-dated); the move then walks forward transitively through each moved item's
    # own dependents.
    moves: dict[uuid.UUID, tuple[date, date]] = {}
    queue: deque[uuid.UUID] = deque()
    for nid in dep.needed_by:
        n = by_id.get(nid)
        if n is None or n.status == "cut" or n.resolved.start.date > dep.resolved.end.date:
            continue
        # A sibling whose order on `dep` was accepted as a risk stays where it is.
        if nid != entry.row.id and _accepted_order(n, dep):
            continue
        delta = dep.resolved.end.date + one - n.resolved.start.date
        moves[nid] = (n.resolved.start.date + delta, n.resolved.end.date + delta)
        queue.append(nid)
    while queue:
        cur = queue.popleft()
        end = moves[cur][1]
        for nid in by_id[cur].needed_by:
            n = by_id.get(nid)
            if n is None or nid in moves or n.status == "cut":
                continue
            start = n.resolved.start.date
            if start <= end:
                delta = end + one - start
                moves[nid] = (start + delta, n.resolved.end.date + delta)
                queue.append(nid)
    return moves


def dependents(entry: service.Entry, by_id: dict[uuid.UUID, service.Entry]) -> list[service.Entry]:
    """Every item that waits on ``entry``, transitively (breadth first, in the roadmap's
    order at each step), but those cut or merged already: what cut_with_dependents cuts
    with it. An item that also waits on a kept item is still cut: it waits on this one."""
    out: list[service.Entry] = []
    seen = {entry.row.id}
    queue: deque[service.Entry] = deque([entry])
    while queue:
        cur = queue.popleft()
        for nid in cur.needed_by:
            n = by_id.get(nid)
            if n is None or nid in seen or n.status in ("cut", "merged"):
                continue
            seen.add(nid)
            out.append(n)
            queue.append(n)
    return out


async def _plan(
    db: AsyncSession, principal: Any, body: SimpleChangeIn, read_: service.Read
) -> tuple[service.Entry, dict[str, Any], dict[str, Any], dict[str, Any]]:
    """(entry, target, before as stored now, after) for a new change; 409 on a stale
    ``before``; 422 on a malformed one."""
    by_id = read_.by_id()
    target = dict(body.target)
    item_id = _uuid(target.get("item_id"), "item_id")
    target["item_id"] = str(item_id)
    entry = by_id.get(item_id)
    if entry is None:
        raise ChangeError(404, "No such roadmap item")
    op, row = body.op, entry.row
    if op in FIXES:
        dep_id = _uuid(target.get("subject"), "subject")
        target["subject"] = str(dep_id)
        dep = by_id.get(dep_id)
        if dep is None or dep_id not in entry.depends_on:
            raise ChangeError(422, "target.subject: an item the target depends on")
        seen: dict[str, Any] = {}
        for e in (entry, dep):
            given = body.before.get(str(e.row.id))
            if not isinstance(given, dict) or any(f not in given for f in DATES):
                raise ChangeError(422, f"before.{e.row.id}: start_date and end_date as seen")
            now_ = read(e.row, DATES, target)
            if _normal(DATES, given) != now_:
                seen[str(e.row.id)] = now_
        if seen:
            raise await _conflict(db, seen, set(seen), "Changed since you saw it")
        moves = _fix_plan(op, entry, dep, by_id)
        await _lock(db, list(moves))
        before = {str(i): read(by_id[i].row, (*DATES, "date_source"), target) for i in moves}
        after = {
            str(i): {"start_date": s.isoformat(), "end_date": e.isoformat(), "date_source": "typed"}
            for i, (s, e) in moves.items()
        }
        return entry, target, before, after
    if op == "merge_item":
        return await _merge_plan(db, entry, target, by_id)
    if op == CUT_ALL:
        # As a cut: ``before`` is the item's own {"cut"} as seen; the change is keyed by
        # item id, the item and its dependents (target.titles names them, the item first).
        if "cut" not in body.before:
            raise ChangeError(422, "before: cut as you saw it")
        current = read(row, ("cut",), target)
        if _normal(("cut",), body.before) != current:
            raise await _conflict(db, current, {str(row.id)}, "Changed since you saw it")
        cut = [entry, *dependents(entry, by_id)]
        if len(cut) == 1:
            raise ChangeError(422, "No item depends on this one: cut it alone")
        seen_ids = body.before.get("dependents")
        now_ids = [str(e.row.id) for e in cut[1:]]
        if seen_ids is not None and sorted(map(str, seen_ids)) != sorted(now_ids):
            # Review minor: never cut a dependent the caller was not shown.
            raise await _conflict(
                db, {"dependents": now_ids}, set(now_ids), "Changed since you saw it"
            )
        target["titles"] = [e.row.title for e in cut]
        before = {str(e.row.id): read(e.row, ("cut",), target) for e in cut}
        after = {str(e.row.id): {"cut": True} for e in cut}
        return entry, target, before, after
    fields = FIELDS[op]
    missing = [f for f in fields if f not in body.before]
    if missing:
        raise ChangeError(422, f"before: {', '.join(missing)} as you saw them")
    if op in ("confirm_item", "keep_both") and (not row.draft or row.merged_into):
        raise ChangeError(422, "Only a draft item is confirmed or kept")
    current = read(row, fields, target)
    # A suggestion accepted after the item got dates is "outdated" (S2-minor).
    lead = "outdated" if op == "accept_date_suggestion" else "Changed since you saw it"
    if _normal(fields, body.before) != current:
        raise await _conflict(db, current, {str(row.id)}, lead)
    a = body.after
    after: dict[str, Any]
    stored = fields
    if op == "move_dates":
        start, end = _day(a.get("start_date"), "start_date"), _day(a.get("end_date"), "end_date")
        if start is None or end is None or end < start:
            raise ChangeError(422, "after: start_date and end_date, the end not before the start")
        after = {"start_date": _iso(start), "end_date": _iso(end), "date_source": "typed"}
        stored = (*DATES, "date_source")
    elif op == "accept_date_suggestion":
        sid = _uuid(target.get("suggestion_id"), "suggestion_id")
        target["suggestion_id"] = str(sid)
        s = await db.get(RoadmapDateSuggestion, sid)
        if s is None or s.item_id != row.id:
            raise ChangeError(404, "No such date suggestion on this item")
        if s.status != "open":
            raise ChangeError(409, f"This suggestion is {s.status} already")
        if not entry.resolved.undated:
            # Engineering or tracker dates arrived after the suggestion was made.
            raise await _conflict(db, current, {str(row.id)}, lead)
        start, end = s.start_date, s.end_date
        if s.slice_code is not None:
            # plan-model: a slice's dates: the item takes the span of all its slices.
            for o in await db.scalars(
                select(RoadmapDateSuggestion).where(
                    RoadmapDateSuggestion.item_id == row.id,
                    RoadmapDateSuggestion.status == "open",
                )
            ):
                start, end = min(start, o.start_date), max(end, o.end_date)
        if a.get("start_date") is not None or a.get("end_date") is not None:
            # The edit variant (D-b): the person's dates instead of the suggestion's.
            start, end = (
                _day(a.get("start_date"), "start_date"),
                _day(a.get("end_date"), "end_date"),
            )
            if start is None or end is None or end < start:
                raise ChangeError(
                    422, "after: start_date and end_date, the end not before the start"
                )
            target["edited"] = True
        after = {"start_date": _iso(start), "end_date": _iso(end), "date_source": "accepted"}
        stored = (*DATES, "date_source")
    elif op == "change_horizon":
        if a.get("horizon") not in HORIZONS:
            raise ChangeError(422, "after.horizon: now, next or later")
        after = {"horizon": a["horizon"]}
    elif op == "reorder":
        pos = a.get("position")
        if not isinstance(pos, int) or isinstance(pos, bool) or pos < 0:
            raise ChangeError(422, "after.position: a whole number from 0")
        after = {"position": pos}
    elif op in ("cut", "restore"):
        after = {"cut": op == "cut"}
    elif op == "confirm_item":
        after = {"draft": False}
    elif op == "keep_both":
        after = {"kept_both": True}
    elif op == "edit_title":
        title = " ".join(str(a.get("title") or "").split())
        if not title or len(title) > TITLE_MAX:
            raise ChangeError(422, f"after.title: 1 to {TITLE_MAX} characters")
        after = {"title": title}
    elif op == "set_milestone":
        m = a.get("milestone")
        if m is None:
            after = {"milestone": None}
        else:
            name = " ".join(str((m or {}).get("name") or "").split()) if isinstance(m, dict) else ""
            if not name or len(name) > TITLE_MAX:
                raise ChangeError(422, f"after.milestone.name: 1 to {TITLE_MAX} characters")
            day = _day(m.get("date"), "after.milestone.date")
            after = {"milestone": {"name": name, "date": _iso(day),
                                   "date_source": "typed" if day else None}}  # fmt: skip
    elif op in ("set_owner", "set_decider"):
        field = FIELDS[op][0]
        raw = a.get(field)
        person = None
        if raw is not None:
            person = _uuid(raw, f"after.{field}")
            if (
                await db.scalar(
                    select(User.id).where(User.id == person, User.disabled_at.is_(None))
                )
                is None
            ):
                raise ChangeError(422, f"after.{field}: a member of this company")
        after = {field: str(person) if person else None}
    elif op == "edit_outcome":
        outcome = a.get("outcome")
        outcome = str(outcome).strip() if outcome is not None else None
        if outcome is not None and len(outcome) > OUTCOME_MAX:
            raise ChangeError(422, f"after.outcome: at most {OUTCOME_MAX} characters")
        after = {"outcome": outcome or None}
    else:  # accept_risk
        if target.get("flag") not in FLAG_KINDS:
            raise ChangeError(422, "target.flag: a constraint flag's kind")
        target["subject"] = str(target["subject"]) if target.get("subject") else None
        note = str(((a.get("risk") or {}).get("note")) or "").strip()
        if not note or len(note) > NOTE_MAX:
            raise ChangeError(422, f"after.risk.note: 1 to {NOTE_MAX} characters")
        after = {
            "risk": {
                "flag": target["flag"],
                "subject": target["subject"],
                "note": note,
                "by": str(_me(principal)),
                "at": company_time.now().isoformat(),
            }
        }
    return entry, target, read(row, stored, target), after


async def _merge_plan(
    db: AsyncSession, entry: service.Entry, target: dict[str, Any], by_id: dict
) -> tuple[service.Entry, dict[str, Any], dict[str, Any], dict[str, Any]]:
    """S7: merge_item's writes, keyed by item id (see the module's docstring)."""
    from oracle.baseline.models import Entity

    row = entry.row
    if not row.draft or entry.status in ("merged", "cut"):
        raise ChangeError(422, "Only an open draft item is merged")
    after: dict[str, dict[str, Any]] = {}
    if target.get("feature_id"):
        fid = _uuid(target["feature_id"], "feature_id")
        feature = await db.get(Entity, fid)
        if feature is None or feature.type != "feature":
            raise ChangeError(422, "target.feature_id: a baseline feature")
        target["feature_id"], target["code"], target["title"] = str(fid), feature.key, feature.title
        after[str(row.id)] = {"feature_id": str(fid), "kept_both": True}
    else:
        into = _uuid(target.get("into_id"), "into_id")
        kept = by_id.get(into)
        if kept is None:
            raise ChangeError(404, "No such roadmap item to merge into")
        if kept is entry or kept.roadmap.id != entry.roadmap.id or kept.status in ("merged", "cut"):
            raise ChangeError(422, "target.into_id: another open item of the same roadmap")
        target["into_id"], target["code"], target["title"] = (
            str(into), kept.row.item_key, kept.row.title
        )  # fmt: skip
        dk, kk = row.item_key, kept.row.item_key
        goals = [str(g) for g in kept.row.goal_ids or []]
        goals += [str(g) for g in row.goal_ids or [] if str(g) not in goals]
        deps = [k for k in kept.row.depends_on or [] if k != dk]
        deps += [k for k in row.depends_on or [] if k not in deps and k not in (kk, dk)]
        note = f"Merged from {dk} {row.title}" + (f": {row.note}" if row.note else "")
        after[str(kept.row.id)] = {
            "goal_ids": goals,
            "depends_on": deps,
            "note": f"{kept.row.note}\n{note}" if kept.row.note else note,
        }
        after[str(row.id)] = {"merged_into": kk}
        for nid in entry.needed_by:
            n = by_id.get(nid)
            if n is None or n is kept or n is entry:
                continue
            ks = [k for k in n.row.depends_on or [] if k != dk]
            after[str(nid)] = {"depends_on": ks + ([kk] if kk not in ks else [])}
    rows = {str(e.row.id): e.row for e in by_id.values()}
    before = {k: read(rows[k], tuple(v), target) for k, v in after.items()}
    return entry, target, before, after


async def _apply(
    db: AsyncSession,
    c: SimpleChange,
    values: dict[str, Any],
    principal: Any,
    session: SimpleSession,
    undo: bool = False,
) -> None:
    """Write ``values`` (a change's after, or its before for an undo) into the working
    drafts of the items' roadmaps (S3b), and the change's own side effects."""
    c.draft_ids = await drafts.write_items(db, c, values, session, KEYED, write, undo=undo)
    if c.op == "accept_date_suggestion":
        s = await db.get(RoadmapDateSuggestion, uuid.UUID(c.target["suggestion_id"]))
        if s is not None and not undo and s.status == "open":
            s.status = "edited" if c.target.get("edited") else "accepted"
            s.decided_by, s.decided_at = _me(principal), company_time.now()
            if s.slice_code is not None:
                # plan-model: the item's other slices are dated with it.
                for o in await db.scalars(
                    select(RoadmapDateSuggestion).where(
                        RoadmapDateSuggestion.item_id == s.item_id,
                        RoadmapDateSuggestion.status == "open",
                        RoadmapDateSuggestion.id != s.id,
                    )
                ):
                    o.status, o.decided_by, o.decided_at = s.status, s.decided_by, s.decided_at
        elif s is not None and undo and s.status in ("accepted", "edited"):
            other = await db.scalar(
                select(RoadmapDateSuggestion.id).where(
                    RoadmapDateSuggestion.item_id == s.item_id,
                    RoadmapDateSuggestion.status == "open",
                )
            )
            if other is None:
                if s.slice_code is not None:
                    for o in await db.scalars(
                        select(RoadmapDateSuggestion).where(
                            RoadmapDateSuggestion.item_id == s.item_id,
                            RoadmapDateSuggestion.status == s.status,
                            RoadmapDateSuggestion.decided_at == s.decided_at,
                            RoadmapDateSuggestion.id != s.id,
                        )
                    ):
                        o.status, o.decided_by, o.decided_at = "open", None, None
                s.status, s.decided_by, s.decided_at = "open", None, None
    await db.flush()


async def _current(db: AsyncSession, c: SimpleChange, like: dict[str, Any]) -> dict[str, Any]:
    """The stored values of the fields ``like`` names (keyed as it is), as the items'
    open drafts have them."""
    if c.op in KEYED:
        rows = await drafts.effective(
            db,
            list(
                await db.scalars(
                    select(RoadmapItem).where(RoadmapItem.id.in_([uuid.UUID(k) for k in like]))
                )
            ),
        )
        return {k: read(rows[k], list(v), c.target) for k, v in like.items() if k in rows}
    row = await db.get(RoadmapItem, uuid.UUID(c.target["item_id"]))
    if row is None:
        raise ChangeError(404, "The item is gone")
    return read(await drafts.effective_row(db, row), list(like), c.target)


async def _lock_change_items(db: AsyncSession, c: SimpleChange) -> None:
    await _lock(db, [uuid.UUID(k) for k in _touched(c)])
    for r in await db.scalars(
        select(RoadmapItem).where(RoadmapItem.id.in_([uuid.UUID(k) for k in _touched(c)]))
    ):
        await db.refresh(r)


async def _flags(
    db: AsyncSession, c: SimpleChange, overlays: dict[uuid.UUID, dict[str, Any]]
) -> list[SimpleItemFlags]:
    read_ = await service.load(db, overlays)
    by_id = read_.by_id()
    ids: list[uuid.UUID] = []
    for k in sorted(_touched(c)):
        e = by_id.get(uuid.UUID(k))
        if e is None:
            continue
        for i in (e.row.id, *e.needed_by):
            if i not in ids:
                ids.append(i)
    return [
        SimpleItemFlags(
            item_id=i,
            flags=[
                SimpleFlag(
                    kind=f.kind,
                    reason=f.reason,
                    fixes=f.fixes,
                    state=f.state,  # type: ignore[arg-type]
                    subject=f.subject,
                    risk_note=f.risk_note,
                )  # fmt: skip
                for f in by_id[i].flags
            ],
        )
        for i in ids
    ]


# --------------------------------------------------------------------------- the routes


async def create(db: AsyncSession, principal: Any, body: SimpleChangeIn) -> SimpleChangeResult:
    from oracle.simple import additions, key_dates, one_pager, questions, targets

    if body.op in questions.OPS:
        return await questions.create(db, principal, body)
    if body.op in key_dates.OPS:
        return await key_dates.create(db, principal, body)
    if body.op in additions.OPS:
        return await additions.create(db, principal, body)
    if body.op in targets.OPS:
        return await targets.create(db, principal, body)
    if body.op in one_pager.OPS:
        return await one_pager.create(db, principal, body)
    me, now = _me(principal), company_time.now()
    ids = [_uuid(body.target.get("item_id"), "item_id")]
    if body.op in FIXES and body.target.get("subject"):
        ids.append(_uuid(body.target["subject"], "subject"))
    if body.op == "merge_item":
        # A merge rewrites the draft's dependents: every item of the roadmap is locked.
        doc = await db.scalar(
            select(RoadmapItem.roadmap_document_id).where(RoadmapItem.id == ids[0])
        )
        ids += [
            i
            for i in await db.scalars(
                select(RoadmapItem.id).where(RoadmapItem.roadmap_document_id == doc)
            )
            if i not in ids
        ]
    elif body.op in (*FIXES, CUT_ALL):
        # A fix may move any item of the version (dependents, transitively), a cut with its
        # dependents cut them: every one is locked before service.load reads them.
        version = await db.scalar(
            select(RoadmapItem.roadmap_version_id).where(RoadmapItem.id == ids[0])
        )
        ids += [
            i
            for i in await db.scalars(
                select(RoadmapItem.id).where(RoadmapItem.roadmap_version_id == version)
            )
            if i not in ids
        ]
    await _lock(db, ids)
    seen = await drafts.overlays_for(db, principal)
    read_ = await service.load(db, seen)
    entry = read_.by_id().get(ids[0])
    if entry is None:
        raise ChangeError(404, "No such roadmap item")
    cut = [entry, *dependents(entry, read_.by_id())] if body.op == CUT_ALL else None
    applies = (
        decides_all(principal, cut, read_.deciders)
        if cut is not None
        else service.can_decide(principal, entry, read_.deciders)
    )
    session = await _session_for_change(db, me, body.session_id, applies, now)
    entry, target, before, after = await _plan(db, principal, body, read_)
    c = SimpleChange(
        session_id=session.id if session else None,
        document_id=entry.roadmap.id,
        op=body.op,
        target=target,
        before=before,
        after=after,
        status="applied" if applies else "proposed",
        by=me,
        at=now,
        reason=body.reason,
        routed_to=[]
        if applies
        else (cut_route(cut, read_.deciders) or await _company_owners(db))
        if cut is not None
        else await routed_to(db, entry, read_),
    )
    if applies:
        await _apply(db, c, after, principal, session)  # type: ignore[arg-type]
        flags = await _flags(db, c, await drafts.overlays_for(db, principal))
        session.last_change_at = now  # type: ignore[union-attr]
    else:
        # As if applied, on what the proposer reads; nothing is written.
        rows = {str(e.row.id): e.row for e in read_.entries}
        flags = await _flags(db, c, drafts.simulate(c, after, rows, seen, KEYED, write))
    db.add(c)
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": target, "before": before, "after": after,
                             "document_id": str(entry.roadmap.id)})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=flags)


async def _get(db: AsyncSession, change_id: uuid.UUID) -> SimpleChange:
    c = await db.get(SimpleChange, change_id, with_for_update=True)
    if c is None:
        raise ChangeError(404, "No such change")
    return c


async def decide(
    db: AsyncSession,
    principal: Any,
    change_id: uuid.UUID,
    action: str,
    reason: str | None,
    session_id: uuid.UUID | None = None,
) -> SimpleChangeResult:
    """Accept (apply the proposal, unless outdated) or decline it."""
    from oracle.simple import additions, key_dates, one_pager, questions, targets

    me, now = _me(principal), company_time.now()
    c = await _get(db, change_id)
    if c.op in questions.OPS:
        return await questions.decide(db, principal, c, action, reason, session_id)
    if c.op in key_dates.OPS:
        return await key_dates.decide(db, principal, c, action, reason)
    if c.op in additions.OPS:
        return await additions.decide(db, principal, c, action, reason)
    if c.op in targets.OPS:
        return await targets.decide(db, principal, c, action, reason)
    if c.op in one_pager.OPS:
        return await one_pager.decide(db, principal, c, action, reason, session_id)
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    entry = read_.by_id().get(uuid.UUID(c.target["item_id"]))
    if entry is None:
        raise ChangeError(404, "No such change")
    by_id = read_.by_id()
    if not (
        decides_all(principal, cut_entries(c, by_id), read_.deciders)
        if c.op == CUT_ALL
        else service.can_decide(principal, entry, read_.deciders)
    ):
        raise ChangeError(
            403,
            "Only an owner or the roadmap's decider (with no decider, its owner) decides proposals",
        )
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept":
        await _lock_change_items(db, c)
        current = await _current(db, c, c.before)
        if current != c.before:
            raise await _conflict(db, current, _touched(c), "outdated")
        # Into the decider's working draft (their editing session's, or S8's meeting's).
        session = await _session_for_change(db, me, session_id, True, now)
        await _apply(db, c, c.after, principal, session)  # type: ignore[arg-type]
        session.last_change_at = now  # type: ignore[union-attr]
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = me, now, reason
    await db.flush()
    flags = await _flags(db, c, await drafts.overlays_for(db, principal))
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=flags)


async def undo(db: AsyncSession, principal: Any, change_id: uuid.UUID) -> SimpleChangeResult:
    from oracle.simple import additions, key_dates, one_pager, questions, targets

    me, now = _me(principal), company_time.now()
    c = await _get(db, change_id)
    if c.op in questions.OPS:
        return await questions.undo(db, principal, c)
    if c.op in key_dates.OPS:
        return await key_dates.undo(db, principal, c)
    if c.op in additions.OPS:
        return await additions.undo(db, principal, c)
    if c.op in targets.OPS:
        return await targets.undo(db, principal, c)
    if c.op in one_pager.OPS:
        return await one_pager.undo(db, principal, c)
    if c.status != "applied":
        raise ChangeError(409, f"Only an applied change undoes; this one is {c.status}")
    if c.by != me:
        raise ChangeError(403, "Only the person who made a change undoes it")
    if await db.scalar(select(SimpleChange.id).where(SimpleChange.undoes_id == c.id)):
        raise ChangeError(409, "This change is undone already")
    session = (
        await db.get(SimpleSession, c.session_id, with_for_update=True) if c.session_id else None
    )
    if session is None or session.closed_at is not None or _idle(session, now):
        raise ChangeError(409, "Its session is closed: undo works only in the change's session")
    await _lock_change_items(db, c)
    current = await _current(db, c, c.after)
    if current != c.after:
        raise await _conflict(db, current, _touched(c), "Changed since")
    u = SimpleChange(session_id=c.session_id, document_id=c.document_id, op=c.op, target=c.target,
                     before=c.after, after=c.before, status="undone", by=me, at=now,
                     undoes_id=c.id, routed_to=[], draft_ids=list(c.draft_ids or []))  # fmt: skip
    await _apply(db, u, c.before, principal, session, undo=True)
    db.add(u)
    session.last_change_at = now
    await db.flush()
    flags = await _flags(db, c, await drafts.overlays_for(db, principal))
    await audit.record(db, principal, "simple_change.undone", "simple_change", u.id,
                       data={"op": c.op, "target": c.target, "undoes_id": str(c.id)})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, u), flags=flags)


# --------------------------------------------------------------------------- reading


async def _reviewers(db: AsyncSession) -> dict[uuid.UUID, set[uuid.UUID]]:
    out: dict[uuid.UUID, set[uuid.UUID]] = {}
    for p in await db.scalars(select(DocumentReviewPolicy)):
        out[p.document_id] = {
            *(p.mandatory_reviewer_ids or []),
            *([p.decider_id] if p.decider_id else []),
        }
    return out


class _View:
    """What one reader may see and do over a set of changes."""

    def __init__(
        self,
        principal: Any,
        read_: service.Read,
        reviewers,
        sessions,
        undone,
        people=None,
        company_owners: list | None = None,
    ) -> None:
        self.principal = principal
        self.me = getattr(principal, "user_id", None)
        self.by_id = read_.by_id()
        self.deciders = read_.deciders
        self.docs = {e.roadmap.id for e in read_.entries}
        self.reviewers = reviewers
        self.sessions: dict[uuid.UUID, SimpleSession] = sessions
        self.undone: set[uuid.UUID] = undone
        # S3b: each draft's participants and each roadmap's owners (its tracks' owners).
        self.participants: dict[uuid.UUID, set[uuid.UUID]] = (people or {}).get("drafts", {})
        self.owners: dict[uuid.UUID, set[uuid.UUID]] = (people or {}).get("owners", {})
        self.company_owners = company_owners or []
        self.now = company_time.now()
        # prd-questions: the questions its changes are on, by id.
        self.questions: dict[str, Any] = {}

    def route(self, c: SimpleChange) -> list[uuid.UUID]:
        return current_route(c, self.by_id, self.deciders, self.company_owners)

    def entry(self, c: SimpleChange) -> service.Entry | None:
        try:
            return self.by_id.get(uuid.UUID(str(c.target.get("item_id"))))
        except ValueError:
            return None

    def may_decide(self, c: SimpleChange) -> bool:
        from oracle.simple import additions, key_dates, one_pager, questions, targets

        if c.op in questions.OPS:
            return questions.may_decide_change(self.principal, c, self.questions)
        if c.op in key_dates.OPS:
            return key_dates.may_decide(self.principal, c, self)
        if c.op in additions.OPS:
            return additions.may_decide(self.principal, c, self)
        if c.op in targets.OPS:
            return targets.may_decide(self.principal, c, self)
        if c.op in one_pager.OPS:
            return one_pager.may_decide(self.principal, c)
        if c.op == CUT_ALL:
            return decides_all(self.principal, cut_entries(c, self.by_id), self.deciders)
        e = self.entry(c)
        return e is not None and service.can_decide(self.principal, e, self.deciders)

    def sees(self, c: SimpleChange) -> bool:
        """Working changes and proposals: their people, the session's, the document's
        owners, decider and reviewers (#723 owner answer)."""
        # S5: a one-pager line's change is on a PRD, not a roadmap of this read.
        if (c.document_id is not None and c.document_id not in self.docs
                and c.op not in ("edit_line", "decide_question", "name_decider")):  # fmt: skip
            return False
        if self.me is None:
            return False
        if has_role(self.principal.role, "owner") or c.by == self.me or self.me in self.route(c):
            return True
        s = self.sessions.get(c.session_id) if c.session_id else None
        if s is not None and s.started_by == self.me:
            return True
        if c.document_id is not None and self.me in self.reviewers.get(c.document_id, set()):
            return True
        if any(self.me in self.participants.get(d, set()) for d in c.draft_ids or []):
            return True
        if c.document_id is not None and self.me in self.owners.get(c.document_id, set()):
            return True
        return self.may_decide(c)

    def can_undo(self, c: SimpleChange) -> bool:
        s = self.sessions.get(c.session_id) if c.session_id else None
        return (
            c.status == "applied"
            and c.by == self.me
            and c.id not in self.undone
            and s is not None
            and s.closed_at is None
            and not _idle(s, self.now)
        )


def _out(c: SimpleChange, v: _View, names: dict[uuid.UUID, str]) -> SimpleChangeOut:
    return SimpleChangeOut(
        id=c.id, session_id=c.session_id, document_id=c.document_id, op=c.op,  # type: ignore[arg-type]
        draft_ids=list(c.draft_ids or []),
        target=c.target, before=c.before, after=c.after, status=c.status,  # type: ignore[arg-type]
        by=c.by, by_name=names.get(c.by, "someone"), at=c.at, decided_by=c.decided_by,
        decided_at=c.decided_at, reason=c.reason, decision_reason=c.decision_reason,
        routed_to=v.route(c), undoes_id=c.undoes_id, undone=c.id in v.undone,
        can_decide=c.status == "proposed" and v.may_decide(c), can_undo=v.can_undo(c),
        words=_words(c, v, names),
    )  # fmt: skip


def _words(c: SimpleChange, v: _View, names: dict[uuid.UUID, str]) -> str:
    """The change in plain words (oracle.simple.change_words): who, what, the item's code
    and name as this reader reads it, "· undone" once undone."""
    from oracle.simple import change_words

    e = v.entry(c) if c.target.get("item_id") else None
    item = f"{e.code or ''} {e.row.title}".strip() if e is not None else None
    return change_words.sentence(c.op, c.target, c.before, c.after,
                                 who=names.get(c.by, "someone"), item=item,
                                 status=c.status, undone=c.id in v.undone)  # fmt: skip


async def _view(db: AsyncSession, principal: Any, changes: list[SimpleChange]) -> _View:
    # S7: with the drafts the reader sees, so items added in Simple are known.
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    sids = {c.session_id for c in changes if c.session_id}
    sessions = (
        {s.id: s for s in await db.scalars(select(SimpleSession).where(SimpleSession.id.in_(sids)))}
        if sids
        else {}
    )
    cids = [c.id for c in changes]
    undone = (
        set(
            await db.scalars(select(SimpleChange.undoes_id).where(SimpleChange.undoes_id.in_(cids)))
        )
        if cids
        else set()
    )
    dids = {d for c in changes for d in c.draft_ids or []}
    participants = (
        {
            d.id: {d.created_by, *(d.participant_ids or [])}
            for d in await db.scalars(select(SimpleDraft).where(SimpleDraft.id.in_(dids)))
        }
        if dids
        else {}
    )
    owners = (await drafts.who(db, {c.document_id for c in changes if c.document_id})).owners
    people = {"drafts": participants, "owners": owners}
    company = await _company_owners(db) if any(c.status == "proposed" for c in changes) else []
    v = _View(principal, read_, await _reviewers(db), sessions, undone, people, company)
    qids = {
        c.target.get("decision_id") for c in changes if c.op in ("decide_question", "name_decider")
    }
    if qids:
        from oracle.decisions.models import Decision

        ids = [uuid.UUID(i) for i in qids if i]
        v.questions = {
            str(d.id): d for d in await db.scalars(select(Decision).where(Decision.id.in_(ids)))
        }
    return v


async def one_out(db: AsyncSession, principal: Any, c: SimpleChange) -> SimpleChangeOut:
    v = await _view(db, principal, [c])
    return _out(c, v, await _names(db, {c.by}))


async def listing(
    db: AsyncSession,
    principal: Any,
    session_id: uuid.UUID | None,
    document_id: uuid.UUID | None,
    status: str | None,
    mine: bool,
) -> list[SimpleChangeOut]:
    q = select(SimpleChange).order_by(SimpleChange.at.desc(), SimpleChange.id).limit(500)
    if session_id is not None:
        q = q.where(SimpleChange.session_id == session_id)
    if document_id is not None:
        q = q.where(SimpleChange.document_id == document_id)
    if status is not None:
        q = q.where(SimpleChange.status == status)
    if mine:
        q = q.where(SimpleChange.by == getattr(principal, "user_id", None))
    rows = list(await db.scalars(q))
    v = await _view(db, principal, rows)
    shown = [c for c in rows if v.sees(c)]
    names = await _names(db, {c.by for c in shown})
    return [_out(c, v, names) for c in shown]


async def inbox_rows(
    db: AsyncSession, principal: Any, seen: datetime | None
) -> tuple[list[InboxSimpleChange], list[InboxSimpleChange]]:
    """(proposals waiting for me, decisions on my proposals of the last 30 days)."""
    me = getattr(principal, "user_id", None)
    if me is None or principal.run_id is not None or principal.run_token_id is not None:
        return [], []
    since = company_time.now() - timedelta(days=DONE_DAYS)
    # One read: open proposals (routed to whoever decides now), and decisions on mine.
    rows = list(
        await db.scalars(
            select(SimpleChange)
            .where(
                (SimpleChange.status == "proposed")
                | (
                    (SimpleChange.by == me)
                    & SimpleChange.status.in_(("accepted", "declined"))
                    & (SimpleChange.decided_at >= since)
                )
            )
            .order_by(SimpleChange.decided_at.desc().nulls_last(), SimpleChange.at.desc())
        )
    )
    waiting = [c for c in rows if c.status == "proposed"]
    if waiting:
        read_ = await service.load(db)
        owners = await _company_owners(db)
        by_id = read_.by_id()
        waiting = [c for c in waiting if me in current_route(c, by_id, read_.deciders, owners)]
    decided = [c for c in rows if c.status != "proposed"]
    if not waiting and not decided:
        return [], []
    item_ids = set()
    for c in waiting + decided:
        try:
            item_ids.add(uuid.UUID(str(c.target.get("item_id"))))
        except ValueError:
            pass
    titles = {
        r.id: r.title
        for r in await db.scalars(select(RoadmapItem).where(RoadmapItem.id.in_(item_ids)))
    }
    names = await _names(db, {c.by for c in waiting + decided})

    def row(c: SimpleChange, at: datetime | None, state: str | None = None) -> InboxSimpleChange:
        iid = uuid.UUID(str(c.target["item_id"])) if c.target.get("item_id") else None
        return InboxSimpleChange(
            id=c.id, op=c.op, status=c.status, item_id=iid,  # type: ignore[arg-type]
            item_title=titles.get(iid) if iid else None, document_id=c.document_id, by=c.by,
            by_name=names.get(c.by, "someone"), at=c.at, decided_by=c.decided_by,
            decided_at=c.decided_at, reason=c.reason, decision_reason=c.decision_reason,
            state=state or ("new" if seen is None or (at and at > seen) else "open"),  # type: ignore[arg-type]
        )  # fmt: skip

    return (
        [row(c, c.at) for c in waiting],
        [
            row(c, c.decided_at, None if seen is None or c.decided_at > seen else "done")
            for c in decided
        ],  # fmt: skip
    )
