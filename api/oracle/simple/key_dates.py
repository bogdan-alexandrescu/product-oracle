"""Simple roadmap-plus (#723): a roadmap's key dates (a conference, a product launch, a board
meeting): a name, a day and an optional note, drawn as labelled markers on the timeline,
the Gantt and the waterfall, and named on an item's card when it ends within 2 weeks of one.

**Where they live**: the published key dates are rows of ``roadmap_key_dates``. Like every
roadmap change, owners' and the decider's edits go into the roadmap's one shared working
draft (oracle.simple.drafts), never into the published rows: ``overlay["key_dates"]`` holds
each changed key date by id (``null``: removed). Readers who may see the draft read the key
dates as it has them, everyone else the published ones. When the draft's version is
approved (:func:`publish`, called by the drafts' approval paths) the overlay is written to
the rows.

**Who** (D4 and D-a, as the roadmap's draft): an owner, the roadmap's decider, or with no
decider its owner (an owner of one of its tracks while an approver or owner) applies a
change (``drafts.can_edit``); approvers and commenters propose it, routed to the decider,
else the roadmap's deciding owners, else the company's owners; viewers read.

**Ops** (``target.document_id``: the roadmap; ``before``/``after``: ``{"key_date": {name,
date, note} | null}``):

- ``add_key_date``: ``after`` {name, date, note?}; the new key date's id is chosen when the
  change is made (``target.key_date_id``). ``before`` ``{"key_date": null}``.
- ``edit_key_date``: ``target.key_date_id``; ``before.key_date`` as the caller saw it,
  ``after`` any of {name, date, note}.
- ``remove_key_date``: ``target.key_date_id``; ``before.key_date`` as seen.

A change whose ``before`` differs from what the caller reads now is 409; accepting a
proposal checks it the same way ("outdated"); an undo checks that the key date still holds
the change's ``after``. Undo works step by step inside the working draft (S3a's rules).
"""

import uuid
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts
from oracle.simple.models import RoadmapKeyDate, SimpleChange, SimpleDraft, SimpleSession
from oracle.simple.schemas import (
    SimpleChangeIn,
    SimpleChangeResult,
    SimpleDocRef,
    SimpleKeyDate,
    SimpleKeyDateRoadmap,
)

OPS: frozenset[str] = frozenset({"add_key_date", "edit_key_date", "remove_key_date"})
KEY = "key_dates"
NAME_MAX = 120
NOTE_MAX = 300
FIELDS = ("name", "date", "note")


def _error(status: int, detail: Any):
    from oracle.simple.changes import ChangeError

    return ChangeError(status, detail)


# --------------------------------------------------------------------------- values


def _value(r: RoadmapKeyDate) -> dict[str, Any]:
    return {"name": r.name, "date": r.on_date.isoformat(), "note": r.note}


def _clean(given: Any, name: str) -> dict[str, Any] | None:
    """A key date as the caller gave it, in stored form; 422 when malformed."""
    if given is None:
        return None
    if not isinstance(given, dict):
        raise _error(422, f"{name}: a key date (name, date, note) or null")
    out = _checked({k: given.get(k) for k in FIELDS}, name)
    return out


def _checked(v: dict[str, Any], name: str) -> dict[str, Any]:
    title = " ".join(str(v.get("name") or "").split())
    if not title or len(title) > NAME_MAX:
        raise _error(422, f"{name}.name: 1 to {NAME_MAX} characters")
    try:
        day = date.fromisoformat(str(v.get("date") or "")[:10])
    except ValueError as e:
        raise _error(422, f"{name}.date: a day as YYYY-MM-DD") from e
    note = str(v.get("note") or "").strip() or None
    if note is not None and len(note) > NOTE_MAX:
        raise _error(422, f"{name}.note: at most {NOTE_MAX} characters")
    return {"name": title, "date": day.isoformat(), "note": note}


async def published(
    db: AsyncSession, doc_ids: set[uuid.UUID]
) -> dict[uuid.UUID, dict[str, dict[str, Any]]]:
    """Each roadmap's published key dates (id -> value)."""
    out: dict[uuid.UUID, dict[str, dict[str, Any]]] = {d: {} for d in doc_ids}
    if not doc_ids:
        return out
    for r in await db.scalars(
        select(RoadmapKeyDate).where(RoadmapKeyDate.roadmap_document_id.in_(doc_ids))
    ):
        out[r.roadmap_document_id][str(r.id)] = _value(r)
    return out


