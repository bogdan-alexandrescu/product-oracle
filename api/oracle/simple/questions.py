"""prd-questions (the owner's pick, 2026-10-28): a PRD's open questions as real decisions.

**Where they come from**: the PRD's latest approved version: its open questions table
(Code, Question, Recommendation, Alternatives, Blocks, Due, Status) read deterministically
(:func:`parse`); a version with an open questions heading but no table is read by the
``prd_questions`` llm job (:func:`run_job`). Each question is one ``decisions`` row (origin
``prd``), one per PRD and code (``source_id``): a newer approved version that rewords it
updates it, never duplicates it. A question the PRD marks decided arrives decided.

**Who and when**: the decider is the PRD's owner (its track's owner), else the PRD's
decider, else the company's first owner ("Needs input": a decider to name). Due: the day
the PRD gives, else the end of the milestone it blocks when that milestone is the one
running (or the next to run), else that later milestone's start. "Late" past it.

**Ops** (through oracle.simple.changes, the caller's rights): ``decide_question``
(``after`` {option} or {answer}) and ``name_decider`` (``after`` {decider_id}). Owners and
the decider apply (undoable in the change's session); approvers and commenters propose to
the decider; viewers are refused. A question decided in a meeting's session is a meeting
decision (its minutes list it). Oracle's run approvals are never listed here.
"""

import re
import uuid
from datetime import date
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.simple import plan
from oracle.simple.changes import ChangeError
from oracle.simple.models import SimpleChange
from oracle.simple.schemas import (
    SimpleChangeIn,
    SimpleChangeResult,
    SimpleDecisionsWaitingOut,
    SimpleDocRef,
    SimplePersonRef,
    SimpleQuestion,
    SimpleQuestionBlocks,
    SimpleQuestionCan,
    SimpleQuestionFeature,
    SimpleQuestionOption,
    SimpleQuestionPending,
    SimpleQuestionSource,
)

OPS: frozenset[str] = frozenset({"decide_question", "name_decider"})
SOURCE_KIND = "prd_question"
MAX_TEXT = 60_000
ANSWER_MAX = 500
_HEADING = re.compile(r"(?im)^#{1,6}\s*(open questions|open decisions|decisions)\b")
_DECIDED = re.compile(r"(?i)^\s*decided\b(.*)$")
_BY = re.compile(r"(?i)\bby\s+([^:;,]+)")


# --------------------------------------------------------------------------- reading


def _cell(row: list[str], header: list[str], *starts: str) -> str:
    for i, h in enumerate(header):
        if any(h.startswith(s) for s in starts) and i < len(row):
            return row[i].strip()
    return ""


def _blocks(text: str) -> tuple[str | None, list[str]]:
    m = re.search(r"\bM\d{1,2}\b", text or "")
    return (m[0].upper() if m else None), re.findall(r"\b[A-Z]{1,3}-\d{1,3}\b", text or "")


def parse(text: str, ref: date) -> list[dict[str, Any]] | None:
    """The questions table's rows; None when the PRD has no such table."""
    for header, rows in plan.tables(text or ""):
        if not header or not header[0].startswith("code"):
            continue
        if not any(h.startswith(("question", "decision")) for h in header):
            continue
        out = []
        for r in rows:
            code = _cell(r, header, "code").strip()
            title = _cell(r, header, "question", "decision")
            if not code or not title:
                continue
            milestone, features = _blocks(_cell(r, header, "blocks"))
            status = _cell(r, header, "status")
            decided = None
            m = _DECIDED.match(status)
            if m:
                rest = m[1]
                by = _BY.search(rest)
                answer = rest.split(":", 1)[1].strip() if ":" in rest else None
                on = plan.parse_day(rest, ref)
                decided = {"on": on.isoformat() if on else None,
                           "by": by[1].strip() if by else None, "answer": answer}  # fmt: skip
            due = plan.parse_day(_cell(r, header, "due"), ref)
            out.append({
                "code": code, "title": title,
                "recommendation": _cell(r, header, "recommend") or None,
                "alternatives": plan._list(_cell(r, header, "alternative")),
                "milestone": milestone, "features": features,
                "due": due.isoformat() if due else None, "decided": decided,
            })  # fmt: skip
        return out
    return None


