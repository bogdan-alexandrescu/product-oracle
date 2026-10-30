"""Simple S7 (#723, D15): additions and Oracle's goal suggestions.

**Adding an item** (``add_item``, through the change engine, oracle.simple.changes): a
title dropped on a quarter, a Now/Next/Later column or a goal becomes a DRAFT item of a
roadmap. Who applies is the roadmap's rule (oracle.simple.drafts.can_edit: an owner, its
decider, with none its owner while an approver or owner); approvers and commenters
propose it to the decider, else the roadmap's owners, else the company's owners;
viewers are refused. The item's id is chosen when the change is made
(``target.item_id``), so a proposal names the item it will make.

The new item never touches a published version: it is a ``roadmap_items`` row on no
version, in the roadmap's working draft (``simple_draft_id``), read by those who see the
draft as part of the version the draft was opened on (oracle.simple.drafts.added_rows);
submitting the draft carries it into the next version. Its undo removes it (refused while
a later change to it is live).

**Oracle's drafting** (the ``item_draft`` llm job, queued when the item is made): one
call fills its outcome (unless a person wrote one), links the best-matching baseline
feature, adds the dependencies it names among the roadmap's item keys and opens a date
suggestion (oracle.simple.suggestions' rows, accepted through the engine), inside the
quarter it was dropped on. It reads ``draft`` until an owner or the decider confirms it
(``confirm_item``).

**Goal suggestions** (``simple_goal_suggestions``, the ``goal_suggestions`` llm job): 3-5
features that could serve a goal, with their outcome, why and evidence links (each with
its confidence), suggested AUTOMATICALLY ONCE when a goal has no roadmap items
(:func:`suggest_for_empty_goals`, from the tick; ``simple_goal_autos`` remembers it) and
ON DEMAND ("Suggest features", commenter and up). PEOPLE file their own next to Oracle's
(:func:`file_suggestion`, commenter and up: origin ``person``, ``proposed_by``; a title
like an open or rejected one of the goal is refused). Only who decides the goal's
suggestions accepts or rejects one (:func:`deciding`: an owner, the decider of the goal's
roadmap, with none its owners who are approvers): accepting is an ``add_item`` on its
goal, applied at once (with Undo); undoing that change reopens it. Rejecting one (an
optional reason) is final: its title is never suggested again for the goal.

**Reconcile**: every draft item not kept both, and every open suggestion, lists the items
and baseline features whose titles look like its own (``looks_like``: Merge with
``merge_item``, or Keep both with ``keep_both``).

**Visuals** (the S10 lane's oracle.simple.visuals, when present): draft items and
suggestions carry ``flow`` and request a visual when made.
"""

import difflib
import logging
import re
import uuid
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.docs.models import Document, DocumentVersion
from oracle.jobs.models import LlmJob
from oracle.members.names import display_name
from oracle.roadmap.models import HORIZONS, ProductTrack, RoadmapItem
from oracle.simple import changes, drafts, quality, service
from oracle.simple.models import (
    RoadmapDateSuggestion,
    SimpleChange,
    SimpleDraft,
    SimpleGoalAuto,
    SimpleGoalSuggestion,
)
from oracle.simple.schemas import (
    SimpleChangeIn,
    SimpleChangeResult,
    SimpleEvidence,
    SimpleFlow,
    SimpleGoalBrief,
    SimpleGoalSuggestionGoal,
    SimpleGoalSuggestionsOut,
    SimpleMatch,
    SimpleMergedInto,
    SimpleSuggestJobOut,
)
from oracle.simple.schemas import (
    SimpleGoalSuggestion as SuggestionOut,
)

try:
    from oracle.simple import visuals  # type: ignore[attr-defined]
except ImportError:  # the S10 lane's module is not here yet
    visuals = None

log = logging.getLogger(__name__)

OPS = ("add_item",)
ChangeError = changes.ChangeError
WHERE = ("quarter", "horizon", "goal")
QUARTER = re.compile(r"^(\d{4})-Q([1-4])$")
RUNNING = ("queued", "running")
LOOKS_LIKE = 0.6
MAX_MATCHES = 2
MIN_SUGGESTIONS, MAX_SUGGESTIONS = 3, 5
TEXT_MAX = 1000


# --------------------------------------------------------------------------- helpers


def _norm(title: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", (title or "").casefold()))


def _like(a: str, b: str) -> float:
    """How alike two titles read: the better of their character ratio and word overlap."""
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return 0.0
    wa, wb = set(na.split()), set(nb.split())
    return max(difflib.SequenceMatcher(None, na, nb).ratio(), len(wa & wb) / len(wa | wb))


def quarter_span(value: str) -> tuple[date, date]:
    m = QUARTER.match(value or "")
    if m is None:
        raise ChangeError(422, "target.where.value: a quarter as YYYY-Qn")
    year, q = int(m.group(1)), int(m.group(2))
    start = date(year, 3 * q - 2, 1)
    end = date(year + (q == 4), 1 if q == 4 else 3 * q + 1, 1) - timedelta(days=1)
    return start, end


def _slug(title: str) -> str:
    return "-".join(_norm(title).split())[:24].strip("-") or "item"


async def _flow(db: AsyncSession, kind: str, subject_id: uuid.UUID) -> SimpleFlow | None:
    if visuals is None:
        return None
    return await visuals.flow_for(db, kind, subject_id)


async def _request_visual(db: AsyncSession, principal: Any, kind: str, sid: uuid.UUID,
                          brief: str) -> None:  # fmt: skip
    if visuals is None:
        return
    try:
        await visuals.request_visual(db, principal, kind, sid, brief)
    except Exception:  # a visual is a nicety: the addition stands without one
        log.exception("S7: requesting a visual for %s %s failed", kind, sid)


async def _goal(db: AsyncSession, goal_id: Any) -> Entity:
    try:
        gid = uuid.UUID(str(goal_id))
    except ValueError as e:
        raise ChangeError(422, "A goal's id") from e
    g = await db.get(Entity, gid)
    if g is None or g.type != "goal" or g.status == "rejected":
        raise ChangeError(422, "No such goal")
    return g


async def _shown_version(db: AsyncSession, doc: uuid.UUID) -> uuid.UUID | None:
    """The version a new draft of the roadmap is opened on: its working draft's base, else
    the latest approved version with items, else its latest approved, else its latest."""
    d = await db.scalar(
        select(SimpleDraft).where(SimpleDraft.document_id == doc, SimpleDraft.status == "working")
    )
    if d is not None:
        return d.base_version_id
    hidden = await drafts.submitted_versions(db)
    vs = [
        v
        for v in await db.scalars(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == doc)
            .order_by(DocumentVersion.number)
        )
        if v.id not in hidden
    ]
    with_items = set(
        await db.scalars(
            select(RoadmapItem.roadmap_version_id)
            .where(RoadmapItem.roadmap_document_id == doc)
            .distinct()
        )
    )
    approved = [v for v in vs if v.approved_at is not None]
    for pool in ([v for v in approved if v.id in with_items], approved, vs):
        if pool:
            return pool[-1].id
    return None


