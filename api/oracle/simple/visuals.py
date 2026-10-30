"""Simple S10 (#723, D26): visual proposals. A proposal that adds or changes a product
flow, a user flow or a feature carries a visual: a user-flow diagram (its steps and
decision points, the feature that enables each step, the goal it serves, what changes
versus today) and, when it touches a screen, a low-fi wireframe of that screen; numbered
annotations tie each part to the PRD section and requirement it rests on.

A visual is held against its subject (``subject_kind``, ``subject_id``): one of
:data:`SUBJECT_KINDS`. Oracle draws it WITH the proposal (:func:`request_visual`, the
``simple_visual`` llm job, budgeted and switched like Oracle's other jobs) and redraws it
as a new version when someone presses Revise after comments (:func:`revise`). The card
shows the newest version (:func:`flow_for`, the ``SimpleFlow`` train T serves), the
versions stay readable.

The format and the checks are Oracle's design format's (oracle.specs.design): the flow is
SVG and the wireframe low-fi HTML, both rebuilt by the allowlist sanitisers
(oracle.specs.sanitize); anything that would run or fetch refuses the whole answer;
annotations must point at an element of the drawing and at the PRD's sections. Oracle
draws the SVG and the wireframe itself from the answer's steps and regions when the
answer brings none.

Who: viewers read (a visual of a document they cannot see is not there); commenters and up
comment; who changes the subject's document directly (an owner, its decider, with none its
track owner: oracle.simple.drafts.can_edit; with no document, the company's owners) asks
for a drawing and revises. A change's visual is read by whoever may read the change; a
one-pager bet's by who reads that bet on the page (a working draft's bet: who sees the draft).
"""

import html
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.jobs.models import LlmJob
from oracle.simple.models import (
    VISUAL_SUBJECT_KINDS,
    SimpleChange,
    SimpleVisual,
    SimpleVisualComment,
    SimpleVisualVersion,
)
from oracle.simple.schemas import (
    OnePagerFlow,
    SimpleFlow,
    SimpleFlowNote,
    SimpleFlowScreen,
    SimpleFlowStep,
    SimpleVisualCommentOut,
    SimpleVisualOut,
    SimpleVisualVersionOut,
)
from oracle.specs.sanitize import MAX_FILE_BYTES, sanitize_svg, sanitize_wireframe

SUBJECT_KINDS = VISUAL_SUBJECT_KINDS
JOB_KIND = "simple_visual"
MAX_STEPS = 12
MAX_REGIONS = 10
MAX_NOTES = 20
LABEL_MAX = 80
ACTOR_MAX = 24
NOTE_MAX = 400
BRIEF_MAX = 2000
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
# The ops whose proposals add or change a feature or a flow (they come with a visual).
FEATURE_OPS = ("confirm_item", "edit_outcome")
# Subjects Simple cannot look up (other lanes'): drawn with their proposal through
# request_visual, never asked for by id over /request. A one-pager line is asked for with
# its PRD (``document_id``): its subject is a bet of the page as the caller reads it.
LOOSE_KINDS = ("suggestion", "chat_card")
UNASKABLE_KINDS = LOOSE_KINDS


class VisualError(Exception):
    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail
        super().__init__(detail)


def _me(principal: Any) -> uuid.UUID | None:
    if principal is None or getattr(principal, "run_id", None) is not None:
        return None
    return getattr(principal, "user_id", None)


def line_subject(document_id: uuid.UUID, key: str) -> uuid.UUID:
    """A one-pager bet's subject id: its PRD and the bet's key (``bet_key``), never its
    words: a bet keeps its drawn flow when its words change (qa-simple-prd-1, "Carry the
    flow over")."""
    return uuid.uuid5(document_id, "one_pager_line_id:" + key)


def bet_key(line: dict[str, Any]) -> str:
    """A built bet line's key: the one carried across rebuilds (``one_pager.carry_keys``),
    or, on a page built before keys were carried, its line id."""
    return str(line.get("flow_key") or line.get("id") or "")


def words_subject(document_id: uuid.UUID, text: str) -> uuid.UUID:
    """A bet's subject id before 0092_bet_flow_line_key: its PRD and its words. A flow that
    migration left there (its words matched no line) is still found by them."""
    return uuid.uuid5(document_id, "one_pager_line:" + " ".join(text.split()).lower())


# --------------------------------------------------------------------------- subjects


@dataclass
class Subject:
    title: str
    document_id: uuid.UUID | None = None
    # A change: who may read it (its author, who decides it).
    change: SimpleChange | None = None
    context: dict[str, Any] = field(default_factory=dict)
    # The subject named with its code when it has one ("F-06 Adaptive pacing").
    name: str | None = None