def cut(words: str, n: int) -> str:
    """``words`` in at most ``n`` characters, cut at a word ("…" when cut)."""
    words = " ".join(str(words).split())
    if len(words) <= n:
        return words
    head = words[: n - 1]
    return (head.rsplit(" ", 1)[0] if " " in head else head).rstrip(" ,;:-") + "…"


def clean(answer: Any) -> list[dict[str, Any]]:
    """The job's answer held to the questions' shape."""
    raw = answer.get("questions") if isinstance(answer, dict) else None
    out = []
    for q in raw if isinstance(raw, list) else []:
        if not isinstance(q, dict) or not q.get("code") or not q.get("title"):
            continue
        alts = q.get("alternatives") if isinstance(q.get("alternatives"), list) else []
        feats = q.get("features") if isinstance(q.get("features"), list) else []
        decided = q.get("decided") if isinstance(q.get("decided"), dict) else None
        out.append({
            "code": str(q["code"])[:20], "title": cut(q["title"], 200),
            "recommendation": (cut(q["recommendation"], 500) if q.get("recommendation")
                               else None),
            "alternatives": [cut(a, 200) for a in alts if a][:6],
            "milestone": str(q["milestone"]) if q.get("milestone") else None,
            "features": [str(f) for f in feats][:10],
            "due": plan._iso(q.get("due")), "decided": decided,
        })  # fmt: skip
    return out


async def approved(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    return await plan.approved_version(db, document_id)


def payload(document: Document, v: DocumentVersion) -> dict[str, Any]:
    return {
        "title": document.title,
        "approved_on": company_time.day(v.approved_at or company_time.now()).isoformat(),
        "text": (v.markdown or "")[:MAX_TEXT],
    }


def _source(document_id: uuid.UUID, code: str) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"oracle:prd-question:{document_id}:{code.upper()}")


async def _decider(db: AsyncSession, document: Document) -> tuple[uuid.UUID | None, bool]:
    """(the decider, whether the PRD names one): its owner, else its decider, else the
    company's first owner (named: False)."""
    from oracle.simple import one_pager

    w = await one_pager.who(db, document)
    if w.track_owners:
        return next(iter(w.track_owners)), True
    if w.decider is not None:
        return w.decider, True
    return (w.company_owners[0] if w.company_owners else None), False


async def import_answer(db: AsyncSession, document: Document, v: DocumentVersion, rows: Any) -> int:
    """Write the version's questions: one decision per code, updated in place."""
    from oracle.decisions.service import next_number

    if isinstance(rows, dict):
        rows = clean(rows)
    decider, named = await _decider(db, document)
    if decider is None:
        return 0
    now = company_time.now()
    codes = {_source(document.id, q["code"]) for q in rows}
    for q in rows:
        sid = _source(document.id, q["code"])
        d = await db.scalar(
            select(Decision).where(Decision.source_kind == SOURCE_KIND, Decision.source_id == sid)
        )
        options = []
        if q.get("recommendation"):
            options.append({"key": "recommended", "label": q["recommendation"],
                            "recommended": True})  # fmt: skip
        options += [{"key": f"alt{i + 1}", "label": a} for i, a in enumerate(q["alternatives"])]
        info = {"code": q["code"], "document_id": str(document.id), "version_id": str(v.id),
                "version": v.number, "read_at": now.isoformat(),
                "recommendation": q.get("recommendation"), "milestone": q.get("milestone"),
                "features": q.get("features") or [], "due_from_prd": q.get("due"),
                "decider_named": named}  # fmt: skip
        if d is None:
            d = Decision(number=await next_number(db), title=cut(q["title"], 200),
                         question=q["title"],
                         options=options, status="proposed", approver_id=decider,
                         driver="oracle", origin="prd", source_kind=SOURCE_KIND, source_id=sid,
                         subjects=[{"kind": "document", "id": str(document.id),
                                    "ref": document.slug}])  # fmt: skip
            db.add(d)
        else:
            d.title, d.question = cut(q["title"], 200), q["title"]
            if d.status == "proposed":
                d.options = options
            if not (d.prd_question or {}).get("decider_set"):
                d.approver_id = decider
            else:
                info["decider_set"] = True
                info["decider_named"] = True
        d.prd_question = info
        decided = q.get("decided")
        if decided and d.status == "proposed":
            on = date.fromisoformat(decided["on"]) if decided.get("on") else now.date()
            answer = decided.get("answer") or q.get("recommendation") or "Decided in the PRD"
            if not any(o["label"] == answer for o in d.options or []):
                d.options = [*(d.options or []), {"key": "prd", "label": answer}]
            d.chosen_option = next(o["key"] for o in d.options if o["label"] == answer)
            d.status, d.rationale = "decided", "Decided in the PRD"
            d.decided_at = company_time.day_start(on)
            d.decided_by, d.decided_actor = d.approver_id, "user"
            d.review_at = on
            info["decided_by_name"] = decided.get("by")
            d.prd_question = info
    # A question the version no longer has leaves the list (a decided one stays decided).
    for d in await db.scalars(select(Decision).where(Decision.origin == "prd")):
        info = d.prd_question or {}
        if (info.get("document_id") == str(document.id) and d.source_id not in codes
                and d.status == "proposed" and not info.get("removed")):  # fmt: skip
            d.prd_question = {**info, "removed": True, "version_id": str(v.id)}
    await db.flush()
    views = await plan.views(db, {document.id})
    for d in await db.scalars(select(Decision).where(Decision.origin == "prd")):
        info = d.prd_question or {}
        if info.get("document_id") == str(document.id):
            d.due_on = due(info, views.get(document.id))
    await db.flush()
    return len(rows)