async def _roadmap_for(
    db: AsyncSession, principal: Any, given: Any, goal: Entity | None, read_: service.Read
) -> Document:
    """The roadmap a new item goes to: the one asked for, else the roadmap of the goal's
    items, else the first the caller may change, else the first."""
    if given:
        try:
            doc = await db.get(Document, uuid.UUID(str(given)))
        except ValueError as e:
            raise ChangeError(422, "target.roadmap_id: a roadmap's id") from e
        if doc is None or doc.kind != "roadmap":
            raise ChangeError(404, "No such roadmap")
        if doc.visibility == "approvers" and not has_role(principal.role, "approver"):
            raise ChangeError(404, "No such roadmap")
        return doc
    if goal is not None:
        for e in read_.entries:
            if e.goal is not None and e.goal.id == goal.id:
                return e.roadmap
    docs = list(
        await db.scalars(
            select(Document).where(Document.kind == "roadmap").order_by(Document.created_at)
        )
    )
    docs = [d for d in docs if d.visibility != "approvers" or has_role(principal.role, "approver")]
    if not docs:
        raise ChangeError(409, "There is no roadmap to add to yet")
    w = await drafts.who(db, {d.id for d in docs})
    return next((d for d in docs if drafts.can_edit(principal, d.id, w)), docs[0])


async def _route(db: AsyncSession, doc: uuid.UUID, w: drafts.Who) -> list[uuid.UUID]:
    """Who decides an addition: the roadmap's decider, else its owners who are approvers
    or owners, else the company's owners."""
    if w.deciders.get(doc) is not None:
        return [w.deciders[doc]]  # type: ignore[list-item]
    owners = w.owners.get(doc, set())
    if owners:
        able = [
            u.id
            for u in await db.scalars(
                select(User).where(User.id.in_(owners), User.disabled_at.is_(None))
            )
            if has_role(u.role, "approver")
        ]
        if able:
            return sorted(able)
    return await changes._company_owners(db)


def may_decide(principal: Any, c: SimpleChange, view: Any) -> bool:
    """Who accepts an addition: the roadmap's rule (drafts.can_edit) as the view knows it."""
    me = getattr(principal, "user_id", None)
    if me is None or c.document_id is None:
        return False
    if has_role(principal.role, "owner"):
        return True
    decider = view.deciders.get(c.document_id)
    if decider is not None:
        return decider == me
    return me in view.owners.get(c.document_id, set()) and has_role(principal.role, "approver")


# --------------------------------------------------------------------------- add_item


async def _plan(db: AsyncSession, principal: Any, body: SimpleChangeIn, read_: service.Read):
    title = " ".join(str(body.after.get("title") or "").split())
    if not title or len(title) > changes.TITLE_MAX:
        raise ChangeError(422, f"after.title: 1 to {changes.TITLE_MAX} characters")
    where = body.target.get("where") or {}
    kind, value = where.get("kind"), str(where.get("value") or "")
    if kind not in WHERE:
        raise ChangeError(422, "target.where.kind: quarter, horizon or goal")
    goal = None
    span: tuple[date, date] | None = None
    horizon = "next"
    if kind == "goal":
        goal = await _goal(db, value)
        value = str(goal.id)
    elif kind == "horizon":
        if value not in HORIZONS:
            raise ChangeError(422, "target.where.value: now, next or later")
        horizon = value
    else:
        span = quarter_span(value)
        if span[1] < read_.today:
            raise ChangeError(422, "That quarter is over")
        first = max(span[0], read_.today)
        horizon = next(
            (h for h in HORIZONS if read_.windows[h][0] <= first <= read_.windows[h][1]),
            "later",
        )
    doc = await _roadmap_for(db, principal, body.target.get("roadmap_id"), goal, read_)
    outcome = body.after.get("outcome")
    outcome = str(outcome).strip()[:TEXT_MAX] if outcome else None
    target = {
        "item_id": str(uuid.uuid4()),
        "roadmap_id": str(doc.id),
        "where": {"kind": kind, "value": value},
    }
    if body.target.get("suggestion_id"):
        target["suggestion_id"] = str(body.target["suggestion_id"])
    after: dict[str, Any] = {
        "title": title,
        "horizon": horizon,
        "goal_ids": [str(goal.id)] if goal is not None else [],
        "outcome": outcome,
    }
    if span is not None:
        after["quarter"] = {"start": span[0].isoformat(), "end": span[1].isoformat()}
    # roadmap-talk: an item added from the talk may come with its dates and milestone.
    start = changes._day(body.after.get("start_date"), "after.start_date")
    end = changes._day(body.after.get("end_date"), "after.end_date")
    if (start is None) != (end is None) or (start and end and end < start):
        raise ChangeError(422, "after.start_date and after.end_date: both, the end not first")
    if start is not None and end is not None:
        after["start_date"], after["end_date"] = start.isoformat(), end.isoformat()
    m = body.after.get("milestone")
    if m is not None:
        name = " ".join(str(m.get("name") or "").split()) if isinstance(m, dict) else ""
        if not name or len(name) > changes.TITLE_MAX:
            raise ChangeError(422, f"after.milestone.name: 1 to {changes.TITLE_MAX} characters")
        day = changes._day(m.get("date"), "after.milestone.date")
        after["milestone"] = {"name": name, "date": changes._iso(day),
                              "date_source": "typed" if day else None}  # fmt: skip
    return doc, target, after