async def _subject(db: AsyncSession, kind: str, subject_id: uuid.UUID) -> Subject:
    """What the subject is, as far as Simple knows it; kinds other lanes own (a suggestion,
    a chat card) and a one-pager line carry their words in the brief."""
    from oracle.roadmap.models import RoadmapItem

    if kind not in SUBJECT_KINDS:
        raise VisualError(422, f"subject_kind must be one of {', '.join(SUBJECT_KINDS)}")
    if kind == "change":
        c = await db.get(SimpleChange, subject_id)
        if c is None:
            raise VisualError(404, "No such change")
        item = None
        if (c.target or {}).get("item_id"):
            try:
                item = await db.get(RoadmapItem, uuid.UUID(str(c.target["item_id"])))
            except ValueError:
                item = None
        # Plain words: a change with no item and no line is "the change", never its op.
        title = item.title if item is not None else str((c.after or {}).get("line") or "the change")
        doc = c.document_id or ((c.target or {}).get("document_id"))
        return Subject(
            title=title[:200],
            document_id=uuid.UUID(str(doc)) if doc else None,
            change=c,
            context={"op": c.op, "after": c.after, "reason": c.reason},
        )
    if kind in ("feature", "draft_item"):
        item = await db.get(RoadmapItem, subject_id)
        if item is not None:
            from oracle.simple.priorities import prd_code

            code = prd_code(item.prd_section_key)
            return Subject(
                title=item.title,
                name=f"{code} {item.title}" if code else item.title,
                document_id=item.roadmap_document_id,
                context={"outcome": item.outcome, "prd_section_key": item.prd_section_key,
                         "prd_document_id": str(item.prd_document_id or "") or None},
            )  # fmt: skip
        from oracle.baseline.models import Entity

        e = await db.get(Entity, subject_id)
        if e is not None:
            return Subject(title=str(getattr(e, "title", None) or getattr(e, "name", "")))
        raise VisualError(404, "No such item or feature")
    return Subject(title="")


async def bet_line(
    db: AsyncSession, principal: Any, document_id: uuid.UUID | None, subject_id: uuid.UUID
) -> tuple[uuid.UUID, str] | None:
    """The bet ("What we will build") line of the PRD's one-pager whose subject this is, and
    its published words (never a working draft's: who reads only the published page reads
    its drawing too). The caller must read the page. None: no PRD given, or no such bet."""
    from oracle.simple import one_pager
    from oracle.simple.changes import ChangeError

    if document_id is None:
        return None
    try:
        page = await one_pager.read(db, principal, str(document_id))
    except ChangeError:
        return None
    doc_id = page.document.id
    shown = {x.id: x for b in page.blocks for x in b.lines if x.flow_subject is not None}
    doc = await db.get(Document, doc_id)
    b = await one_pager.built(db, doc, queue=False, persist=False)  # type: ignore[arg-type]
    bets = []
    for blk in [x for x in b.row.blocks or [] if x.get("key") == "bets"]:
        for x in blk.get("lines") or []:
            on_page = shown.get(str(x.get("id") or ""))
            # The page's tidied words, unless they are the draft's: then the published.
            words = on_page.text if on_page and on_page.state != "edited" else x.get("text")
            bets.append((bet_key(x), str(words or "")))
    for key, text in bets:
        if line_subject(doc_id, key) == subject_id:
            return doc_id, text
    # A flow still keyed by a bet's words (one the migration did not move).
    for _, text in bets + [(x.id, x.text) for x in shown.values()]:
        if words_subject(doc_id, text) == subject_id:
            return doc_id, text
    return None


async def _visual(db: AsyncSession, kind: str, subject_id: uuid.UUID) -> SimpleVisual | None:
    return await db.scalar(
        select(SimpleVisual).where(
            SimpleVisual.subject_kind == kind, SimpleVisual.subject_id == subject_id
        )
    )


async def _document(db: AsyncSession, v: SimpleVisual) -> Document | None:
    return await db.get(Document, v.document_id) if v.document_id else None


async def may_read(db: AsyncSession, principal: Any, v: SimpleVisual) -> bool:
    doc = await _document(db, v)
    if doc is not None and (
        not visibility.can_see(principal, doc) or getattr(doc, "deleted_at", None)
    ):
        return False
    if v.subject_kind == "change":
        c = await db.get(SimpleChange, v.subject_id)
        if c is not None and c.status == "proposed":
            # Who the change engine shows the proposal to (its people, the session's, the
            # document's owners, decider and reviewers), or who changes it directly.
            from oracle.simple import changes

            return (await changes._view(db, principal, [c])).sees(c) or (
                v.document_id is not None and await _edits(db, principal, v.document_id)
            )
        if c is not None and c.status == "applied" and c.draft_ids:
            # A change in a working draft not yet published: who sees the draft.
            from oracle.simple import drafts
            from oracle.simple.models import SimpleDraft

            rows = await db.scalars(select(SimpleDraft).where(SimpleDraft.id.in_(c.draft_ids)))
            open_ = [d for d in rows if d.status in ("working", "submitted")]
            if open_:
                w = await drafts.who(db, {d.document_id for d in open_})
                return any(drafts.sees(principal, d, w) for d in open_)
    if v.document_id is None and v.subject_kind in LOOSE_KINDS:
        # Another lane's subject asked for with no document: until its lane names the
        # document, its requester and the company's owners only (never any reader who
        # has the id).
        me = _me(principal)
        return me is not None and (has_role(principal.role, "owner") or me == v.requested_by)
    if v.subject_kind == "one_pager_line" and v.document_id is not None:
        # A bet's subject is its line: who has the PRD but finds no such bet on the page
        # does not read its drawing.
        return await bet_line(db, principal, v.document_id, v.subject_id) is not None
    return True