def due(info: dict[str, Any], view: plan.View | None) -> date | None:
    """The PRD's day, else the end of the milestone it blocks when that milestone is the one
    running (or the next to run), else that later milestone's start: from the plan as it is
    read now, so a plan read again moves it."""
    if info.get("due_from_prd"):
        return date.fromisoformat(info["due_from_prd"])
    today = company_time.today()
    ms = [m for m in (view.milestones if view else []) if m.start_date and m.end_date]
    current = next((m for m in ms if m.start_date <= today <= m.end_date), None) or next(
        (m for m in sorted(ms, key=lambda m: m.start_date) if m.start_date > today), None
    )
    m = next((m for m in ms if m.code == info.get("milestone")), None)
    if m is None:
        return None
    later = current is not None and m.start_date > current.start_date
    return m.start_date if later else m.end_date


async def _read(db: AsyncSession, v: DocumentVersion) -> bool:
    """Whether this version's questions are read already: a question carries it, or a
    ``prd_questions`` job for it was ever queued (whatever came of it)."""
    from oracle.jobs.models import LlmJob

    if await db.scalar(select(Decision.id).where(
            Decision.origin == "prd",
            Decision.prd_question["version_id"].astext == str(v.id)).limit(1)):  # fmt: skip
        return True
    return bool(await db.scalar(select(LlmJob.id).where(
        LlmJob.kind == "prd_questions", LlmJob.version_id == v.id).limit(1)))  # fmt: skip


async def ensure(db: AsyncSession, document: Document) -> None:
    """Read the latest approved version's questions once (its table, else one job), under
    a per-PRD lock so two reads at once import each question once."""
    from oracle.jobs import service as jobs

    v = await approved(db, document.id)
    if v is None or await _read(db, v):
        return
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                     {"k": f"oracle:prd-questions:{document.id}"})  # fmt: skip
    if await _read(db, v):
        return
    rows = parse(v.markdown or "", (v.approved_at or company_time.now()).date())
    if rows is not None:
        await import_answer(db, document, v, rows)
    elif _HEADING.search(v.markdown or ""):
        try:
            await jobs.enqueue(db, document, "prd_questions", version=v, coalesce=True)
        except jobs.JobError:
            return


async def run_job(s: AsyncSession, job: Any, ask: Any) -> dict[str, Any]:
    """The ``prd_questions`` job: one call with the version's text; the answer becomes the
    PRD's questions unless a newer version is approved meanwhile."""
    from oracle.jobs.kinds import JobInputError

    document = await s.get(Document, job.document_id)
    v = await s.get(DocumentVersion, job.version_id) if job.version_id else None
    if document is None or v is None:
        raise JobInputError("the PRD version no longer exists")
    latest = await approved(s, document.id)
    if latest is None or latest.id != v.id:
        return {"read": False, "reason": "a newer version is approved"}
    n = await import_answer(s, document, v, clean(await ask("prd_questions", payload(document, v))))
    return {"read": True, "questions": n}