async def _place(
    db: AsyncSession, principal: Any, c: SimpleChange, session: Any, me: uuid.UUID
) -> RoadmapItem:
    """Make the change's item in the roadmap's working draft, and queue Oracle's drafting."""
    from oracle.jobs import service as jobs

    doc = uuid.UUID(c.target["roadmap_id"])
    item_id = uuid.UUID(c.target["item_id"])
    if await db.get(RoadmapItem, item_id) is not None:
        raise ChangeError(409, "This item was added already")
    base = await _shown_version(db, doc)
    d = await drafts.ensure(
        db, session, SimpleNamespace(roadmap_document_id=doc, roadmap_version_id=base), me
    )
    taken = set(
        await db.scalars(
            select(RoadmapItem.item_key).where(
                (RoadmapItem.roadmap_version_id == base) | (RoadmapItem.simple_draft_id == d.id)
            )
        )
    )
    key, n = _slug(c.after["title"]), 2
    while key in taken:
        key, n = f"{_slug(c.after['title'])[:21]}-{n}", n + 1
    position = await db.scalar(
        select(func.max(RoadmapItem.position)).where(
            (RoadmapItem.roadmap_version_id == base) | (RoadmapItem.simple_draft_id == d.id)
        )
    )
    goal_ids = [uuid.UUID(g) for g in c.after.get("goal_ids") or []]
    # Its track: the roadmap's track of the goal's items, else its first (so it has an owner).
    track = await db.scalar(
        select(ProductTrack)
        .where(ProductTrack.roadmap_document_id == doc)
        .order_by(ProductTrack.created_at)
        .limit(1)
    )
    row = RoadmapItem(
        id=item_id,
        roadmap_document_id=doc,
        roadmap_version_id=None,
        simple_draft_id=d.id,
        item_key=key,
        position=(position or 0) + 1,
        title=c.after["title"],
        outcome=c.after.get("outcome"),
        horizon=c.after["horizon"],
        draft=True,
        goal_ids=goal_ids,
        track_id=track.id if track is not None else None,
        prd_document_id=track.prd_document_id if track is not None else None,
        prd_version_id=track.current_version_id if track is not None else None,
        note="added in Simple",
        start_date=date.fromisoformat(c.after["start_date"]) if c.after.get("start_date") else None,
        end_date=date.fromisoformat(c.after["end_date"]) if c.after.get("end_date") else None,
        date_source="typed" if c.after.get("start_date") else None,
        milestone=c.after.get("milestone"),
    )
    db.add(row)
    await db.flush()
    c.draft_ids = [d.id]
    document = await db.get(Document, doc)
    try:
        await jobs.enqueue(
            db,
            document,
            "item_draft",
            input={"item_id": str(item_id), "quarter": c.after.get("quarter")},
            principal=principal,
        )
    except jobs.JobError as e:
        log.info("S7: Oracle's drafting is off for %s: %s", doc, e.detail)
    await _request_visual(db, principal, "draft_item", item_id, c.after["title"])
    return row


async def _suggestion(db: AsyncSession, c: SimpleChange) -> SimpleGoalSuggestion | None:
    sid = c.target.get("suggestion_id")
    return await db.get(SimpleGoalSuggestion, uuid.UUID(sid), with_for_update=True) if sid else None


def _reopen(s: SimpleGoalSuggestion | None) -> None:
    if s is not None and s.status == "accepted":
        s.status, s.change_id, s.item_id, s.decided_by, s.decided_at = (
            "open",
            None,
            None,
            None,
            None,
        )


async def create(db: AsyncSession, principal: Any, body: SimpleChangeIn) -> SimpleChangeResult:
    me, now = changes._me(principal), company_time.now()
    if not has_role(principal.role, "commenter"):
        raise ChangeError(403, "Viewers read the roadmap; commenters and up add to it")
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    doc, target, after = await _plan(db, principal, body, read_)
    w = await drafts.who(db, {doc.id})
    applies = drafts.can_edit(principal, doc.id, w)
    session = await changes._session_for_change(db, me, body.session_id, applies, now)
    c = SimpleChange(
        session_id=session.id if session else None,
        document_id=doc.id,
        op="add_item",
        target=target,
        before={},
        after=after,
        status="applied" if applies else "proposed",
        by=me,
        at=now,
        reason=body.reason,
        routed_to=[] if applies else await _route(db, doc.id, w),
    )
    s = await _suggestion(db, c)
    if target.get("suggestion_id") and (s is None or s.status != "open"):
        raise ChangeError(409, f"This suggestion is {s.status if s else 'gone'} already")
    if applies:
        await _place(db, principal, c, session, me)
        session.last_change_at = now  # type: ignore[union-attr]
    db.add(c)
    await db.flush()
    if s is not None:
        s.status, s.change_id, s.item_id = "accepted", c.id, uuid.UUID(target["item_id"])
        s.decided_by, s.decided_at = me, now
    flags = await changes._flags(db, c, await drafts.overlays_for(db, principal)) if applies else []
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": target, "after": after,
                             "document_id": str(doc.id)})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=flags)