async def _edits(db: AsyncSession, principal: Any, document_id: uuid.UUID) -> bool:
    from oracle.simple import drafts

    return drafts.can_edit(principal, document_id, await drafts.who(db, {document_id}))


async def may_revise(db: AsyncSession, principal: Any, v: SimpleVisual) -> bool:
    """Who changes the subject's document directly; with no document, the owners."""
    if _me(principal) is None:
        return False
    if v.document_id is None:
        return has_role(principal.role, "owner")
    return await _edits(db, principal, v.document_id)


# --------------------------------------------------------------------------- reading


def _flow(v: SimpleVisual, ver: SimpleVisualVersion, count: int) -> SimpleFlow:
    screen = ver.screen or None
    steps = [SimpleFlowStep(**s) for s in ver.steps]
    return SimpleFlow(
        title=ver.title,
        steps=[s.label for s in steps],
        screen=SimpleFlowScreen(
            title=screen["title"] if screen else "No screen",
            regions=list(screen["regions"]) if screen else [],
        ),
        subject_kind=v.subject_kind,
        subject_id=v.subject_id,
        version=ver.number,
        versions=count,
        goal=ver.goal,
        nodes=steps,
        svg=ver.flow_svg,
        wireframe=ver.wireframe_html,
        touches_screen=screen is not None,
        annotations=[SimpleFlowNote(**a) for a in ver.annotations],
        made_at=ver.created_at,
    )


async def _versions(db: AsyncSession, v: SimpleVisual) -> list[SimpleVisualVersion]:
    return list(
        await db.scalars(
            select(SimpleVisualVersion)
            .where(SimpleVisualVersion.visual_id == v.id)
            .order_by(SimpleVisualVersion.number.desc())
        )
    )


async def flow_for(db: AsyncSession, subject_kind: str, subject_id: uuid.UUID) -> SimpleFlow | None:
    """The newest drawing of the subject's visual as train T's ``SimpleFlow``; None when
    Oracle has drawn none yet ("No flow yet")."""
    return (await flows_for(db, subject_kind, [subject_id])).get(subject_id)


async def flows_for(
    db: AsyncSession, subject_kind: str, subject_ids: list[uuid.UUID]
) -> dict[uuid.UUID, SimpleFlow]:
    """:func:`flow_for` for many subjects of one kind, in two reads."""
    if not subject_ids:
        return {}
    visuals = {
        v.id: v
        for v in await db.scalars(
            select(SimpleVisual).where(
                SimpleVisual.subject_kind == subject_kind,
                SimpleVisual.subject_id.in_(set(subject_ids)),
            )
        )
    }
    if not visuals:
        return {}
    newest: dict[uuid.UUID, SimpleVisualVersion] = {}
    counts: dict[uuid.UUID, int] = {}
    for ver in await db.scalars(
        select(SimpleVisualVersion)
        .where(SimpleVisualVersion.visual_id.in_(visuals))
        .order_by(SimpleVisualVersion.number)
    ):
        newest[ver.visual_id] = ver
        counts[ver.visual_id] = counts.get(ver.visual_id, 0) + 1
    return {
        visuals[vid].subject_id: _flow(visuals[vid], ver, counts[vid])
        for vid, ver in newest.items()
    }


def one_pager_flow(flow: SimpleFlow | None) -> OnePagerFlow | None:
    """The one-pager's shape of a flow (title, steps and the screen's title)."""
    if flow is None:
        return None
    return OnePagerFlow(
        title=flow.title,
        steps=flow.steps,
        screen=flow.screen.title if flow.touches_screen else None,
        subject_kind=flow.subject_kind,
        subject_id=flow.subject_id,
        version=flow.version,
    )


async def _live_job(db: AsyncSession, v: SimpleVisual) -> LlmJob | None:
    return await db.scalar(
        select(LlmJob)
        .where(LlmJob.visual_id == v.id, LlmJob.status.in_(("queued", "running")))
        .limit(1)
    )


