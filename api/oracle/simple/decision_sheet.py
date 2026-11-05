"""edit-decisions (the owner's picks, BGD Nov 5: ec1 b "Decision sheet", eq2 b "Question
sheet"): an open decision and a PRD's open question are changed from Simple's sheet.

**Ops** (``POST /v1/simple/changes``, through oracle.simple.changes):

- ``edit_decision`` (``target.decision_id``; ``after`` any of title, question, context,
  options (labels, at most six) and review_at): an open decision's fields, as Detailed's
  inspector edits them.
- ``edit_question`` (``after`` any of title, recommendation, alternatives): a PRD's open
  question's text, its PRD's recommendation and its other answers. A PRD read again keeps
  them (oracle.simple.questions.import_answer).
- ``withdraw_decision``: either one withdrawn, the "not now": it stays in the history, with
  Undo in the change's session.
- ``add_question`` (``target.document_id``; ``after`` title, recommendation,
  alternatives): a question added to the PRD (the next code, "Q17"), with no decider named.

Who: a decision's creator, its decider or an owner (a question's decider or an owner; the
PRD's decider or an owner for ``add_question``) applies at once; another commenter or
approver proposes the edit or the new question to that decider; viewers are refused. Only
who may apply withdraws.

**Trash**: ``DELETE /v1/simple/decisions/{id}`` sends an open decision (kind ``decision``)
or question (kind ``question``) to Settings › Trash, by who may withdraw it. Nothing that
names it is rewritten (its meeting, subjects, the decisions it supersedes), so Restore
(``POST .../restore``, or Trash's own; an owner or whoever deleted it) puts it back with
every link; while it is in Trash every read leaves it out (oracle.trash.filter), and a PRD
read again does not bring it back.
"""

import uuid
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.deps import TenantDB, same_origin
from oracle.authz import has_role
from oracle.decisions import service as decisions
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.simple import questions
from oracle.simple.changes import ChangeError
from oracle.simple.models import SimpleChange
from oracle.simple.router import Commenter
from oracle.simple.schemas import SimpleChangeIn, SimpleChangeResult, SimpleDecisionCan
from oracle.simple.trash_items import ALL, Reason, TrashedOut
from oracle.trash import service as trash
from oracle.trash.models import RETENTION_DAYS, TrashEntry
from oracle.trash.schemas import TrashEntryOut

OPS: frozenset[str] = frozenset({"edit_decision", "edit_question", "withdraw_decision",
                                 "add_question"})  # fmt: skip
EDITS = ("edit_decision", "edit_question")
MAX_OPTIONS = 6
RETENTION = timedelta(days=RETENTION_DAYS)
LIMITS = {"title": 200, "question": 1000, "context": 4000, "recommendation": 500}

router = APIRouter(prefix="/v1/simple", tags=["simple"], dependencies=[Depends(same_origin)])


def is_question(d: Decision) -> bool:
    return d.origin == "prd"


def kind_of(d: Decision) -> str:
    return "question" if is_question(d) else "decision"


def code_of(d: Decision) -> str:
    return (d.prd_question or {}).get("code") or "" if is_question(d) else decisions.ref(d.number)


def name_of(d: Decision) -> str:
    return f"{code_of(d)} {d.title}".strip()


def may_change(principal: Any, d: Decision) -> bool:
    """Applies a change at once (and withdraws, deletes): an open question's decider or an
    owner; an open decision's creator, decider or an owner. Never a run's own approval."""
    if principal is None or getattr(principal, "is_run", False) or d.status != "proposed":
        return False
    if is_question(d):
        return questions.may_decide(principal, d)
    if d.origin == "checkpoint":
        return False
    return decisions._editor(principal, d)


def can(principal: Any, d: Decision) -> SimpleDecisionCan:
    """The sheet's buttons for this reader (decided ones stay as they are)."""
    if principal is None or d.status != "proposed" or d.origin == "checkpoint":
        return SimpleDecisionCan()
    change = may_change(principal, d)
    return SimpleDecisionCan(
        edit=change,
        propose=not change and has_role(principal.role, "commenter"),
        withdraw=change,
        delete=change,
        reassign=not is_question(d) and has_role(principal.role, "owner"),
    )