async def decide(
    db: AsyncSession, principal: Any, c: SimpleChange, action: str, reason: str | None
) -> SimpleChangeResult:
    me, now = changes._me(principal), company_time.now()
    w = await drafts.who(db, {c.document_id} if c.document_id else set())
    if c.document_id is None or not drafts.can_edit(principal, c.document_id, w):
        raise ChangeError(
            403,
            "Only an owner or the roadmap's decider (with no decider, its owner) decides proposals",
        )
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept":
        session = await changes._session_for_change(db, me, None, True, now)
        await _place(db, principal, c, session, me)
        session.last_change_at = now  # type: ignore[union-attr]
    else:
        _reopen(await _suggestion(db, c))
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = me, now, reason
    await db.flush()
    flags = await changes._flags(db, c, await drafts.overlays_for(db, principal))
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=flags)


async def undo(db: AsyncSession, principal: Any, c: SimpleChange) -> SimpleChangeResult:
    from oracle.simple.models import SimpleSession

    me, now = changes._me(principal), company_time.now()
    if c.status != "applied":
        raise ChangeError(409, f"Only an applied change undoes; this one is {c.status}")
    if c.by != me:
        raise ChangeError(403, "Only the person who made a change undoes it")
    if await db.scalar(select(SimpleChange.id).where(SimpleChange.undoes_id == c.id)):
        raise ChangeError(409, "This change is undone already")
    session = (
        await db.get(SimpleSession, c.session_id, with_for_update=True) if c.session_id else None
    )
    if session is None or session.closed_at is not None or changes._idle(session, now):
        raise ChangeError(409, "Its session is closed: undo works only in the change's session")
    item_id = c.target["item_id"]
    row = await db.get(RoadmapItem, uuid.UUID(item_id), with_for_update=True)
    d = await db.get(SimpleDraft, row.simple_draft_id, with_for_update=True) if row else None
    if row is None or row.roadmap_version_id is not None or d is None or d.status != "working":
        raise ChangeError(409, "Its draft was submitted: undo works only inside a working draft")
    # Any live change that touches it: one naming it, a merge that kept it (into_id), or
    # a keyed change (a fix, merge_item) writing it.
    later = [
        x
        for x in await db.scalars(
            select(SimpleChange).where(
                SimpleChange.id != c.id,
                SimpleChange.document_id == c.document_id,
                SimpleChange.status.in_(("applied", "accepted")),
            )
        )
        if item_id in changes._touched(x) or (x.target or {}).get("into_id") == item_id
    ]
    undone = set(
        await db.scalars(
            select(SimpleChange.undoes_id).where(SimpleChange.undoes_id.in_([x.id for x in later]))
        )
    ) if later else set()  # fmt: skip
    if any(x.id not in undone for x in later):
        raise ChangeError(409, "Changed since: undo the later changes to it first")
    d.overlay = {k: v for k, v in (d.overlay or {}).items() if k != item_id}
    await drafts.link(db, session, d)
    await db.delete(row)
    _reopen(await _suggestion(db, c))
    u = SimpleChange(session_id=c.session_id, document_id=c.document_id, op=c.op, target=c.target,
                     before=c.after, after={}, status="undone", by=me, at=now, undoes_id=c.id,
                     routed_to=[], draft_ids=list(c.draft_ids or []))  # fmt: skip
    db.add(u)
    session.last_change_at = now
    await db.flush()
    await audit.record(db, principal, "simple_change.undone", "simple_change", u.id,
                       data={"op": c.op, "target": c.target, "undoes_id": str(c.id)})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, u), flags=[])


# --------------------------------------------------------------------------- reconcile


async def _features(db: AsyncSession) -> list[Entity]:
    return list(
        await db.scalars(
            select(Entity)
            .where(Entity.type == "feature", Entity.status != "rejected")
            .order_by(Entity.key)
        )
    )


def reconcile(
    title: str,
    entries: list[service.Entry],
    features: list[Entity],
    skip: uuid.UUID | None = None,
    roadmap: uuid.UUID | None = None,
) -> list[SimpleMatch]:
    """The items (first) and baseline features whose titles look like ``title``."""
    from oracle.simple.priorities import prd_code

    items: list[tuple[float, SimpleMatch]] = []
    with_item = set()
    for e in entries:
        if e.row.feature_id:
            with_item.add(e.row.feature_id)
        if e.row.id == skip or e.status in ("cut", "merged"):
            continue
        if roadmap is not None and e.roadmap.id != roadmap:
            continue
        score = _like(title, e.row.title)
        if score >= LOOKS_LIKE:
            # Its display code (F-06) or none, never its key: the name says the rest.
            code = e.code or ""
            items.append((score, SimpleMatch(kind="item", id=str(e.row.id), code=code,
                                             title=e.row.title)))  # fmt: skip
    feats: list[tuple[float, SimpleMatch]] = []
    for f in features:
        if f.id in with_item:
            continue
        score = _like(title, f.title)
        if score >= LOOKS_LIKE:
            code = prd_code(f.key) or ""
            feats.append((score, SimpleMatch(kind="feature", id=str(f.id), code=code,
                                             title=f.title)))  # fmt: skip
    ranked = sorted(items, key=lambda t: -t[0]) + sorted(feats, key=lambda t: -t[0])
    return [m for _, m in ranked][:MAX_MATCHES]


async def _drafting(db: AsyncSession, ids: list[str]) -> set[str]:
    if not ids:
        return set()
    return set(
        await db.scalars(
            select(LlmJob.input["item_id"].astext).where(
                LlmJob.kind == "item_draft",
                LlmJob.status.in_(RUNNING),
                LlmJob.input["item_id"].astext.in_(ids),
            )
        )
    )