async def _last_failure(db: AsyncSession, v: SimpleVisual) -> str | None:
    """Why Oracle's newest drawing job for the visual ended without a drawing; None when
    it drew, is still drawing or never ran."""
    job = await db.scalar(
        select(LlmJob)
        .where(LlmJob.visual_id == v.id)
        .order_by(LlmJob.created_at.desc(), LlmJob.id.desc())
        .limit(1)
    )
    if job is None or job.status in ("queued", "running", "cancelled"):
        return None
    if job.status == "failed":
        return "Oracle could not draw it"
    if (job.output or {}).get("drawn") is False:
        return "Oracle's drawing did not check out"
    return None


async def _names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    from oracle.simple import changes

    return await changes._names(db, ids)


async def read(
    db: AsyncSession,
    principal: Any,
    subject_kind: str,
    subject_id: uuid.UUID,
    document_id: uuid.UUID | None = None,
) -> SimpleVisualOut:
    """The subject's visual as the caller may read it: the newest drawing, the list of
    versions, the comments and what the caller may do. No visual yet: ``flow`` null; a
    one-pager line is offered the ask with its PRD (``document_id``) only."""
    if subject_kind not in SUBJECT_KINDS:
        raise VisualError(422, f"subject_kind must be one of {', '.join(SUBJECT_KINDS)}")
    v = await _visual(db, subject_kind, subject_id)
    if v is not None and not await may_read(db, principal, v):
        if subject_kind != "one_pager_line":
            raise VisualError(404, "No such visual")
        # A bet not on the caller's page reads as one with nothing drawn.
        v = None
    if v is None:
        # Nothing drawn or asked for yet: who may ask is who would revise it.
        try:
            subject = await _subject(db, subject_kind, subject_id)
        except VisualError:
            subject = Subject(title="")
        bet = None
        if subject_kind == "one_pager_line":
            bet = await bet_line(db, principal, document_id, subject_id)
            subject.document_id = bet[0] if bet else None
        probe = SimpleVisual(
            subject_kind=subject_kind, subject_id=subject_id,
            document_id=subject.document_id, brief="",
        )  # fmt: skip
        # A bet found on the caller's page is theirs to read.
        if subject_kind != "one_pager_line" and not await may_read(db, principal, probe):
            raise VisualError(404, "No such visual")
        return SimpleVisualOut(
            subject_kind=subject_kind,
            subject_id=subject_id,
            flow=None,
            versions=[],
            comments=[],
            pending=False,
            can_comment=False,
            can_revise=subject_kind not in UNASKABLE_KINDS
            and (subject_kind != "one_pager_line" or bet is not None)
            and await may_revise(db, principal, probe),
        )
    vers = await _versions(db, v)
    comments = list(
        await db.scalars(
            select(SimpleVisualComment)
            .where(SimpleVisualComment.visual_id == v.id)
            .order_by(SimpleVisualComment.created_at, SimpleVisualComment.id)
        )
    )
    names = await _names(
        db, {c.author_id for c in comments} | {x.made_by for x in vers if x.made_by}
    )
    open_count = {x.number: sum(1 for c in comments if c.addressed_in == x.number) for x in vers}
    job = await _live_job(db, v)
    pending = job is not None
    failure = None if pending else await _last_failure(db, v)
    subject_name = None
    if pending:
        try:
            got = await _subject(db, v.subject_kind, v.subject_id)
            subject_name = got.name or got.title or None
        except VisualError:
            subject_name = None
    return SimpleVisualOut(
        subject_kind=v.subject_kind,
        subject_id=v.subject_id,
        brief=v.brief,
        flow=_flow(v, vers[0], len(vers)) if vers else None,
        versions=[
            SimpleVisualVersionOut(
                number=x.number,
                title=x.title,
                made_at=x.created_at,
                made_by_name=names.get(x.made_by) if x.made_by else None,
                addressed=open_count.get(x.number, 0),
            )
            for x in vers
        ],
        comments=[
            SimpleVisualCommentOut(
                id=c.id,
                version=c.version_number,
                annotation=c.annotation,
                body=c.body,
                by_name=names.get(c.author_id, "someone"),
                at=c.created_at,
                addressed_in=c.addressed_in,
            )
            for c in comments
        ],
        pending=pending,
        failed=failure is not None,
        failure=failure,
        started_at=job.created_at if job is not None else None,
        stage=1 if job is not None and job.status == "running" else 0,
        subject_name=subject_name,
        can_comment=bool(vers)
        and has_role(principal.role, "commenter")
        and _me(principal) is not None,
        can_revise=await may_revise(db, principal, v),
    )


async def version(
    db: AsyncSession, principal: Any, subject_kind: str, subject_id: uuid.UUID, number: int
) -> SimpleFlow:
    v = await _visual(db, subject_kind, subject_id)
    if v is None or not await may_read(db, principal, v):
        raise VisualError(404, "No such visual")
    vers = await _versions(db, v)
    ver = next((x for x in vers if x.number == number), None)
    if ver is None:
        raise VisualError(404, f"The visual has no version {number}")
    return _flow(v, ver, len(vers))