# --------------------------------------------------------------------------- the rows


async def _names(db: AsyncSession, ids: set) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {u.id: u.name or u.email for u in await db.scalars(select(User).where(User.id.in_(ids)))}


def _features(info: dict[str, Any], view: plan.View | None) -> list[SimpleQuestionFeature]:
    names: dict[str, str] = {}
    for s in view.slices if view else []:
        names.setdefault(s.feature_code, getattr(s, "feature_name", None) or s.name)
    return [
        SimpleQuestionFeature(code=c, title=names.get(c, c)) for c in info.get("features") or []
    ]


def may_decide(principal: Any, d: Decision) -> bool:
    me = getattr(principal, "user_id", None)
    return principal is not None and (has_role(principal.role, "owner") or me == d.approver_id)


async def rows(
    db: AsyncSession, principal: Any, readable: set[uuid.UUID], only: set[uuid.UUID] | None = None
) -> list[SimpleQuestion]:
    """Every readable PRD's questions: open first, soonest due first; decided after."""
    docs = {d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(readable)))}
    for doc in docs.values():
        await ensure(db, doc)
    ds = [d for d in await db.scalars(select(Decision).where(Decision.origin == "prd"))
          if (d.prd_question or {}).get("document_id")
          and uuid.UUID(d.prd_question["document_id"]) in docs
          and not (d.status == "proposed" and d.prd_question.get("removed"))]  # fmt: skip
    if only is not None:
        ds = [d for d in ds if d.id in only]
    views = await plan.views(db, set(docs))
    pending = {}
    for c in await db.scalars(select(SimpleChange).where(
            SimpleChange.op == "decide_question", SimpleChange.status == "proposed")):  # fmt: skip
        pending.setdefault(c.target.get("decision_id"), c)
    names = await _names(db, {d.approver_id for d in ds} | {d.decided_by for d in ds}
                         | {c.by for c in pending.values()})  # fmt: skip
    # The version each was read from (rows read before "version" was kept look it up).
    vids = {uuid.UUID(v) for d in ds if not (d.prd_question or {}).get("version")
            and (v := (d.prd_question or {}).get("version_id"))}  # fmt: skip
    numbers = {str(i): n for i, n in (await db.execute(select(
        DocumentVersion.id, DocumentVersion.number).where(DocumentVersion.id.in_(vids)))).all()
    } if vids else {}  # fmt: skip
    today = company_time.today()
    me = getattr(principal, "user_id", None)
    out = []
    for d in ds:
        info = d.prd_question or {}
        doc = docs[uuid.UUID(info["document_id"])]
        view = views.get(doc.id)
        if d.status == "proposed" and d.due_on != (when := due(info, view)):
            d.due_on = when
        ms = view.milestone(info.get("milestone")) if view else None
        feats = _features(info, view)
        label = None
        if info.get("milestone") or feats:
            what = ", ".join(f"{f.code} {f.title}" for f in feats)
            label = "Blocks " + ": ".join(x for x in (info.get("milestone"), what) if x)
        open_ = d.status == "proposed"
        late = open_ and d.due_on is not None and d.due_on < today
        due_label = None
        if open_ and d.due_on is not None:
            words = company_time.date_in_words(d.due_on)
            due_label = f"Late · due {words}" if late else f"Due {words}"
        missing = None
        if not info.get("decider_named"):
            missing = "decider"
        elif not info.get("recommendation"):
            missing = "recommendation"
        column = "decided" if not open_ else ("needs_input" if missing else "recommended")
        chosen = next((o["label"] for o in d.options or [] if o["key"] == d.chosen_option), None)
        decided_label = None
        if d.decided_at is not None:
            who = info.get("decided_by_name") or names.get(d.decided_by, "someone")
            where = " in the PRD" if d.rationale == "Decided in the PRD" else ""
            on = company_time.date_in_words(company_time.day(d.decided_at))
            decided_label = f"Decided{where} on {on} by {who}"
        c = pending.get(str(d.id))
        decides = open_ and may_decide(principal, d)
        out.append(SimpleQuestion(
            id=d.id, number=d.number, code=info.get("code", ""), title=d.title,
            status=d.status, column=column,  # type: ignore[arg-type]
            prd=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
            decider=SimplePersonRef(id=d.approver_id, name=names.get(d.approver_id, "someone"))
            if info.get("decider_named") else None,
            missing=missing if open_ else None,  # type: ignore[arg-type]
            due_on=d.due_on, due_label=due_label, late=late,
            blocks=SimpleQuestionBlocks(milestone=info.get("milestone"),
                                        milestone_name=ms.name if ms else None,
                                        features=feats, label=label) if label else None,
            recommendation=info.get("recommendation"),
            alternatives=[SimpleQuestionOption(key=o["key"], label=o["label"])
                          for o in d.options or [] if o["key"].startswith("alt")],
            chosen=chosen, decided_at=d.decided_at,
            decided_by=SimplePersonRef(id=d.decided_by, name=names.get(d.decided_by, "someone"))
            if d.decided_by else None,
            decided_label=decided_label,
            # qa-simple-decide-15: nothing waits on a person whose role cannot decide (a viewer).
            waiting_for_me=open_ and me is not None and me == d.approver_id
            and has_role(principal.role, "approver"),
            pending=SimpleQuestionPending(change_id=c.id, by=SimplePersonRef(
                id=c.by, name=names.get(c.by, "someone")), answer=_answer_of(d, c.after))
            if c is not None and open_ else None,
            can=SimpleQuestionCan(
                decide=decides,
                propose=open_ and not decides and principal is not None
                and has_role(principal.role, "commenter"),
                name_decider=decides,
            ),
            source=SimpleQuestionSource(
                version=info.get("version") or numbers.get(info.get("version_id") or ""),
                read_at=info.get("read_at") or d.created_at),
        ))  # fmt: skip
    far = date.max
    out.sort(key=lambda q: (q.status != "proposed", q.due_on or far, q.number)
             if q.status == "proposed" else (True, date.max, -(q.number)))  # fmt: skip
    return out