async def item_extras(
    db: AsyncSession, read_: service.Read, shown: list[service.Entry]
) -> dict[uuid.UUID, dict[str, Any]]:
    """S7's fields of the roadmap read's items: looks_like, merged_into, drafting, flow."""
    out: dict[uuid.UUID, dict[str, Any]] = {}
    drafts_ = [e for e in shown if e.row.draft]
    merged = [e for e in shown if e.row.merged_into]
    if not drafts_ and not merged:
        return out
    features = await _features(db) if drafts_ else []
    running = await _drafting(db, [str(e.row.id) for e in drafts_])
    by_key = {(e.roadmap.id, e.row.item_key): e for e in read_.entries}
    for e in drafts_:
        x: dict[str, Any] = {"drafting": str(e.row.id) in running}
        if not e.row.kept_both and not e.row.merged_into and e.status == "draft":
            x["looks_like"] = reconcile(e.row.title, read_.entries, features, e.row.id,
                                        e.roadmap.id)  # fmt: skip
        x["flow"] = await _flow(db, "draft_item", e.row.id)
        out[e.row.id] = x
    for e in merged:
        kept = by_key.get((e.roadmap.id, e.row.merged_into))
        out.setdefault(e.row.id, {})["merged_into"] = SimpleMergedInto(
            id=str(kept.row.id) if kept else "",
            code=(kept.code if kept else None) or e.row.merged_into,  # type: ignore[arg-type]
            title=kept.row.title if kept else e.row.merged_into,  # type: ignore[arg-type]
        )
    return out


# --------------------------------------------------------------------------- the jobs


async def run_item_draft(s: AsyncSession, job: LlmJob, ask) -> dict[str, Any]:
    """The ``item_draft`` job: one call; fills what a person has not."""
    row = await s.get(RoadmapItem, uuid.UUID(str(job.input.get("item_id"))), with_for_update=True)
    if row is None or not row.draft or row.merged_into:
        return {"drafted": False}
    d = await s.get(SimpleDraft, row.simple_draft_id) if row.simple_draft_id else None
    ov = (d.overlay or {}).get(str(row.id)) if d is not None else None
    cur = drafts.overlaid(row, ov)
    features = await _features(s)
    keys = [
        (r.item_key, r.title)
        for r in await s.scalars(
            select(RoadmapItem).where(
                (RoadmapItem.roadmap_version_id == (d.base_version_id if d else None))
                | (RoadmapItem.simple_draft_id == row.simple_draft_id),
                RoadmapItem.id != row.id,
            )
        )
    ]
    goals = [g for g in await s.scalars(select(Entity).where(Entity.id.in_(cur.goal_ids or [])))]
    quarter = job.input.get("quarter")
    payload = {
        "title": cur.title,
        "horizon": cur.horizon,
        "quarter": quarter,
        "today": (await company_time.company_today(s)).isoformat(),
        "goals": [{"key": g.key, "title": g.title} for g in goals],
        "features": [{"key": f.key, "title": f.title} for f in features[:200]],
        "items": [{"key": k, "title": t} for k, t in keys],
    }
    # oracle.simple.quality: a failing draft is asked once more with its failures named;
    # failing again, nothing of it is written (nothing new) and the job names the checks.
    answer = await ask("item_draft", payload)
    checks = quality.item_draft(answer, goals)
    if checks:
        answer = await ask("item_draft", {**payload, "failed_checks": quality.said(checks)})
        checks = quality.item_draft(answer, goals)
    if checks:
        return {"drafted": False, "checks": quality.said(checks)}
    values: dict[str, Any] = {}
    outcome = answer.get("outcome")
    if not cur.outcome and isinstance(outcome, str) and outcome.strip():
        values["outcome"] = outcome.strip()[:TEXT_MAX]
    fk = answer.get("feature_key")
    feature = next((f for f in features if f.key == fk), None)
    if cur.feature_id is None and feature is not None:
        values["feature_id"] = str(feature.id)
    known = {k for k, _ in keys}
    deps = [k for k in answer.get("depends_on") or [] if isinstance(k, str) and k in known]
    if deps and not cur.depends_on:
        values["depends_on"] = list(dict.fromkeys(deps))
    for f, v in values.items():
        setattr(row, f, drafts._typed(f, v))
    if ov is not None and values:
        d.overlay = {**(d.overlay or {}), str(row.id): {**ov, **values}}  # type: ignore[union-attr]
    suggested = await _date_suggestion(s, cur, answer, quarter)
    await s.flush()
    return {"drafted": True, "filled": sorted(values), "dates": suggested}


async def _date_suggestion(s: AsyncSession, cur: RoadmapItem, answer: dict, quarter: Any) -> bool:
    if cur.start_date or cur.end_date:
        return False
    try:
        start = date.fromisoformat(str(answer.get("start_date")))
        end = date.fromisoformat(str(answer.get("end_date")))
    except ValueError:
        return False
    if isinstance(quarter, dict):
        q0, q1 = date.fromisoformat(quarter["start"]), date.fromisoformat(quarter["end"])
        start, end = max(start, q0), min(end, q1)
    if end < start:
        return False
    if await s.scalar(
        select(RoadmapDateSuggestion.id).where(
            RoadmapDateSuggestion.item_id == cur.id, RoadmapDateSuggestion.status == "open"
        )
    ):
        return False
    basis = str(answer.get("basis") or "Oracle's draft of a new item.").strip()[:300]
    s.add(RoadmapDateSuggestion(item_id=cur.id, start_date=start, end_date=end, basis=basis,
                                status="open"))  # fmt: skip
    return True


def _confidence(v: Any) -> str:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return "low"
    return "high" if x >= 0.75 else "medium" if x >= 0.5 else "low"