# --------------------------------------------------------------------------- writing


async def _enqueue(
    db: AsyncSession, principal: Any, v: SimpleVisual, mode: str, note: str | None = None
) -> LlmJob | None:
    """Queue the drawing job unless one is live; None when the document's switch is off."""
    from oracle.jobs import service as jobs

    live = await _live_job(db, v)
    if live is not None:
        return live
    doc = await _document(db, v)
    if doc is not None and not jobs.enabled(doc, JOB_KIND):
        return None
    job = LlmJob(
        kind=JOB_KIND,
        visual_id=v.id,
        status="queued",
        input={"mode": mode, **({"note": note} if note else {})},
        requested_by=_me(principal),
        attempts=0,
    )
    db.add(job)
    await db.flush()
    if _me(principal) is not None:
        await audit.record(
            db, principal, "llm_job.queue", "llm_job", job.id,
            {"kind": JOB_KIND, "visual_id": str(v.id), "mode": mode},
        )  # fmt: skip
    return job


async def ensure(
    db: AsyncSession,
    principal: Any,
    subject_kind: str,
    subject_id: uuid.UUID,
    brief: str,
    document_id: uuid.UUID | None = None,
) -> SimpleVisual:
    v = await _visual(db, subject_kind, subject_id)
    if v is not None:
        return v
    subject = await _subject(db, subject_kind, subject_id)
    v = SimpleVisual(
        subject_kind=subject_kind,
        subject_id=subject_id,
        document_id=subject.document_id or document_id,
        brief=(brief.strip() or subject.title or "A new flow")[:BRIEF_MAX],
        requested_by=_me(principal),
        updated_at=company_time.now(),
    )
    db.add(v)
    await db.flush()
    return v


async def request_visual(
    db: AsyncSession,
    principal: Any,
    subject_kind: str,
    subject_id: uuid.UUID,
    brief: str,
    *,
    document_id: uuid.UUID | None = None,
) -> None:
    """Oracle drafts the subject's visual (the ``simple_visual`` job), once: a subject that
    has a drawing or a live job is left as it is. Never raises for a switched-off
    document; the caller commits. ``document_id``: the roadmap or PRD a subject Simple
    cannot look up belongs to (a one-pager line's PRD, a chat card's roadmap)."""
    v = await ensure(db, principal, subject_kind, subject_id, brief, document_id)
    if await db.scalar(
        select(func.count())
        .select_from(SimpleVisualVersion)
        .where(SimpleVisualVersion.visual_id == v.id)
    ):
        return
    await _enqueue(db, principal, v, "draft")


async def ask_for(
    db: AsyncSession,
    principal: Any,
    subject_kind: str,
    subject_id: uuid.UUID,
    brief: str,
    document_id: uuid.UUID | None = None,
) -> SimpleVisualOut:
    """The route's "Ask Oracle to draw it" for a subject with no visual yet (who revises).
    Only subjects Simple can look up: the others are drawn with their proposal. A
    one-pager bet line names its PRD (``document_id``); its words are the brief."""
    if subject_kind in UNASKABLE_KINDS:
        raise VisualError(422, "Oracle draws this visual with its proposal; it is not asked for")
    if subject_kind == "one_pager_line":
        if document_id is None:
            raise VisualError(422, "A one-pager line's visual is asked for with its PRD")
        if not await may_revise(db, principal, SimpleVisual(document_id=document_id)):
            raise VisualError(403, "Only who changes this directly asks Oracle for its visual")
        bet = await bet_line(db, principal, document_id, subject_id)
        if bet is None:
            raise VisualError(404, "No such bet on the PRD's one-pager")
        await request_visual(db, principal, subject_kind, subject_id, bet[1], document_id=bet[0])
        return await read(db, principal, subject_kind, subject_id, bet[0])
    subject = await _subject(db, subject_kind, subject_id)
    probe = SimpleVisual(subject_kind=subject_kind, subject_id=subject_id,
                         document_id=subject.document_id, brief="")  # fmt: skip
    if not await may_read(db, principal, probe):
        raise VisualError(404, "No such visual")
    if not await may_revise(db, principal, probe):
        raise VisualError(403, "Only who changes this directly asks Oracle for its visual")
    await request_visual(db, principal, subject_kind, subject_id, brief or subject.title)
    return await read(db, principal, subject_kind, subject_id)