def _answer_of(d: Decision, after: dict[str, Any]) -> str:
    if after.get("answer"):
        return str(after["answer"])
    return next((o["label"] for o in d.options or [] if o["key"] == after.get("option")), "")


async def _readable(db: AsyncSession, principal: Any) -> set[uuid.UUID]:
    from oracle.simple import meetings

    docs = await db.scalars(
        select(Document).where(Document.kind == "prd", Document.deleted_at.is_(None))
    )
    return {d.id for d in docs if await meetings._readable(db, principal, d)}


async def _approvals(db: AsyncSession, principal: Any) -> list[Decision]:
    """Oracle's run approvals waiting for this person, newest first."""
    me = getattr(principal, "user_id", None)
    if me is None:
        return []
    return list(await db.scalars(select(Decision).where(
        Decision.origin == "checkpoint", Decision.status == "proposed",
        Decision.approver_id == me).order_by(Decision.number.desc())))  # fmt: skip


async def waiting(db: AsyncSession, principal: Any) -> SimpleDecisionsWaitingOut:
    qs = [q for q in await rows(db, principal, await _readable(db, principal)) if q.waiting_for_me]
    me = getattr(principal, "user_id", None)
    others = 0
    if me is not None:
        others = len(list(await db.scalars(select(Decision.id).where(
            Decision.status == "proposed", Decision.approver_id == me,
            Decision.origin.not_in(("prd", "checkpoint"))))))  # fmt: skip
    return SimpleDecisionsWaitingOut(
        count=len(qs) + others,
        late=sum(q.late for q in qs),
        questions=qs,
        others=others,
        approvals_waiting=len(await _approvals(db, principal)),
    )


async def page_fields(
    db: AsyncSession, principal: Any, readable: set[uuid.UUID], only: set[uuid.UUID] | None = None
) -> dict:
    """The Decisions page's questions: of these PRDs (the page's PRD and goal filters), and
    of ``only`` these decisions when the page shows one meeting."""
    from oracle.preferences.models import UserPreference

    qs = await rows(db, principal, readable, only)
    view = None
    if principal is not None:
        view = await db.scalar(select(UserPreference.value).where(
            UserPreference.principal_id == principal.id,
            UserPreference.key == "simple_decisions_view"))  # fmt: skip
    mine = [q for q in qs if q.waiting_for_me]
    approvals = await _approvals(db, principal)
    return {"questions": qs, "waiting_count": len(mine), "late_count": sum(q.late for q in mine),
            "approvals_waiting": len(approvals),
            "approvals_example": f"D-{approvals[0].number} {approvals[0].title}"
            if approvals else None,
            "view": view if view in ("list", "board", "meetings") else "list"}  # fmt: skip