def _checked(answer: Any, goal: Entity, read_: service.Read, features: list[Entity]):
    """The answer's suggestions (dicts with a title), each with its failed checks."""
    raw = (answer or {}).get("suggestions") or [] if isinstance(answer, dict) else []
    out = []
    for a in raw:
        if isinstance(a, dict) and " ".join(str(a.get("title") or "").split()):
            out.append((a, quality.suggestion(a, goal, read_.entries, features)))
    return out


async def run_goal_suggestions(s: AsyncSession, job: LlmJob, ask) -> dict[str, Any]:
    """The ``goal_suggestions`` job: 3-5 features for one goal; never a rejected title."""
    goal = await s.get(Entity, uuid.UUID(str(job.input.get("goal_id"))))
    if goal is None or goal.type != "goal":
        return {"suggested": 0}
    taken = list(
        await s.scalars(select(SimpleGoalSuggestion).where(SimpleGoalSuggestion.goal_id == goal.id))
    )
    rejected = [x.title for x in taken if x.status == "rejected"]
    serving = list(
        await s.scalars(
            select(Entity)
            .join(Edge, Edge.src_id == Entity.id)
            .where(Edge.dst_id == goal.id, Edge.type == "supports", Edge.status != "rejected")
        )
    )
    evidence = list(
        await s.scalars(
            select(Evidence)
            .where(Evidence.entity_id.in_([goal.id, *[f.id for f in serving]]))
            .order_by(Evidence.confidence.desc().nulls_last())
            .limit(40)
        )
    )
    refs = {str(e.id): e for e in evidence}
    features = await _features(s)
    payload = {
        "goal": {
            "key": goal.key,
            "title": goal.title,
            "description": (goal.attrs or {}).get("description"),
        },  # fmt: skip
        "serving_features": [{"key": f.key, "title": f.title} for f in serving],
        "features": [{"key": f.key, "title": f.title} for f in features[:200]],
        "evidence": [
            {
                "ref": str(e.id),
                "label": (e.excerpt or e.url or e.kind or "evidence")[:160],
                "kind": e.kind,
                "confidence": _confidence(e.confidence),
            }  # fmt: skip
            for e in evidence
        ],
        "rejected": rejected,
        "open": [x.title for x in taken if x.status == "open"],
        "min": MIN_SUGGESTIONS,
        "max": MAX_SUGGESTIONS,
    }
    # oracle.simple.quality: each suggestion names its goal, is no duplicate of a roadmap item
    # or a feature, has a one-line title and no chatter; failing, the job asks once more with
    # the failures named; failing again, it is stored with them (owners only).
    read_ = await service.load(s)
    answer = await ask("goal_suggestions", payload)
    checked = _checked(answer, goal, read_, features)
    if any(c for _, c in checked):
        named = [x for _, c in checked for x in quality.said(c)]
        answer = await ask("goal_suggestions", {**payload, "failed_checks": named})
        checked = _checked(answer, goal, read_, features)
    seen = {_norm(t) for t in rejected} | {_norm(x.title) for x in taken if x.status == "open"}
    made: list[SimpleGoalSuggestion] = []
    for a, checks in checked:
        if len(made) >= MAX_SUGGESTIONS:
            continue
        title = " ".join(str(a.get("title") or "").split())[: changes.TITLE_MAX]
        if not title or _norm(title) in seen:
            continue
        seen.add(_norm(title))
        links = []
        for ev in a.get("evidence") or []:
            e = refs.get(str((ev or {}).get("ref")))
            if e is not None:
                label = str(ev.get("label") or e.excerpt or e.kind or "evidence")[:160]
                links.append({"label": label, "kind": e.kind or "evidence", "ref": str(e.id),
                              "url": e.url, "confidence": _confidence(e.confidence)})  # fmt: skip
        row = SimpleGoalSuggestion(
            goal_id=goal.id,
            title=title,
            outcome=str(a.get("outcome") or "").strip()[:TEXT_MAX] or None,
            why=str(a.get("why") or "").strip()[:TEXT_MAX] or None,
            evidence=links,
            origin=job.input.get("origin") if job.input.get("origin") == "auto" else "on_demand",
            job_id=job.id,
            checks=checks or None,
        )
        s.add(row)
        made.append(row)
    await s.flush()
    for row in made:
        await _request_visual(s, None, "suggestion", row.id, row.title)
    return {"suggested": len(made)}


# --------------------------------------------------------------------------- suggestions


async def _job_document(
    db: AsyncSession, goal: Entity, read_: service.Read | None = None
) -> Document | None:
    """The roadmap a goal's suggestions job is filed under (and whose decider decides its
    suggestions): one holding its items, else the company's first roadmap."""
    read_ = read_ or await service.load(db)
    for e in read_.entries:
        if e.goal is not None and e.goal.id == goal.id:
            return e.roadmap
    return await db.scalar(
        select(Document).where(Document.kind == "roadmap").order_by(Document.created_at).limit(1)
    )


async def _enqueue_suggestions(
    db: AsyncSession, goal: Entity, origin: str, principal: Any
) -> LlmJob:
    from oracle.jobs import service as jobs

    doc = await _job_document(db, goal)
    if doc is None:
        raise ChangeError(409, "There is no roadmap yet")
    try:
        return await jobs.enqueue(db, doc, "goal_suggestions",
                                  input={"goal_id": str(goal.id), "origin": origin},
                                  principal=principal)  # fmt: skip
    except jobs.JobError as e:
        raise ChangeError(e.status, e.detail) from e


def _live_goals(read_: service.Read) -> set[uuid.UUID]:
    out: set[uuid.UUID] = set()
    for e in read_.entries:
        if e.status in ("cut", "merged"):
            continue
        if e.goal is not None:
            out.add(e.goal.id)
        out.update(e.row.goal_ids or [])
    return out