async def comment(
    db: AsyncSession,
    principal: Any,
    subject_kind: str,
    subject_id: uuid.UUID,
    body: str,
    annotation: int | None,
) -> SimpleVisualOut:
    v = await _visual(db, subject_kind, subject_id)
    if v is None or not await may_read(db, principal, v):
        raise VisualError(404, "No such visual")
    me = _me(principal)
    if me is None or not has_role(principal.role, "commenter"):
        raise VisualError(403, "Commenters and up comment on a visual")
    vers = await _versions(db, v)
    if not vers:
        raise VisualError(409, "Oracle has not drawn this visual yet")
    if annotation is not None and not any(a.get("n") == annotation for a in vers[0].annotations):
        raise VisualError(422, f"The visual has no annotation {annotation}")
    db.add(
        SimpleVisualComment(
            visual_id=v.id,
            version_number=vers[0].number,
            annotation=annotation,
            body=body.strip(),
            author_id=me,
        )
    )
    await db.flush()
    await audit.record(db, principal, "simple_visual.comment", "simple_visual", v.id,
                       {"version": vers[0].number})  # fmt: skip
    return await read(db, principal, subject_kind, subject_id)


async def revise(
    db: AsyncSession, principal: Any, subject_kind: str, subject_id: uuid.UUID, note: str | None
) -> SimpleVisualOut:
    """Revise: Oracle redraws the visual from its open comments (and the note) as the next
    version. 409 with nothing to revise from."""
    v = await _visual(db, subject_kind, subject_id)
    if v is None or not await may_read(db, principal, v):
        raise VisualError(404, "No such visual")
    if not await may_revise(db, principal, v):
        raise VisualError(403, "Only who changes this directly revises its visual")
    if not await _versions(db, v):
        raise VisualError(409, "Oracle has not drawn this visual yet")
    has_open = await db.scalar(
        select(func.count())
        .select_from(SimpleVisualComment)
        .where(SimpleVisualComment.visual_id == v.id, SimpleVisualComment.addressed_in.is_(None))
    )
    if not has_open and not (note or "").strip():
        raise VisualError(409, "Nothing to revise from: comment first, or say what to change")
    job = await _enqueue(db, principal, v, "revise", (note or "").strip()[:BRIEF_MAX] or None)
    if job is None:
        raise VisualError(409, '"Draw visuals" is turned off for this document')
    await audit.record(db, principal, "simple_visual.revise", "simple_visual", v.id,
                       {"job_id": str(job.id)})  # fmt: skip
    return await read(db, principal, subject_kind, subject_id)


# --------------------------------------------------------------------------- hooks


async def on_change(db: AsyncSession, principal: Any, change: Any) -> None:
    """A proposal or change that adds or reshapes a feature or flow comes with its visual:
    a confirmed draft item, a new outcome, a one-pager bet ("What we will build") line."""
    op, target, after = change.op, change.target or {}, change.after or {}
    if op == "edit_line" and str(target.get("line_id") or "").startswith("bets-"):
        brief = f"A bet of the PRD's one-pager, reworded to: {after.get('line') or ''}"
    elif op in FEATURE_OPS and change.status == "proposed":
        # A direct edit is no proposal: the feature's own visual is asked for and revised.
        words = after.get("outcome") or after.get("title") or ""
        brief = f"{op.replace('_', ' ').capitalize()}: {words}".strip(": ")
    else:
        return
    await request_visual(db, principal, "change", change.id, brief)


# --------------------------------------------------------------------------- the job


@dataclass
class Checked:
    title: str
    goal: str | None
    steps: list[dict[str, Any]]
    screen: dict[str, Any] | None
    svg: str
    html: str | None
    annotations: list[dict[str, Any]]
    removed: list[str]
    problems: list[str] = field(default_factory=list)


def _text(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def draw_svg(title: str, goal: str | None, steps: list[dict[str, Any]]) -> str:
    """Oracle's own drawing of a flow: one row of boxes (diamonds for decisions), the
    feature under each, new steps drawn bold and marked NEW, changed ones dashed."""
    w, h, gap = 170, 64, 36
    width = max(1, len(steps)) * (w + gap) + gap
    height = 230
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" font-family="sans-serif">',
        f'<text x="{gap}" y="24" font-size="15" font-weight="bold">{html.escape(title)}</text>',
    ]
    if goal:
        parts.append(
            f'<text id="goal" x="{gap}" y="44" font-size="12">Goal: {html.escape(goal)}</text>'
        )
    for i, s in enumerate(steps):
        x, y = gap + i * (w + gap), 70
        change = s.get("change", "same")
        stroke = 'stroke="#111" stroke-width="3"' if change == "new" else (
            'stroke="#333" stroke-width="2" stroke-dasharray="6 4"' if change == "changed"
            else 'stroke="#777" stroke-width="1"'
        )  # fmt: skip
        sid = html.escape(s["id"])
        if s.get("kind") == "decision":
            cx, cy = x + w / 2, y + h / 2
            parts.append(
                f'<polygon id="{sid}" points="{cx},{y - 6} {x + w},{cy} {cx},{y + h + 6} {x},{cy}" '
                f'fill="#f4f4f4" {stroke}/>'
            )
        else:
            parts.append(
                f'<rect id="{sid}" x="{x}" y="{y}" width="{w}" height="{h}" rx="8" '
                f'fill="#fafafa" {stroke}/>'
            )
        parts.append(
            f'<text x="{x + w / 2}" y="{y + h / 2 + 4}" font-size="12" text-anchor="middle">'
            f"{i + 1}. {html.escape(s['label'][:26])}</text>"
        )
        if change in ("new", "changed"):
            parts.append(
                f'<text x="{x + 6}" y="{y - 8}" font-size="10" font-weight="bold">'
                f"{'NEW' if change == 'new' else 'CHANGED'}</text>"
            )
        if s.get("feature"):
            parts.append(
                f'<text x="{x + w / 2}" y="{y + h + 22}" font-size="10" text-anchor="middle">'
                f"{html.escape(str(s['feature'])[:30])}</text>"
            )
        if i + 1 < len(steps):
            ax = x + w
            parts.append(
                f'<line x1="{ax}" y1="{y + h / 2}" x2="{ax + gap - 4}" y2="{y + h / 2}" '
                'stroke="#555" stroke-width="1.5"/>'
                f'<polygon points="{ax + gap - 4},{y + h / 2 - 4} {ax + gap},{y + h / 2} '
                f'{ax + gap - 4},{y + h / 2 + 4}" fill="#555"/>'
            )
    parts.append("</svg>")
    return "".join(parts)