async def edits(db: AsyncSession, ids: set[uuid.UUID]) -> dict[str, tuple[datetime, uuid.UUID]]:
    """The last edit made from the sheet to each of ``ids`` (and not undone): when, by whom."""
    if not ids:
        return {}
    rows = list(await db.scalars(
        select(SimpleChange).where(
            SimpleChange.op.in_(EDITS), SimpleChange.status.in_(("applied", "accepted")),
            SimpleChange.target["decision_id"].astext.in_([str(i) for i in ids]))
        .order_by(SimpleChange.seq)))  # fmt: skip
    if not rows:
        return {}
    undone = set(await db.scalars(select(SimpleChange.undoes_id).where(
        SimpleChange.undoes_id.in_([c.id for c in rows]))))  # fmt: skip
    out: dict[str, tuple[datetime, uuid.UUID]] = {}
    for c in rows:
        if c.id not in undone:
            out[str(c.target["decision_id"])] = (c.decided_at or c.at, c.by)
    return out


# --------------------------------------------------------------------------- the fields


def _text(value: Any, name: str, *, required: bool = False) -> str | None:
    words = " ".join(str(value or "").split()) if name in ("title", "recommendation") else (
        str(value or "").strip())  # fmt: skip
    if required and not words:
        raise ChangeError(422, f"after.{name}: it cannot be empty")
    if len(words) > LIMITS[name]:
        raise ChangeError(422, f"after.{name}: at most {LIMITS[name]} characters")
    return words or None


def _labels(value: Any, name: str) -> list[str]:
    if not isinstance(value, list):
        raise ChangeError(422, f"after.{name}: a list of answers")
    labels = [" ".join(str(v or "").split()) for v in value]
    labels = [label for label in labels if label]
    if len(labels) > MAX_OPTIONS:
        raise ChangeError(422, f"after.{name}: at most {MAX_OPTIONS}")
    if len({label.lower() for label in labels}) != len(labels):
        raise ChangeError(422, f"after.{name}: each answer once")
    if any(len(label) > 200 for label in labels):
        raise ChangeError(422, f"after.{name}: at most 200 characters each")
    return labels


def fields(d: Decision) -> dict[str, Any]:
    """The fields the sheet changes, as they are now."""
    if is_question(d):
        return {"title": d.title,
                "recommendation": (d.prd_question or {}).get("recommendation"),
                "alternatives": [o["label"] for o in d.options or []
                                 if str(o.get("key", "")).startswith("alt")]}  # fmt: skip
    return {"title": d.title, "question": d.question, "context": d.context,
            "options": [o.get("label") for o in d.options or []],
            "review_at": d.review_at.isoformat() if d.review_at else None}  # fmt: skip