async def _goals(db: AsyncSession) -> list[Entity]:
    return list(
        await db.scalars(
            select(Entity)
            .where(Entity.type == "goal", Entity.status == "confirmed")
            .order_by(Entity.key)
        )
    )


async def suggest_for_empty_goals(db: AsyncSession) -> int:
    """Queue Oracle's suggestions for each confirmed goal with no roadmap items, once per
    goal ever (the caller commits); how many."""
    read_ = await service.load(db)
    live = _live_goals(read_)
    # Items added in a working draft serve their goals too, published or not.
    for ids in await db.scalars(
        select(RoadmapItem.goal_ids)
        .join(SimpleDraft, SimpleDraft.id == RoadmapItem.simple_draft_id)
        .where(SimpleDraft.status.in_(drafts.OPEN), RoadmapItem.roadmap_version_id.is_(None))
    ):
        live.update(ids or [])
    done = set(await db.scalars(select(SimpleGoalAuto.goal_id)))
    n = 0
    for g in await _goals(db):
        if g.id in live or g.id in done:
            continue
        try:
            job = await _enqueue_suggestions(db, g, "auto", None)
        except ChangeError as e:
            log.info("S7: no automatic suggestions for goal %s: %s", g.key, e.detail)
            continue
        db.add(SimpleGoalAuto(goal_id=g.id, job_id=job.id))
        n += 1
    await db.flush()
    return n


async def suggest(db: AsyncSession, principal: Any, goal_id: uuid.UUID) -> SimpleSuggestJobOut:
    """ "Suggest features" on a goal: a new job each time (the caller commits)."""
    if not has_role(principal.role, "commenter") or getattr(principal, "user_id", None) is None:
        raise ChangeError(403, "Commenters and up ask Oracle for suggestions")
    goal = await _goal(db, goal_id)
    job = await _enqueue_suggestions(db, goal, "on_demand", principal)
    await audit.record(db, principal, "simple_goal.suggest", "entity", goal.id,
                       data={"job_id": str(job.id)})  # fmt: skip
    return SimpleSuggestJobOut(goal_id=str(goal.id), pending=True, job_id=str(job.id))


def _brief(g: Entity) -> SimpleGoalBrief:
    return SimpleGoalBrief(id=str(g.id), key=g.key, title=g.title)


async def listing(
    db: AsyncSession, principal: Any, goal_id: uuid.UUID | None, status: str | None
) -> SimpleGoalSuggestionsOut:
    goals = await _goals(db)
    if goal_id is not None:
        goals = [g for g in goals if g.id == goal_id]
    by_id = {g.id: g for g in goals}
    q = select(SimpleGoalSuggestion).where(SimpleGoalSuggestion.goal_id.in_(list(by_id)))
    if status:
        q = q.where(SimpleGoalSuggestion.status == status)
    rows = list(
        await db.scalars(q.order_by(SimpleGoalSuggestion.created_at, SimpleGoalSuggestion.id))
    )
    # oracle.simple.quality: a suggestion that failed its checks twice is the owners' to look at.
    owner = has_role(principal.role, "owner")
    rows = [r for r in rows if owner or not r.checks]
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    live = _live_goals(read_)
    pending = set(
        await db.scalars(
            select(LlmJob.input["goal_id"].astext).where(
                LlmJob.kind == "goal_suggestions", LlmJob.status.in_(RUNNING)
            )
        )
    )
    features = await _features(db) if any(r.status == "open" for r in rows) else []
    names = await changes._names(db, {r.decided_by for r in rows if r.decided_by})
    rule = await deciding(db, principal, goals, read_)
    people = await _display_names(
        db, {r.proposed_by for r in rows if r.proposed_by} | {d for _, d in rule.values() if d}
    )
    out = []
    for r in rows:
        out.append(
            SuggestionOut(
                id=str(r.id),
                goal=_brief(by_id[r.goal_id]),
                title=r.title,
                outcome=r.outcome or "",
                why=r.why or "",
                evidence=[SimpleEvidence(**e) for e in r.evidence or []],
                status=r.status,
                reason=r.reason,
                origin=r.origin,
                created_at=r.created_at,  # type: ignore[arg-type]
                decided_by_name=names.get(r.decided_by) if r.decided_by else None,
                decided_at=r.decided_at,
                change_id=str(r.change_id) if r.change_id else None,
                item_id=str(r.item_id) if r.item_id else None,
                looks_like=reconcile(r.title, read_.entries, features)
                if r.status == "open"
                else [],
                flow=await _flow(db, "suggestion", r.id),
                can_accept=rule[r.goal_id][0] and r.status == "open",
                can_reject=rule[r.goal_id][0] and r.status == "open",
                proposed_by_name=people.get(r.proposed_by) if r.proposed_by else None,
                needs_look=quality.said(r.checks) if owner else [],
            )  # fmt: skip
        )
    return SimpleGoalSuggestionsOut(
        goals=[
            SimpleGoalSuggestionGoal(
                goal=_brief(g),
                pending=str(g.id) in pending,
                empty=g.id not in live,
                decider_name=people.get(rule[g.id][1]) if rule[g.id][1] else None,
                can_decide=rule[g.id][0],
            )  # fmt: skip
            for g in goals
        ],
        suggestions=out,
    )


async def accept(
    db: AsyncSession,
    principal: Any,
    suggestion_id: uuid.UUID,
    roadmap_id: uuid.UUID | None,
    session_id: uuid.UUID | None,
) -> SimpleChangeResult:
    """Accept a suggestion (who decides the goal's suggestions): an add_item on its goal,
    applied at once on the goal's roadmap (with Undo)."""
    s = await db.get(SimpleGoalSuggestion, suggestion_id)
    if s is None:
        raise ChangeError(404, "No such suggestion")
    doc = await _decide(db, principal, s)
    if s.status != "open":
        raise ChangeError(409, f"This suggestion is {s.status} already")
    roadmap_id = roadmap_id or (doc.id if doc is not None else None)
    body = SimpleChangeIn(
        session_id=session_id,
        op="add_item",
        target={
            "roadmap_id": str(roadmap_id) if roadmap_id else None,
            "where": {"kind": "goal", "value": str(s.goal_id)},
            "suggestion_id": str(s.id),
        },
        before={},
        after={"title": s.title, "outcome": s.outcome},
    )
    return await create(db, principal, body)