def draw_wireframe(screen: dict[str, Any]) -> str:
    """Oracle's own low-fi wireframe: the screen's regions as labelled grey blocks."""
    blocks = "".join(
        f'<div data-annotation="r{i}" style="border:1px solid #999;padding:12px;'
        f'margin:8px 0;background:#eee">{html.escape(r)}</div>'
        for i, r in enumerate(screen["regions"], start=1)
    )
    return f"<h1>{html.escape(screen['title'])}</h1>{blocks}"


def check_answer(answer: Any, section_keys: set[str] | None) -> Checked:
    """The job's answer held to the design checks: steps and regions capped, ids well
    formed, the SVG and wireframe sanitised (anything that runs or fetches refuses the
    answer), annotations kept only when their target is in the drawing and their section
    in the PRD (``section_keys`` None: the subject has no PRD to check against)."""
    a = answer if isinstance(answer, dict) else {}
    out = Checked(title="", goal=None, steps=[], screen=None, svg="", html=None,
                  annotations=[], removed=[])  # fmt: skip
    out.title = _text(a.get("title"), 120)
    if not out.title:
        out.problems.append("the answer has no title")
    out.goal = _text(a.get("goal"), 200) or None
    seen: set[str] = set()
    for i, raw in enumerate((a.get("steps") or [])[:MAX_STEPS], start=1):
        if not isinstance(raw, dict):
            continue
        label = _text(raw.get("label"), LABEL_MAX)
        sid = str(raw.get("id") or f"s{i}")
        if not label:
            continue
        if not _ID.fullmatch(sid) or sid in seen:
            sid = f"s{i}"
        seen.add(sid)
        decision = raw.get("kind") == "decision"
        key = raw.get("section_key")
        if key is not None and section_keys is not None and key not in section_keys:
            out.removed.append(f"step {sid}: unknown PRD section {key!r}")
            key = None
        out.steps.append({
            "id": sid,
            "label": label,
            "kind": "decision" if decision else "step",
            "feature": _text(raw.get("feature"), LABEL_MAX) or None,
            "change": raw.get("change") if raw.get("change") in ("new", "changed") else "same",
            "section_key": str(key) if key else None,
            "actor": _text(raw.get("actor"), ACTOR_MAX) or None,
            "yes": (_text(raw.get("yes"), LABEL_MAX) or None) if decision else None,
            "no": (_text(raw.get("no"), LABEL_MAX) or None) if decision else None,
        })  # fmt: skip
    if len(out.steps) < 2:
        out.problems.append("a user flow needs at least two steps")
    scr = a.get("screen")
    if isinstance(scr, dict) and _text(scr.get("title"), 80):
        regions = [_text(r, LABEL_MAX) for r in (scr.get("regions") or [])[:MAX_REGIONS]]
        out.screen = {"title": _text(scr["title"], 80), "regions": [r for r in regions if r]}
    if out.problems:
        return out
    svg_in = a.get("flow_svg") if isinstance(a.get("flow_svg"), str) else None
    svg = sanitize_svg(svg_in or draw_svg(out.title, out.goal, out.steps), title=out.title)
    if svg.too_large:
        out.problems.append(f"the flow is over {MAX_FILE_BYTES} bytes")
    out.problems += [f"flow: {b}" for b in svg.blocked]
    out.removed += svg.removed
    out.svg = svg.content
    targets = set(svg.targets)
    notes_in = [n for n in (a.get("annotations") or [])[:MAX_NOTES] if isinstance(n, dict)]
    if out.screen is not None:
        html_in = a.get("wireframe_html") if isinstance(a.get("wireframe_html"), str) else None
        labels = [(f"{n}.", _text(x.get("note"), NOTE_MAX)) for n, x in enumerate(notes_in, 1)]
        page = sanitize_wireframe(
            html_in or draw_wireframe(out.screen), title=out.screen["title"], annotations=labels
        )
        if page.too_large:
            out.problems.append(f"the wireframe is over {MAX_FILE_BYTES} bytes")
        out.problems += [f"wireframe: {b}" for b in page.blocked]
        out.removed += page.removed
        out.html = page.content
        targets |= page.targets
    for raw in notes_in:
        note, target = _text(raw.get("note"), NOTE_MAX), str(raw.get("target") or "")
        if not note:
            continue
        if target not in targets:
            out.removed.append(f"annotation on {target!r}: not in the drawing")
            continue
        key = raw.get("section_key")
        if key is not None and section_keys is not None and key not in section_keys:
            out.removed.append(f"annotation on {target!r}: unknown PRD section {key!r}")
            key = None
        out.annotations.append({
            "n": len(out.annotations) + 1,
            "target": target,
            "note": note,
            "section_key": str(key) if key else None,
            "requirement": _text(raw.get("requirement"), 40) or None,
        })  # fmt: skip
    return out