async def _clean(db: AsyncSession, op: str, after: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if op == "edit_question" or op == "add_question":
        if "title" in after or op == "add_question":
            out["title"] = _text(after.get("title"), "title", required=True)
        if "recommendation" in after:
            out["recommendation"] = _text(after.get("recommendation"), "recommendation")
        if "alternatives" in after:
            out["alternatives"] = _labels(after["alternatives"], "alternatives")
        return out
    if "title" in after:
        out["title"] = _text(after.get("title"), "title", required=True)
    for name in ("question", "context"):
        if name in after:
            out[name] = _text(after.get(name), name)
    if "options" in after:
        out["options"] = _labels(after["options"], "options")
    if "review_at" in after:
        day = after.get("review_at")
        if day:
            try:
                when = decisions.check_review_at(date.fromisoformat(str(day)),
                                                 await decisions.company_today(db))  # fmt: skip
            except ValueError as e:
                raise ChangeError(422, "after.review_at: a day") from e
            except decisions.DecisionError as e:
                raise ChangeError(422, f"after.review_at: {e}") from e
            out["review_at"] = when.isoformat()
        else:
            out["review_at"] = None
    return out


def _options(old: list[dict[str, Any]], labels: list[str]) -> list[dict[str, Any]]:
    """The decision's options as these labels: one kept (with its pros, cons, evidence)
    where its label stays; new ones keyed after the others."""
    by_label = {str(o.get("label")): o for o in old}
    used = {str(o.get("key")) for o in old}
    out, n = [], 0
    for label in labels:
        if label in by_label:
            out.append(by_label[label])
            continue
        n += 1
        while f"o{n}" in used:
            n += 1
        used.add(f"o{n}")
        out.append({"key": f"o{n}", "label": label})
    return out


def _question_options(recommendation: str | None, alternatives: list[str]) -> list[dict]:
    out: list[dict[str, Any]] = []
    if recommendation:
        out.append({"key": "recommended", "label": recommendation, "recommended": True})
    return out + [{"key": f"alt{i + 1}", "label": a} for i, a in enumerate(alternatives)]


def _write(d: Decision, op: str, values: dict[str, Any], by: uuid.UUID | None) -> None:
    if op == "withdraw_decision" or "status" in values:
        d.status = values["status"]
        return
    if is_question(d):
        info = {**(d.prd_question or {}), "edited": True}
        if "title" in values:
            d.title, d.question = questions.cut(values["title"], 200), values["title"]
        if "recommendation" in values:
            info["recommendation"] = values["recommendation"]
        now = fields(d)
        rec = values.get("recommendation", info.get("recommendation"))
        alts = values.get("alternatives", now["alternatives"])
        if "recommendation" in values or "alternatives" in values:
            d.options = _question_options(rec, alts)
        d.prd_question = info
        return
    if "title" in values:
        d.title = values["title"]
    if "question" in values:
        d.question = values["question"]
    if "context" in values:
        d.context = values["context"]
    if "options" in values:
        d.options = _options(list(d.options or []), values["options"])
    if "review_at" in values:
        d.review_at = date.fromisoformat(values["review_at"]) if values["review_at"] else None


# --------------------------------------------------------------------------- the ops


async def _decision(db: AsyncSession, target: dict[str, Any]) -> Decision:
    try:
        did = uuid.UUID(str(target.get("decision_id")))
    except ValueError as e:
        raise ChangeError(422, "target.decision_id: the decision") from e
    d = await db.get(Decision, did, with_for_update=True, populate_existing=True)
    if d is None or d.origin == "checkpoint":
        raise ChangeError(404, "No such decision")
    return d


def _document_id(d: Decision) -> uuid.UUID | None:
    doc = (d.prd_question or {}).get("document_id") if is_question(d) else None
    return uuid.UUID(doc) if doc else None


async def create(db: AsyncSession, principal: Any, body: SimpleChangeIn) -> SimpleChangeResult:
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
    if not has_role(principal.role, "commenter"):
        raise ChangeError(403, "Viewers read decisions; they do not change them")
    if body.op == "add_question":
        return await _ask(db, principal, body, me, now)
    d = await _decision(db, body.target)
    if (body.op == "edit_question") != is_question(d) and body.op in EDITS:
        raise ChangeError(422, "edit_question changes a PRD's question; edit_decision the rest")
    if d.status != "proposed":
        raise ChangeError(409, f"{name_of(d)} is {d.status}; only an open one is changed")
    applies = may_change(principal, d)
    if body.op == "withdraw_decision":
        if not applies:
            raise ChangeError(403, "Only its decider, whoever made it or an owner withdraws it")
        before, after = {"status": "proposed"}, {"status": "withdrawn"}
    else:
        after = await _clean(db, body.op, body.after or {})
        now_ = fields(d)
        before = {k: now_[k] for k in after}
        if not after or before == after:
            raise ChangeError(422, "Nothing changed")
    session = await changes._session_for_change(db, me, body.session_id, applies, now)
    c = SimpleChange(session_id=session.id if session else None, document_id=_document_id(d),
                     op=body.op, target={"decision_id": str(d.id), "name": name_of(d)},
                     before=before, after=after, status="applied" if applies else "proposed",
                     by=me, at=now, reason=body.reason,
                     routed_to=[] if applies else [d.approver_id])  # fmt: skip
    if applies:
        _write(d, body.op, after, me)
        session.last_change_at = now  # type: ignore[union-attr]
    db.add(c)
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "after": after})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def _prd(db: AsyncSession, principal: Any, target: dict[str, Any]) -> Document:
    from oracle.simple import meetings

    try:
        doc_id = uuid.UUID(str(target.get("document_id")))
    except ValueError as e:
        raise ChangeError(422, "target.document_id: the PRD") from e
    doc = await db.get(Document, doc_id)
    if doc is None or doc.kind != "prd" or not await meetings._readable(db, principal, doc):
        raise ChangeError(404, "No such PRD")
    return doc