async def due_for(
    db: AsyncSession,
    principal: Any,
    document_id: uuid.UUID,
    meeting_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
) -> list[SimpleQuestion]:
    """A review meeting's agenda ("Decisions due"): its PRD's open questions that block the
    milestone the soonest one blocks (all of them when none names one), and the questions
    decided in this meeting, which stay on it; soonest first. With the live meeting's
    ``session_id``, a question I decided in it carries that change for its Undo."""
    from oracle.simple.models import SimpleMeetingDecision as MeetingDecisionRow

    qs = await rows(db, principal, {document_id})
    open_ = [q for q in qs if q.status == "proposed"]
    here: set[uuid.UUID] = set()
    if meeting_id is not None:
        here = set(await db.scalars(select(MeetingDecisionRow.decision_id).where(
            MeetingDecisionRow.meeting_id == meeting_id)))  # fmt: skip
    done = [q for q in qs if q.status == "decided" and q.id in here]
    first = next((q for q in open_ if q.blocks and q.blocks.milestone), None)
    ms = first.blocks.milestone if first and first.blocks else None
    agenda = [q for q in open_ if ms is None or (q.blocks and q.blocks.milestone == ms)]
    me = getattr(principal, "user_id", None)
    if done and session_id is not None and me is not None:
        made = list(await db.scalars(select(SimpleChange).where(
            SimpleChange.session_id == session_id, SimpleChange.op == "decide_question",
            SimpleChange.status == "applied", SimpleChange.by == me)
            .order_by(SimpleChange.at.desc())))  # fmt: skip
        undone = set(await db.scalars(select(SimpleChange.undoes_id).where(
            SimpleChange.undoes_id.in_([c.id for c in made])))) if made else set()  # fmt: skip
        for q in done:
            q.undo_id = next((c.id for c in made if c.id not in undone
                              and c.target.get("decision_id") == str(q.id)), None)  # fmt: skip
    return sorted([*agenda, *done], key=lambda q: (q.due_on or date.max, q.number))


# --------------------------------------------------------------------------- the ops


async def _decision(db: AsyncSession, target: dict[str, Any]) -> Decision:
    try:
        did = uuid.UUID(str(target.get("decision_id")))
    except ValueError as e:
        raise ChangeError(422, "target.decision_id: the question") from e
    d = await db.get(Decision, did, with_for_update=True, populate_existing=True)
    if d is None or d.origin != "prd":
        raise ChangeError(404, "No such question")
    return d


def _state(d: Decision) -> dict[str, Any]:
    info = d.prd_question or {}
    return {"status": d.status, "chosen_option": d.chosen_option,
            "decider_id": str(d.approver_id), "decider_named": bool(info.get("decider_named")),
            "decider_set": bool(info.get("decider_set"))}  # fmt: skip


async def _write(db: AsyncSession, principal: Any, d: Decision, op: str, after: dict,
                 session_id: uuid.UUID | None) -> None:  # fmt: skip
    me = getattr(principal, "user_id", None)
    if op == "name_decider":
        d.approver_id = uuid.UUID(after["decider_id"])
        d.prd_question = {**(d.prd_question or {}), "decider_named": True, "decider_set": True}
        return
    if after.get("status") == "proposed":  # an undo
        d.status, d.chosen_option, d.rationale = "proposed", None, None
        d.decided_at = d.decided_by = d.decided_actor = d.review_at = None
        return
    key = after.get("option")
    if after.get("answer"):
        key = f"other{len(d.options or []) + 1}"
        d.options = [*(d.options or []), {"key": key, "label": after["answer"]}]
    d.status, d.chosen_option, d.rationale = "decided", key, "Decided in Simple"
    d.decided_at, d.decided_by, d.decided_actor = company_time.now(), me, "user"
    d.review_at = company_time.today()
    if session_id is not None:
        from oracle.simple import meetings
        from oracle.simple.models import SimpleMeeting
        from oracle.simple.models import SimpleMeetingDecision as MeetingDecisionRow

        m = await db.scalar(select(SimpleMeeting).where(SimpleMeeting.session_id == session_id))
        if m is not None and m.status != "ended":
            db.add(MeetingDecisionRow(meeting_id=m.id, decision_id=d.id, change_ids=[],
                                      at=company_time.now()))  # fmt: skip
            _ = meetings