async def reject(
    db: AsyncSession, principal: Any, suggestion_id: uuid.UUID, reason: str | None
) -> SuggestionOut:
    s = await db.get(SimpleGoalSuggestion, suggestion_id, with_for_update=True)
    if s is None:
        raise ChangeError(404, "No such suggestion")
    await _decide(db, principal, s)
    if s.status != "open":
        raise ChangeError(409, f"This suggestion is {s.status} already")
    s.status, s.reason = "rejected", (reason or "").strip() or None
    s.decided_by, s.decided_at = principal.user_id, company_time.now()
    await db.flush()
    await audit.record(db, principal, "simple_goal_suggestion.rejected", "simple_goal_suggestion",
                       s.id, data={"reason": s.reason})  # fmt: skip
    out = await listing(db, principal, s.goal_id, None)
    return next(x for x in out.suggestions if x.id == str(s.id))


# --------------------------------------------------------------------------- people's


DECIDER_ONLY = "Only the decider accepts or rejects suggestions"


async def _display_names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    users = await db.scalars(select(User).where(User.id.in_(ids)))
    return {u.id: display_name(u.email, u.name) for u in users}


async def deciding(
    db: AsyncSession, principal: Any, goals: list[Entity], read_: service.Read
) -> dict[uuid.UUID, tuple[bool, uuid.UUID | None]]:
    """Per goal: whether the caller decides its suggestions (drafts.can_edit on the goal's
    roadmap: an owner, its decider, with none its owners who are approvers) and who decides
    them (the first of _route: the decider, else its approving owners, else the company's
    owners)."""
    docs = {g.id: await _job_document(db, g, read_) for g in goals}
    w = await drafts.who(db, {d.id for d in docs.values() if d is not None})
    routes: dict[uuid.UUID, uuid.UUID | None] = {}
    out: dict[uuid.UUID, tuple[bool, uuid.UUID | None]] = {}
    for g in goals:
        d = docs[g.id]
        if d is None:
            out[g.id] = (has_role(principal.role, "owner") and _me_or_none(principal) is not None,
                         None)  # fmt: skip
            continue
        if d.id not in routes:
            routes[d.id] = next(iter(await _route(db, d.id, w)), None)
        out[g.id] = (drafts.can_edit(principal, d.id, w), routes[d.id])
    return out


def _me_or_none(principal: Any) -> uuid.UUID | None:
    return getattr(principal, "user_id", None)


async def _decide(db: AsyncSession, principal: Any, s: SimpleGoalSuggestion) -> Document | None:
    """The goal's roadmap, when the caller decides its suggestions (else 403)."""
    goal = await db.get(Entity, s.goal_id)
    if goal is None:
        raise ChangeError(404, "No such suggestion")
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    if not (await deciding(db, principal, [goal], read_))[goal.id][0]:
        raise ChangeError(403, DECIDER_ONLY)
    return await _job_document(db, goal, read_)


async def file_suggestion(
    db: AsyncSession, principal: Any, goal_id: Any, title: str, outcome: str
) -> SimpleGoalSuggestion:
    """A person's suggestion on a goal (commenter and up): open, origin ``person``, filed
    as them; a title like an open or rejected one of the goal is refused (the caller
    commits)."""
    me = _me_or_none(principal)
    if not has_role(principal.role, "commenter") or me is None:
        raise ChangeError(403, "Viewers read; commenters and up suggest")
    goal = await _goal(db, goal_id)
    if goal.status != "confirmed":
        raise ChangeError(422, "No such goal")
    title = " ".join((title or "").split())
    outcome = " ".join((outcome or "").split())
    if not title or len(title) > changes.TITLE_MAX:
        raise ChangeError(422, f"title: 1 to {changes.TITLE_MAX} characters")
    if not outcome or len(outcome) > TEXT_MAX:
        raise ChangeError(422, f"outcome: 1 to {TEXT_MAX} characters")
    taken = await db.execute(
        select(SimpleGoalSuggestion.title, SimpleGoalSuggestion.checks).where(
            SimpleGoalSuggestion.goal_id == goal.id,
            SimpleGoalSuggestion.status.in_(("open", "rejected")),
        )
    )
    # A held suggestion (failed its checks twice) is the owners' only: no one else is
    # refused for a title they cannot see.
    owner = has_role(principal.role, "owner")
    if _norm(title) in {_norm(t) for t, checks in taken if owner or not checks}:
        raise ChangeError(409, "This goal has that suggestion already")
    row = SimpleGoalSuggestion(goal_id=goal.id, title=title, outcome=outcome, why=None,
                               evidence=[], origin="person", proposed_by=me)  # fmt: skip
    db.add(row)
    await db.flush()
    await audit.record(db, principal, "simple_goal_suggestion.suggested", "simple_goal_suggestion",
                       row.id, data={"goal_id": str(goal.id), "title": title})  # fmt: skip
    await _request_visual(db, principal, "suggestion", row.id, title)
    return row


async def create_suggestion(
    db: AsyncSession, principal: Any, goal_id: uuid.UUID, title: str, outcome: str
) -> SuggestionOut:
    row = await file_suggestion(db, principal, goal_id, title, outcome)
    await db.commit()
    out = await listing(db, principal, row.goal_id, None)
    return next(x for x in out.suggestions if x.id == str(row.id))