async def _prd_sections(db: AsyncSession, document_id: uuid.UUID | None) -> list[Section]:
    """The sections of the PRD a visual rests on (the newest version), if it has one."""
    if document_id is None:
        return []
    doc = await db.get(Document, document_id)
    if doc is None:
        return []
    ids = [document_id]
    if doc.kind != "prd":
        from oracle.roadmap.models import RoadmapItem

        prd = await db.scalar(
            select(RoadmapItem.prd_document_id)
            .where(RoadmapItem.roadmap_document_id == document_id,
                   RoadmapItem.prd_document_id.is_not(None))
            .limit(1)
        )  # fmt: skip
        if prd is None:
            return []
        ids = [prd]
    v = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == ids[0])
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if v is None:
        return []
    return list(
        await db.scalars(
            select(Section).where(Section.version_id == v.id).order_by(Section.ordinal)
        )
    )


async def run_job(s: AsyncSession, job: LlmJob, ask) -> dict[str, Any]:
    """The ``simple_visual`` job: one call with the proposal's brief, the PRD's sections
    and, to revise, the newest drawing and its open comments; the checked answer is the
    next version."""
    from oracle.jobs.kinds import JobInputError

    v = await s.get(SimpleVisual, job.visual_id) if job.visual_id else None
    if v is None:
        raise JobInputError("the visual no longer exists")
    subject = await _subject(s, v.subject_kind, v.subject_id) if v.subject_kind in (
        "change", "feature", "draft_item"
    ) else Subject(title="")  # fmt: skip
    sections = await _prd_sections(s, v.document_id)
    vers = await _versions(s, v)
    mode = (job.input or {}).get("mode", "draft")
    comments = list(
        await s.scalars(
            select(SimpleVisualComment)
            .where(SimpleVisualComment.visual_id == v.id,
                   SimpleVisualComment.addressed_in.is_(None))
            .order_by(SimpleVisualComment.created_at)
        )
    ) if mode == "revise" else []  # fmt: skip
    payload: dict[str, Any] = {
        "mode": mode,
        "subject_kind": v.subject_kind,
        "title": subject.title,
        "brief": v.brief,
        "context": subject.context,
        "sections": [
            {"key": x.section_key, "heading": x.heading, "text": x.body_text[:1500]}
            for x in sections[:30]
        ],  # fmt: skip
    }
    if mode == "revise" and vers:
        cur = vers[0]
        payload["current"] = {"title": cur.title, "goal": cur.goal, "steps": cur.steps,
                              "screen": cur.screen, "annotations": cur.annotations}  # fmt: skip
        payload["comments"] = [{"annotation": c.annotation, "body": c.body} for c in comments]
        if (job.input or {}).get("note"):
            payload["note"] = job.input["note"]
    answer = await ask(JOB_KIND, payload)
    checked = check_answer(answer, {x.section_key for x in sections} if sections else None)
    if checked.problems:
        return {"drawn": False, "problems": checked.problems[:20]}
    number = (vers[0].number if vers else 0) + 1
    s.add(
        SimpleVisualVersion(
            visual_id=v.id,
            number=number,
            title=checked.title,
            goal=checked.goal,
            steps=checked.steps,
            screen=checked.screen,
            flow_svg=checked.svg,
            wireframe_html=checked.html,
            annotations=checked.annotations,
            removed=checked.removed,
            job_id=job.id,
            made_by=job.requested_by,
        )
    )
    for c in comments:
        c.addressed_in = number
    v.updated_at = company_time.now()
    await s.flush()
    return {"drawn": True, "version": number, "removed": checked.removed[:20]}