async def create(db: AsyncSession, principal: Any, body: SimpleChangeIn) -> SimpleChangeResult:
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
    if not has_role(principal.role, "commenter"):
        raise ChangeError(403, "Viewers read decisions; they do not change them")
    d = await _decision(db, body.target)
    if d.status != "proposed" and body.op == "decide_question":
        raise ChangeError(409, "This question is decided already")
    a = body.after
    if body.op == "decide_question":
        answer = " ".join(str(a.get("answer") or "").split())
        if answer:
            if len(answer) > ANSWER_MAX:
                raise ChangeError(422, f"after.answer: at most {ANSWER_MAX} characters")
            after: dict[str, Any] = {"answer": answer}
        elif any(o["key"] == a.get("option") for o in d.options or []):
            after = {"option": a["option"]}
        else:
            raise ChangeError(422, "after.option: one of the question's answers")
    else:
        try:
            uid = uuid.UUID(str(a.get("decider_id")))
        except ValueError as e:
            raise ChangeError(422, "after.decider_id: a member") from e
        if not await db.scalar(select(User.id).where(User.id == uid, User.disabled_at.is_(None))):
            raise ChangeError(422, "after.decider_id: a member of this company")
        after = {"decider_id": str(uid)}
    before = _state(d)
    if body.op == "decide_question" and body.before.get("status") not in (None, d.status):
        raise ChangeError(409, {"message": "Changed since you saw it", "current": before})
    applies = may_decide(principal, d)
    session = await changes._session_for_change(db, me, body.session_id, applies, now)
    doc_id = uuid.UUID(d.prd_question["document_id"])
    c = SimpleChange(session_id=session.id if session else None, document_id=doc_id,
                     op=body.op, target={"decision_id": str(d.id)}, before=before, after=after,
                     status="applied" if applies else "proposed", by=me, at=now,
                     reason=body.reason, routed_to=[] if applies else [d.approver_id])  # fmt: skip
    if applies:
        await _write(db, principal, d, body.op, after, body.session_id)
        session.last_change_at = now  # type: ignore[union-attr]
    db.add(c)
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "after": after})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def decide(
    db: AsyncSession,
    principal: Any,
    c: SimpleChange,
    action: str,
    reason: str | None,
    session_id: uuid.UUID | None = None,
) -> SimpleChangeResult:
    from oracle.simple import changes

    d = await _decision(db, c.target)
    if not may_decide(principal, d):
        raise ChangeError(403, "Only an owner or the question's decider decides proposals")
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept":
        if c.op == "decide_question" and d.status != "proposed":
            raise ChangeError(409, "outdated: the question is decided already")
        await _write(db, principal, d, c.op, c.after, session_id)
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = (
        changes._me(principal),
        company_time.now(),
        reason,
    )
    await db.flush()
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def undo(db: AsyncSession, principal: Any, c: SimpleChange) -> SimpleChangeResult:
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
    if c.op == "name_decider":
        d.approver_id = uuid.UUID(c.before["decider_id"])
        d.prd_question = {**(d.prd_question or {}),
                          "decider_named": c.before.get("decider_named", True),
                          "decider_set": c.before.get("decider_set", False)}  # fmt: skip
    else:
        await _write(db, principal, d, c.op, {"status": "proposed"}, None)
        from oracle.simple.models import SimpleMeetingDecision as MeetingDecisionRow

        for link in await db.scalars(select(MeetingDecisionRow).where(
                MeetingDecisionRow.decision_id == d.id)):  # fmt: skip
            await db.delete(link)
    u = SimpleChange(session_id=c.session_id, document_id=c.document_id, op=c.op,
                     target=c.target, before=c.after, after=c.before, status="undone", by=me,
                     at=now, undoes_id=c.id, routed_to=[])  # fmt: skip
    db.add(u)
    session.last_change_at = now
    await db.flush()
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, u), flags=[])


def may_decide_change(principal: Any, c: SimpleChange, decisions: dict) -> bool:
    d = decisions.get(c.target.get("decision_id"))
    return d is not None and may_decide(principal, d)