async def _ask(
    db: AsyncSession, principal: Any, body: SimpleChangeIn, me: uuid.UUID, now: datetime
) -> SimpleChangeResult:
    """A question added to the PRD: by an owner or the PRD's decider at once, else proposed
    to that decider (with none, left open for an owner: never its proposer's own to accept)."""
    from oracle.simple import changes

    doc = await _prd(db, principal, body.target)
    after = await _clean(db, "add_question", body.after or {})
    decider, _ = await questions._decider(db, doc)
    applies = has_role(principal.role, "owner") or (decider is not None and decider == me)
    session = await changes._session_for_change(db, me, body.session_id, applies, now)
    target = {"document_id": str(doc.id), "name": doc.title}
    c = SimpleChange(session_id=session.id if session else None, document_id=doc.id,
                     op="add_question", target=target, before={}, after=after,
                     status="applied" if applies else "proposed", by=me, at=now,
                     reason=body.reason,
                     routed_to=[] if applies or decider is None else [decider])  # fmt: skip
    if applies:
        d = await add_question(db, doc, after, decider or me, me)
        c.target = {**target, "decision_id": str(d.id)}
        session.last_change_at = now  # type: ignore[union-attr]
    db.add(c)
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "after": after})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def add_question(
    db: AsyncSession, doc: Document, after: dict[str, Any], decider: uuid.UUID, by: uuid.UUID
) -> Decision:
    """The PRD's next question ("Q17" after Q16, counting those in Trash), no decider named
    yet, kept when the PRD is read again."""
    prd = Decision.prd_question["document_id"].astext == str(doc.id)
    stmt = select(Decision.prd_question["code"].astext).where(Decision.origin == "prd", prd)
    codes = await db.scalars(stmt.execution_options(**ALL))
    n = max((int(c[1:]) for c in codes if c and c[:1].upper() == "Q" and c[1:].isdigit()),
            default=0) + 1  # fmt: skip
    code = f"Q{n}"
    v = await questions.approved(db, doc.id)
    now = company_time.now()
    d = Decision(
        number=await decisions.next_number(db), title=questions.cut(after["title"], 200),
        question=after["title"],
        options=_question_options(after.get("recommendation"), after.get("alternatives") or []),
        status="proposed", approver_id=decider, driver=f"user:{by}", origin="prd",
        source_kind=questions.SOURCE_KIND, source_id=questions._source(doc.id, code),
        subjects=[{"kind": "document", "id": str(doc.id), "ref": doc.slug}], created_by=by,
        prd_question={"code": code, "document_id": str(doc.id),
                      "version_id": str(v.id) if v else None, "version": v.number if v else None,
                      "read_at": now.isoformat(), "recommendation": after.get("recommendation"),
                      "milestone": None, "features": [], "due_from_prd": None,
                      "decider_named": False, "added": True},
    )  # fmt: skip
    db.add(d)
    await db.flush()
    return d


def may_decide_change(principal: Any, c: SimpleChange, found: dict) -> bool:
    if principal is None:
        return False
    if has_role(principal.role, "owner"):
        return True
    me = getattr(principal, "user_id", None)
    if c.op == "add_question":
        return me is not None and me != c.by and me in (c.routed_to or [])
    d = found.get(str(c.target.get("decision_id")))
    return d is not None and me == d.approver_id


async def decide(
    db: AsyncSession, principal: Any, c: SimpleChange, action: str, reason: str | None
) -> SimpleChangeResult:
    """Accept (applied as asked, unless the decision is no longer open or changed since) or
    decline, by the decider or an owner."""
    from oracle.simple import changes

    me = changes._me(principal)
    d = None
    if c.op != "add_question":
        d = await _decision(db, c.target)
    if not may_decide_change(principal, c, {str(d.id): d} if d is not None else {}):
        raise ChangeError(403, "Only an owner or its decider decides this proposal")
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept":
        if c.op == "add_question":
            doc = await _prd(db, principal, c.target)
            q = await add_question(db, doc, c.after, (c.routed_to or [me])[0], c.by)
            c.target = {**c.target, "decision_id": str(q.id)}
        else:
            assert d is not None
            if d.status != "proposed":
                raise ChangeError(409, f"outdated: {name_of(d)} is {d.status}")
            now_ = fields(d)
            current = {k: now_[k] for k in c.after}
            if c.op in EDITS and current != {k: c.before.get(k) for k in c.after}:
                raise ChangeError(409, {"message": "outdated: changed since it was proposed",
                                        "current": current})  # fmt: skip
            _write(d, c.op, c.after, c.by)
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = me, company_time.now(), reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def undo(db: AsyncSession, principal: Any, c: SimpleChange) -> SimpleChangeResult:
    """Undo, in the change's session, by who made it: the fields as they were, a withdrawn
    one open again, an added question withdrawn."""
    from oracle.simple import changes
    from oracle.simple.models import SimpleSession

    me, now = changes._me(principal), company_time.now()
    if c.status != "applied":
        raise ChangeError(409, f"Only an applied change undoes; this one is {c.status}")
    if c.by != me:
        raise ChangeError(403, "Only the person who made a change undoes it")
    if await db.scalar(select(SimpleChange.id).where(SimpleChange.undoes_id == c.id)):
        raise ChangeError(409, "This change is undone already")
    session = await db.get(SimpleSession, c.session_id) if c.session_id else None
    if session is None or session.closed_at is not None or changes._idle(session, now):
        raise ChangeError(409, "Its session is closed: undo works only in the change's session")
    d = await _decision(db, c.target)
    if c.op == "add_question":
        back, current = {"status": "withdrawn"}, {"status": d.status}
        if d.status != "proposed":
            raise ChangeError(409, f"{name_of(d)} is {d.status} now")
    elif c.op == "withdraw_decision":
        back, current = {"status": "proposed"}, {"status": d.status}
        if d.status != "withdrawn":
            raise ChangeError(409, f"{name_of(d)} is {d.status} now")
    else:
        now_ = fields(d)
        current = {k: now_[k] for k in c.after}
        if current != c.after or d.status != "proposed":
            raise ChangeError(409, {"message": "Changed since", "current": current})
        back = c.before
    _write(d, "withdraw_decision" if "status" in back else c.op, back, me)
    u = SimpleChange(session_id=c.session_id, document_id=c.document_id, op=c.op,
                     target=c.target, before=current, after=back, status="undone", by=me,
                     at=now, undoes_id=c.id, routed_to=[])  # fmt: skip
    db.add(u)
    session.last_change_at = now
    await db.flush()
    await audit.record(db, principal, "simple_change.undone", "simple_change", u.id,
                       data={"op": c.op, "target": c.target, "undoes_id": str(c.id)})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, u), flags=[])