def patched(pub: dict[str, dict[str, Any]], overlay: dict[str, Any] | None) -> dict[str, Any]:
    """The key dates as a draft's overlay has them (id -> value)."""
    out = dict(pub)
    for k, v in ((overlay or {}).get(KEY) or {}).items():
        if v is None:
            out.pop(k, None)
        else:
            out[k] = v
    return out


def _sorted(values: dict[str, dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    return sorted(values.items(), key=lambda kv: (kv[1]["date"], kv[1]["name"], kv[0]))


# --------------------------------------------------------------------------- who


async def _roles(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    return dict(
        (
            await db.execute(
                select(User.id, User.role).where(User.id.in_(ids), User.disabled_at.is_(None))
            )
        ).all()
    )


async def route(db: AsyncSession, doc: uuid.UUID, w: drafts.Who) -> list[uuid.UUID]:
    """Who decides a proposal: the decider, else the roadmap's owners who decide (approver
    or owner), else the company's owners."""
    from oracle.simple.changes import _company_owners

    decider = w.deciders.get(doc)
    if decider is not None:
        return [decider]
    owners = w.owners.get(doc, set())
    roles = await _roles(db, set(owners))
    deciding = sorted((i for i in owners if has_role(roles.get(i, "viewer"), "approver")), key=str)
    return deciding or await _company_owners(db)


def may_decide(principal: Any, c: SimpleChange, view: Any) -> bool:
    """An owner, whom it is routed to, or who changes the roadmap directly now."""
    me = getattr(principal, "user_id", None)
    if me is None or c.document_id is None:
        return False
    if has_role(principal.role, "owner") or me in (c.routed_to or []):
        return True
    w = drafts.Who(deciders=dict(view.deciders), owners=dict(view.owners))
    return drafts.can_edit(principal, c.document_id, w)


# --------------------------------------------------------------------------- reading


async def _readable(db: AsyncSession, doc: uuid.UUID) -> RoadmapItem | None:
    """An item of the roadmap's shown version when the session's principal reads it (its
    draft opens on that version), else None: the one roadmap's rows, not the whole read."""
    from oracle.simple import service

    if (
        await db.scalar(select(Document.id).where(Document.id == doc, Document.kind == "roadmap"))
        is None
    ):
        return None
    versions = (
        await db.execute(
            select(
                DocumentVersion.id,
                DocumentVersion.document_id,
                DocumentVersion.number,
                DocumentVersion.approved_at,
            ).where(DocumentVersion.document_id == doc)
        )
    ).all()
    with_items = set(
        await db.scalars(
            select(RoadmapItem.roadmap_version_id)
            .where(RoadmapItem.roadmap_document_id == doc)
            .distinct()
        )
    )
    shown = service._versions(versions, with_items, await drafts.submitted_versions(db)).get(doc)
    if shown is None:
        return None
    return await db.scalar(
        select(RoadmapItem)
        .where(RoadmapItem.roadmap_version_id == shown)
        .order_by(RoadmapItem.position, RoadmapItem.item_key)
        .limit(1)
    )


async def _open_draft(db: AsyncSession, doc: uuid.UUID, lock: bool = False) -> SimpleDraft | None:
    q = select(SimpleDraft).where(
        SimpleDraft.document_id == doc, SimpleDraft.status.in_(drafts.OPEN)
    )
    if lock:
        q = q.with_for_update()
    return await db.scalar(q.order_by(SimpleDraft.created_at.desc()).limit(1))


async def roadmap_key_dates(
    db: AsyncSession, principal: Any, docs: dict[uuid.UUID, Document]
) -> tuple[list[SimpleKeyDate], list[SimpleKeyDateRoadmap]]:
    """The key dates of these roadmaps as the reader reads them (the working draft's when
    they see it), and per roadmap whether their change applies."""
    pub = await published(db, set(docs))
    w = await drafts.who(db, set(docs))
    open_ = {d.document_id: d for d in await drafts.open_drafts(db) if d.document_id in docs}
    out: list[SimpleKeyDate] = []
    for doc_id, doc in docs.items():
        d = open_.get(doc_id)
        sees = d is not None and drafts.sees(principal, d, w)
        values = patched(pub[doc_id], d.overlay if sees else None)
        changed = set(((d.overlay or {}).get(KEY) or {}) if sees and d else {})
        ref = SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title)
        for k, v in _sorted(values):
            out.append(
                SimpleKeyDate(
                    id=uuid.UUID(k),
                    roadmap=ref,
                    name=v["name"],
                    date=date.fromisoformat(v["date"]),
                    note=v.get("note"),
                    in_draft=k in changed,
                )  # fmt: skip
            )
    out.sort(key=lambda k: (k.date, k.name))
    may = has_role(principal.role, "commenter") and getattr(principal, "user_id", None) is not None
    roadmaps = [
        SimpleKeyDateRoadmap(
            roadmap=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
            applies=may and drafts.can_edit(principal, doc_id, w),
            can_change=may,
        )
        for doc_id, doc in sorted(docs.items(), key=lambda kv: kv[1].title)
    ]
    return out, roadmaps


async def _current(
    db: AsyncSession, principal: Any, doc: uuid.UUID, kd_id: str
) -> dict[str, Any] | None:
    """The key date as the caller reads it (the working draft's when they see it)."""
    d = await _open_draft(db, doc)
    w = await drafts.who(db, {doc})
    sees = d is not None and drafts.sees(principal, d, w)
    return patched((await published(db, {doc}))[doc], d.overlay if sees else None).get(kd_id)


# --------------------------------------------------------------------------- writing


async def _ensure(db: AsyncSession, session: SimpleSession, row: RoadmapItem) -> SimpleDraft:
    try:
        return await drafts.ensure(db, session, row, session.started_by)
    except drafts.DraftError as e:
        raise _error(e.status, e.detail) from e


async def _apply(
    db: AsyncSession, c: SimpleChange, values: dict[str, Any], session: SimpleSession, undo=False
) -> None:
    doc = c.document_id
    assert doc is not None
    if undo:
        d = await db.get(SimpleDraft, (c.draft_ids or [None])[0], with_for_update=True)
        if d is None or d.status != "working":
            raise _error(409, "Its draft was submitted: undo works only inside a working draft")
        await drafts.link(db, session, d)
    else:
        row = await _readable(db, doc)
        if row is None:
            raise _error(404, "No such roadmap")
        d = await _ensure(db, session, row)
    kd_id = str(c.target["key_date_id"])
    pub = (await published(db, {doc}))[doc].get(kd_id)
    kd = dict((d.overlay or {}).get(KEY) or {})
    value = values.get("key_date")
    if value == pub:
        kd.pop(kd_id, None)
    else:
        kd[kd_id] = value
    ov = {k: v for k, v in (d.overlay or {}).items() if k != KEY}
    d.overlay = {**ov, KEY: kd} if kd else ov
    c.draft_ids = [d.id]
    await db.flush()


async def publish(db: AsyncSession, d: SimpleDraft) -> None:
    """The approved draft's key dates become the roadmap's published ones."""
    for kd_id, v in ((d.overlay or {}).get(KEY) or {}).items():
        row = await db.get(RoadmapKeyDate, uuid.UUID(kd_id))
        if v is None:
            if row is not None:
                await db.delete(row)
            continue
        if row is None:
            row = RoadmapKeyDate(
                id=uuid.UUID(kd_id), roadmap_document_id=d.document_id, created_by=d.created_by,
                name=v["name"], on_date=date.fromisoformat(v["date"]),
            )  # fmt: skip
            db.add(row)
        row.name, row.on_date, row.note = v["name"], date.fromisoformat(v["date"]), v.get("note")
    await db.flush()


# --------------------------------------------------------------------------- the routes


async def _record(db: AsyncSession, principal: Any, c: SimpleChange, **data: Any) -> None:
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, **data})  # fmt: skip


async def create(db: AsyncSession, principal: Any, body: SimpleChangeIn) -> SimpleChangeResult:
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
    doc = changes._uuid(body.target.get("document_id"), "document_id")
    await db.execute(select(Document.id).where(Document.id == doc).with_for_update())
    if await _readable(db, doc) is None:
        raise _error(404, "No such roadmap")
    target: dict[str, Any] = {"document_id": str(doc)}
    if "key_date" not in body.before:
        raise _error(422, "before.key_date: the key date as you saw it (or null)")
    seen = _clean(body.before["key_date"], "before.key_date")
    if body.op == "add_key_date":
        target["key_date_id"] = str(uuid.uuid4())
        current = None
        after = _checked(body.after, "after")
    else:
        target["key_date_id"] = str(changes._uuid(body.target.get("key_date_id"), "key_date_id"))
        current = await _current(db, principal, doc, target["key_date_id"])
        if current is None:
            raise _error(404, "No such key date on this roadmap")
        if body.op == "edit_key_date":
            given = {k: body.after[k] for k in FIELDS if k in body.after}
            if not given:
                raise _error(422, "after: any of name, date, note")
            after = _checked({**current, **given}, "after")
        else:
            after = None
    if seen != current:
        raise _error(409, {"message": "Changed since you saw it", "current": {"key_date": current},
                           "changed_by": None, "changed_at": None})  # fmt: skip
    w = await drafts.who(db, {doc})
    applies = drafts.can_edit(principal, doc, w)
    session = await changes._session_for_change(db, me, body.session_id, applies, now)
    before, after_ = {"key_date": current}, {"key_date": after}
    c = SimpleChange(
        session_id=session.id if session else None, document_id=doc, op=body.op, target=target,
        before=before, after=after_, status="applied" if applies else "proposed", by=me, at=now,
        reason=body.reason, routed_to=[] if applies else await route(db, doc, w),
    )  # fmt: skip
    if applies:
        await _apply(db, c, after_, session)  # type: ignore[arg-type]
        session.last_change_at = now  # type: ignore[union-attr]
    db.add(c)
    await db.flush()
    await _record(db, principal, c, before=before, after=after_, document_id=str(doc))
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def decide(
    db: AsyncSession, principal: Any, c: SimpleChange, action: str, reason: str | None
) -> SimpleChangeResult:
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
    w = await drafts.who(db, {c.document_id} if c.document_id else set())
    view = type("V", (), {"deciders": w.deciders, "owners": w.owners})
    if not may_decide(principal, c, view):
        raise _error(403, "Only an owner or the roadmap's decider (with none, its owner) "
                          "decides this proposal")  # fmt: skip
    if c.status != "proposed":
        raise _error(409, f"This change is {c.status} already")
    if action == "accept":
        await db.execute(select(Document.id).where(Document.id == c.document_id).with_for_update())
        current = await _current(db, principal, c.document_id, str(c.target["key_date_id"]))  # type: ignore[arg-type]
        if current != c.before.get("key_date"):
            raise _error(409, {"message": "outdated: the key date changed since the proposal",
                               "current": {"key_date": current}, "changed_by": None,
                               "changed_at": None})  # fmt: skip
        session = await changes._session_for_change(db, me, None, True, now)
        await _apply(db, c, c.after, session)  # type: ignore[arg-type]
        session.last_change_at = now  # type: ignore[union-attr]
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = me, now, reason
    await db.flush()
    await _record(db, principal, c, reason=reason)
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def undo(db: AsyncSession, principal: Any, c: SimpleChange) -> SimpleChangeResult:
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
    if c.status != "applied":
        raise _error(409, f"Only an applied change undoes; this one is {c.status}")
    if c.by != me:
        raise _error(403, "Only the person who made a change undoes it")
    if await db.scalar(select(SimpleChange.id).where(SimpleChange.undoes_id == c.id)):
        raise _error(409, "This change is undone already")
    session = (
        await db.get(SimpleSession, c.session_id, with_for_update=True) if c.session_id else None
    )
    if session is None or session.closed_at is not None or changes._idle(session, now):
        raise _error(409, "Its session is closed: undo works only in the change's session")
    await db.execute(select(Document.id).where(Document.id == c.document_id).with_for_update())
    current = await _current(db, principal, c.document_id, str(c.target["key_date_id"]))  # type: ignore[arg-type]
    if current != c.after.get("key_date"):
        raise _error(409, {"message": "Changed since", "current": {"key_date": current},
                           "changed_by": None, "changed_at": None})  # fmt: skip
    u = SimpleChange(
        session_id=c.session_id, document_id=c.document_id, op=c.op, target=c.target,
        before=c.after, after=c.before, status="undone", by=me, at=now, undoes_id=c.id,
        routed_to=[], draft_ids=list(c.draft_ids or []),
    )  # fmt: skip
    await _apply(db, u, c.before, session, undo=True)
    db.add(u)
    session.last_change_at = now
    await db.flush()
    await _record(db, principal, u, undoes_id=str(c.id))
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, u), flags=[])