# --------------------------------------------------------------------------- Trash


def describe(d: Decision) -> dict[str, Any]:
    kind = kind_of(d)
    root: dict[str, Any] = {"type": kind, "id": str(d.id), "slug": None, "title": d.title,
                            "kind": kind, "code": code_of(d) or None}  # fmt: skip
    if is_question(d):
        root["document_id"] = (d.prd_question or {}).get("document_id")
    return root


async def trash_decision(
    db: AsyncSession, principal: Any, d: Decision, reason: str | None
) -> TrashEntry:
    """Move it to Trash; nothing that names it is rewritten, so Restore puts every link
    back as it was."""
    at = trash.now()
    entry = TrashEntry(id=uuid.uuid4(), root_type=kind_of(d), root_id=d.id, root=describe(d),
                       items=[], deleted_by=principal.id,
                       deleted_by_name=await trash._actor_name(db, principal), reason=reason,
                       published=False, purge_after=at + RETENTION)  # fmt: skip
    entry.created_at = at
    db.add(entry)
    await db.flush()
    d.deleted_at, d.deleted_by, d.deleted_reason = at, principal.id, reason
    d.trash_entry_id = entry.id
    await audit.record(db, principal, "trash.delete", entry.root_type, d.id,
                       {"entry_id": str(entry.id), "root": entry.root, "items": [],
                        "reason": reason})  # fmt: skip
    await db.flush()
    return entry


@router.delete("/decisions/{decision_id}", response_model=TrashedOut,
               name="delete_simple_decision")  # fmt: skip
async def delete_decision(
    decision_id: uuid.UUID, db: TenantDB, principal: Commenter, reason: Reason = None
) -> TrashedOut:
    """Move an open decision or PRD question to Trash (30 days, then deleted for good): who
    may withdraw it (its decider, whoever made it, an owner); others are refused."""
    from oracle.simple.trash_items import _entry_out

    d = await db.get(Decision, decision_id, with_for_update=True)
    if d is None or d.origin == "checkpoint":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such decision")
    if d.status != "proposed":
        what = f"{name_of(d)} is {d.status}; only an open one goes to Trash"
        raise HTTPException(status.HTTP_409_CONFLICT, what)
    if not may_change(principal, d):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Only its decider, whoever made it or an owner deletes it")  # fmt: skip
    entry = await trash_decision(db, principal, d, reason)
    out = TrashedOut(entry=_entry_out(entry), can_restore=trash.may_restore(principal, entry))
    await db.commit()
    return out


@router.post("/decisions/{decision_id}/restore", response_model=TrashEntryOut,
             name="restore_simple_decision")  # fmt: skip
async def restore_decision(
    decision_id: uuid.UUID, db: TenantDB, principal: Commenter
) -> TrashEntryOut:
    """Put the decision or question back from Trash with every link: an owner, or whoever
    deleted it."""
    from oracle.simple.trash_items import _restore

    origin = await db.scalar(select(Decision.origin).where(Decision.id == decision_id)
                             .execution_options(**ALL))  # fmt: skip
    if origin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such decision in Trash")
    return await _restore(db, principal, "question" if origin == "prd" else "decision",
                          decision_id)  # fmt: skip
