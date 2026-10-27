"""Simple S3b (#723): working drafts of versioned documents (D18 and the owner's answers).

**What a working draft is**: an owner's or the decider's applied change to a roadmap's
item (oracle.simple.changes) never writes the published version's rows ("rows of an
approved roadmap version are never rewritten", oracle.roadmap.models.RoadmapItem): it
writes the item's fields into the roadmap's working draft (``simple_drafts.overlay``,
keyed by the published item's id), opened on the version readers see (``base_version_id``).
A roadmap has at most one working draft; every session whose changes land in it joins it
(``simple_session_drafts``), and its starter becomes a participant. Undo inside the draft
reverses one change at a time (S3a's rules) while the draft is working.

**Reused**: the draft is the #346 change-set path (oracle.roadmap.changeset) carried one
step further. Submitting imports the next roadmap version exactly as a change set's
proposal does (``docs_service.import_draft`` with the base's text plus a "Plan changes"
section, ``changeset._markdown``; the base's rows copied with ``items.COPIED`` and their
milestone rechecked), with the draft's fields on the copied items. From there the version
is an ordinary version in review: the document's review policy (oracle.review.state) names
its decider, its required reviewers and required sections, re-review on change works per
section revision, section approvals are ``review_section`` verdicts and the final approval
is ``approve_version``, which makes it the live plan. Nothing new decides whether a version
may go live: :func:`_settle` asks ``publish.review_problems``.

**Approval** (owner answer): the decider's approval (``POST .../approve`` or
:func:`approve_in_meeting`, S8's call) is recorded on the draft and the version is approved
only when every required reviewer has approved its sections; until then the reviewers left
are ``waiting_on`` and each has an Inbox request (:func:`inbox_rows`). In a meeting the
required reviewers present approve there too.

**Who sees** (owner answer): a draft and its changes are visible to the company's owners,
its participants, the roadmap's decider, its required reviewers and its owners (the
owners of its tracks); everyone else reads the published version and a count,
``changes_in_review`` (the draft's changes and the roadmap's open proposals).

**Every submitted draft settles** (#730 review, S3b-1): approving its version in the
Detailed view (``approve_version``) approves the draft (:func:`on_version_approved`); a
required reviewer's section approvals there settle it once nothing blocks; a verdict other
than approved on any of its sections returns it to working (:func:`on_section_verdict`), and
so does its author's or the decider's :func:`withdraw`. A returned draft keeps its changes
(undoable again in their open session); its version is marked withdrawn in its notes
(:data:`WITHDRAWN`), never shown in Simple and refused by ``approve_version``, the way a
superseded change set's version is.

**One shared draft per roadmap** (D-d): every session editing the roadmap adds to it and
approving it publishes all its changes; the draft lists each change's author, time and
whether it was made in a meeting (``change_log``).

**Sessions**: a session closed for idleness leaves its draft working; its author or the
decider resumes it in a new session (:func:`resume`).
"""

import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.simple.models import (
    RoadmapDateSuggestion,
    SimpleChange,
    SimpleDraft,
    SimpleSession,
    SimpleSessionDraft,
)
from oracle.simple.schemas import (
    InboxSimpleApproval,
    SimpleDocRef,
    SimpleDraftBrief,
    SimpleDraftChange,
    SimpleDraftOut,
    SimpleMeetingApproval,
    SimpleNotApproved,
)

OPEN = ("working", "submitted")
COUNTED = ("applied", "accepted")
# The item fields a Simple change writes (oracle.simple.changes.FIELDS and the fixes).
FIELDS = (
    "start_date",
    "end_date",
    "date_source",
    "horizon",
    "position",
    "cut",
    "title",
    "outcome",
    "accepted_risks",
    # S6: confirm_item.
    "draft",
    # S7 (oracle.simple.additions): Oracle's drafting, merge_item and keep_both.
    "feature_id",
    "depends_on",
    "note",
    "goal_ids",
    "merged_into",
    "kept_both",
    # S9: set_milestone.
    "milestone",
)
UUID_FIELDS = ("feature_id",)
DATES = ("start_date", "end_date")
# Blockers of review_problems that the approval itself resolves.
APPROVAL_CODES = ("version_not_approved", "mandatory_reviewer_pending")
SECTION_NOTE = "Approved in Simple"
# The note on a version withdrawn from review (DocumentVersion.notes).
WITHDRAWN = "simple_draft_withdrawn"


class DraftError(Exception):
    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(detail if isinstance(detail, str) else detail.get("message"))
        self.status = status
        self.detail = detail


# --------------------------------------------------------------------------- items


def _json(f: str, v: Any) -> Any:
    if f in DATES:
        return v.isoformat() if isinstance(v, date) else v
    if f in UUID_FIELDS:
        return str(v) if v is not None else None
    if f == "goal_ids":
        return [str(x) for x in v or []]
    return list(v or []) if f in ("accepted_risks", "depends_on") else v


def _typed(f: str, v: Any) -> Any:
    """A JSON value of the overlay as the row's attribute."""
    if f in DATES:
        return date.fromisoformat(v) if isinstance(v, str) else v
    if f in UUID_FIELDS:
        return uuid.UUID(str(v)) if v else None
    if f == "goal_ids":
        return [uuid.UUID(str(x)) for x in v or []]
    return v


def snapshot(row: RoadmapItem) -> dict[str, Any]:
    return {f: _json(f, getattr(row, f)) for f in FIELDS}


def overlaid(row: RoadmapItem, values: dict[str, Any] | None) -> RoadmapItem:
    """A transient copy of ``row`` (never in the session, never flushed) with the draft's
    fields; ``row`` itself when the draft has none."""
    if not values:
        return row
    copy = RoadmapItem(**{a.key: getattr(row, a.key) for a in RoadmapItem.__mapper__.column_attrs})
    for f, v in values.items():
        if f in FIELDS:
            setattr(copy, f, _typed(f, v))
    return copy


def placed(row: RoadmapItem, base_version_id: uuid.UUID | None, values: dict | None):
    """S7: a transient copy of an item added in Simple, read as part of the version its
    draft was opened on (so dependencies by key resolve), with the draft's fields."""
    copy = RoadmapItem(**{a.key: getattr(row, a.key) for a in RoadmapItem.__mapper__.column_attrs})
    copy.roadmap_version_id = base_version_id
    for f, v in (values or {}).items():
        if f in FIELDS:
            setattr(copy, f, _typed(f, v))
    return copy


async def added_rows(db: AsyncSession, overlays: dict[uuid.UUID, dict[str, Any]]) -> list:
    """S7: the items added in Simple to the open drafts of the roadmaps in ``overlays``
    (those the reader sees), each placed on its draft's base version."""
    if not overlays:
        return []
    out = []
    for row, base in (
        await db.execute(
            select(RoadmapItem, SimpleDraft.base_version_id)
            .join(SimpleDraft, SimpleDraft.id == RoadmapItem.simple_draft_id)
            .where(
                SimpleDraft.status.in_(OPEN),
                SimpleDraft.document_id.in_(list(overlays)),
                RoadmapItem.roadmap_version_id.is_(None),
            )
        )
    ).all():
        out.append(placed(row, base, overlays[row.roadmap_document_id].get(str(row.id))))
    return out


async def drop_added(db: AsyncSession, d: SimpleDraft) -> None:
    """S7: an approved draft's added items live on in its version: their draft rows go,
    their date suggestions move to the published copies (same key, the draft's version)."""
    added = {
        r.item_key: r.id
        for r in await db.scalars(
            select(RoadmapItem).where(
                RoadmapItem.simple_draft_id == d.id, RoadmapItem.roadmap_version_id.is_(None)
            )
        )
    }
    if added and d.version_id is not None:
        for key, copy in (
            await db.execute(
                select(RoadmapItem.item_key, RoadmapItem.id).where(
                    RoadmapItem.roadmap_version_id == d.version_id,
                    RoadmapItem.item_key.in_(list(added)),
                )
            )
        ).all():
            await db.execute(
                update(RoadmapDateSuggestion)
                .where(RoadmapDateSuggestion.item_id == added[key])
                .values(item_id=copy)
            )
    await db.execute(
        delete(RoadmapItem).where(
            RoadmapItem.simple_draft_id == d.id, RoadmapItem.roadmap_version_id.is_(None)
        )
    )


# --------------------------------------------------------------------------- who


@dataclass
class Who:
    """The roadmaps' decider, required reviewers and owners (their tracks' owners)."""

    deciders: dict[uuid.UUID, uuid.UUID | None] = field(default_factory=dict)
    reviewers: dict[uuid.UUID, list[uuid.UUID]] = field(default_factory=dict)
    owners: dict[uuid.UUID, set[uuid.UUID]] = field(default_factory=dict)


async def who(db: AsyncSession, doc_ids: set[uuid.UUID]) -> Who:
    out = Who()
    if not doc_ids:
        return out
    for p in await db.scalars(
        select(DocumentReviewPolicy).where(DocumentReviewPolicy.document_id.in_(doc_ids))
    ):
        out.deciders[p.document_id] = p.decider_id
        out.reviewers[p.document_id] = list(p.mandatory_reviewer_ids or [])
    # A roadmap's owners own its tracks; a PRD's (a one-pager's draft, S5) own the tracks
    # it is the PRD of, as oracle.simple.one_pager.who reads them.
    for t in await db.scalars(
        select(ProductTrack).where(
            or_(
                ProductTrack.roadmap_document_id.in_(doc_ids),
                ProductTrack.prd_document_id.in_(doc_ids),
            ),
            ProductTrack.owner_id.is_not(None),
        )
    ):
        for doc in {t.roadmap_document_id, t.prd_document_id} & doc_ids:
            out.owners.setdefault(doc, set()).add(t.owner_id)
    return out


def _me(principal: Any) -> uuid.UUID | None:
    if principal is None or getattr(principal, "run_id", None) is not None:
        return None
    return getattr(principal, "user_id", None)


def can_edit(principal: Any, doc_id: uuid.UUID, w: Who) -> bool:
    """Who changes the roadmap directly (S3a's rule, oracle.simple.service.can_decide):
    an owner; its decider; with no decider, its owner while an approver or owner (D-a)."""
    me = _me(principal)
    if me is None:
        return False
    if has_role(principal.role, "owner"):
        return True
    decider = w.deciders.get(doc_id)
    if decider is not None:
        return decider == me
    return me in w.owners.get(doc_id, set()) and has_role(principal.role, "approver")


def sees(principal: Any, d: SimpleDraft, w: Who) -> bool:
    me = _me(principal)
    if me is None:
        return False
    if has_role(principal.role, "owner") or me == d.created_by or me in (d.participant_ids or []):
        return True
    doc = d.document_id
    return (
        me == w.deciders.get(doc)
        or me in w.reviewers.get(doc, [])
        or me in w.owners.get(doc, set())
    )


def _approver_of(principal: Any, d: SimpleDraft, w: Who) -> bool:
    """The draft's final approval: the decider's, with none an owner's or the roadmap's
    owner's."""
    me = _me(principal)
    decider = w.deciders.get(d.document_id)
    return me is not None and (
        me == decider if decider is not None else can_edit(principal, d.document_id, w)
    )


# --------------------------------------------------------------------------- reading


async def open_drafts(db: AsyncSession) -> list[SimpleDraft]:
    return list(
        await db.scalars(
            select(SimpleDraft).where(SimpleDraft.status.in_(OPEN)).order_by(SimpleDraft.created_at)
        )
    )


async def counts(db: AsyncSession, ds: list[SimpleDraft]) -> dict[uuid.UUID, int]:
    """Each draft's applied changes, not undone."""
    ids = [d.id for d in ds]
    out = dict.fromkeys(ids, 0)
    if not ids:
        return out
    rows = list(
        await db.scalars(
            select(SimpleChange).where(
                SimpleChange.draft_ids.overlap(ids), SimpleChange.status.in_(COUNTED)
            )
        )
    )
    undone = (
        set(
            await db.scalars(
                select(SimpleChange.undoes_id).where(
                    SimpleChange.undoes_id.in_([c.id for c in rows])
                )
            )
        )
        if rows
        else set()
    )
    for c in rows:
        if c.id in undone:
            continue
        for i in c.draft_ids:
            if i in out:
                out[i] += 1
    return out


async def _proposals(db: AsyncSession, doc_ids: set[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not doc_ids:
        return {}
    return dict(
        (
            await db.execute(
                select(SimpleChange.document_id, func.count())
                .where(SimpleChange.status == "proposed", SimpleChange.document_id.in_(doc_ids))
                .group_by(SimpleChange.document_id)
            )
        ).all()
    )


async def changes_in_review(db: AsyncSession, document_id: uuid.UUID) -> int:
    """The banner's count for one document: its open drafts' changes and open proposals."""
    ds = [d for d in await open_drafts(db) if d.document_id == document_id]
    return sum((await counts(db, ds)).values()) + (await _proposals(db, {document_id})).get(
        document_id, 0
    )


@dataclass
class Reader:
    """What one reader gets of the open drafts: the overlays of those they see (document
    id -> {item id -> fields}), the drafts' briefs, and the count of the rest."""

    overlays: dict[uuid.UUID, dict[str, Any]]
    visible: list[SimpleDraftBrief]
    changes_in_review: int


async def reader(db: AsyncSession, principal: Any) -> Reader:
    ds = await open_drafts(db)
    proposals = await _proposals(
        db,
        set(
            await db.scalars(
                select(SimpleChange.document_id).where(SimpleChange.status == "proposed").distinct()
            )
        )
        - {None},
    )
    w = await who(db, {d.document_id for d in ds} | set(proposals))
    n = await counts(db, ds)
    overlays: dict[uuid.UUID, dict[str, Any]] = {}
    visible: list[SimpleDraftBrief] = []
    hidden = 0
    seen_docs: set[uuid.UUID] = set()
    for d in ds:
        if sees(principal, d, w):
            overlays[d.document_id] = dict(d.overlay or {})
            seen_docs.add(d.document_id)
            visible.append(
                SimpleDraftBrief(
                    id=d.id, document_id=d.document_id, status=d.status, changes=n[d.id]
                )
            )  # type: ignore[arg-type]
        else:
            hidden += n[d.id]
    me = _me(principal)
    for doc, k in proposals.items():
        if doc in seen_docs:
            continue
        mine = me is not None and (
            has_role(principal.role, "owner")
            or me == w.deciders.get(doc)
            or me in w.reviewers.get(doc, [])
            or me in w.owners.get(doc, set())
        )
        if not mine:
            hidden += k
    return Reader(overlays, visible, hidden)


async def overlays_for(db: AsyncSession, principal: Any) -> dict[uuid.UUID, dict[str, Any]]:
    return (await reader(db, principal)).overlays


def _withdrawn():
    return DocumentVersion.notes.contains([{"code": WITHDRAWN}])


async def submitted_versions(db: AsyncSession) -> set[uuid.UUID]:
    """Versions submitted from drafts and not approved yet, and versions withdrawn from
    review: never what readers are shown."""
    return set(
        await db.scalars(
            select(SimpleDraft.version_id)
            .where(SimpleDraft.status == "submitted", SimpleDraft.version_id.is_not(None))
            .union(
                select(DocumentVersion.id).where(
                    DocumentVersion.approved_at.is_(None), _withdrawn()
                )
            )
        )
    )


async def effective(db: AsyncSession, rows: list[RoadmapItem]) -> dict[str, RoadmapItem]:
    """Each row as its roadmap's open draft has it (the stored values a change checks)."""
    docs = {r.roadmap_document_id for r in rows}
    ds = (
        {
            d.document_id: d
            for d in await db.scalars(
                select(SimpleDraft).where(
                    SimpleDraft.document_id.in_(docs), SimpleDraft.status.in_(OPEN)
                )
            )
        }
        if docs
        else {}
    )
    out = {}
    for r in rows:
        d = ds.get(r.roadmap_document_id)
        out[str(r.id)] = overlaid(r, (d.overlay or {}).get(str(r.id)) if d else None)
    return out


async def effective_row(db: AsyncSession, row: RoadmapItem) -> RoadmapItem:
    return (await effective(db, [row]))[str(row.id)]


# --------------------------------------------------------------------------- writing


async def link(db: AsyncSession, session: SimpleSession, d: SimpleDraft) -> None:
    """The session works on the draft; its starter takes part."""
    have = await db.scalar(
        select(SimpleSessionDraft.id).where(
            SimpleSessionDraft.session_id == session.id,
            SimpleSessionDraft.document_id == d.document_id,
        )
    )
    if have is None:
        db.add(SimpleSessionDraft(session_id=session.id, document_id=d.document_id, draft_id=d.id))
    if session.started_by not in (d.participant_ids or []):
        d.participant_ids = [*(d.participant_ids or []), session.started_by]
    await db.flush()


async def ensure(
    db: AsyncSession, session: SimpleSession, row: RoadmapItem, me: uuid.UUID
) -> SimpleDraft:
    """The roadmap's working draft, opened on the row's version when it has none; the
    session joins it. 409 while a submitted draft of the roadmap waits for approval."""
    doc = row.roadmap_document_id
    d = await db.scalar(
        select(SimpleDraft)
        .where(SimpleDraft.document_id == doc, SimpleDraft.status == "working")
        .with_for_update()
    )
    if d is None:
        waiting = await db.scalar(
            select(DocumentVersion.number)
            .join(SimpleDraft, SimpleDraft.version_id == DocumentVersion.id)
            .where(SimpleDraft.document_id == doc, SimpleDraft.status == "submitted")
        )
        if waiting is not None:
            raise DraftError(
                409,
                f"This roadmap's draft is in review as version {waiting}: changes wait until "
                "it is approved",
            )
        d = SimpleDraft(
            document_id=doc,
            base_version_id=row.roadmap_version_id,
            status="working",
            overlay={},
            created_by=me,
            participant_ids=[me],
        )
        db.add(d)
        await db.flush()
    await link(db, session, d)
    return d


def _keys(c: SimpleChange, values: dict[str, Any], fixes: tuple[str, ...]) -> dict[str, dict]:
    if c.op in fixes:
        return dict(values)
    return {str(c.target["item_id"]): values}


def simulate(
    c: SimpleChange,
    values: dict[str, Any],
    rows: dict[str, RoadmapItem],
    overlays: dict[uuid.UUID, dict[str, Any]],
    fixes: tuple[str, ...],
    write: Any,
) -> dict[uuid.UUID, dict[str, Any]]:
    """The overlays as if the change applied (a proposal's flags), without writing."""
    out = {k: dict(v) for k, v in overlays.items()}
    for k, v in _keys(c, values, fixes).items():
        row = rows[k]
        ov = out.setdefault(row.roadmap_document_id, {})
        cur = overlaid(row, ov.get(k) or {f: _json(f, getattr(row, f)) for f in FIELDS})
        if cur is row:
            cur = overlaid(row, snapshot(row))
        write(cur, v, c.target)
        ov[k] = snapshot(cur)
    return out


async def write_items(
    db: AsyncSession,
    c: SimpleChange,
    values: dict[str, Any],
    session: SimpleSession,
    fixes: tuple[str, ...],
    write: Any,
    undo: bool = False,
) -> list[uuid.UUID]:
    """Write ``values`` (a change's after, or its before for an undo) into the drafts of
    the items' roadmaps; the drafts written."""
    keyed = _keys(c, values, fixes)
    rows = {
        str(r.id): r
        for r in await db.scalars(
            select(RoadmapItem).where(RoadmapItem.id.in_([uuid.UUID(k) for k in keyed]))
        )
    }
    out: list[uuid.UUID] = []
    for k, v in keyed.items():
        row = rows[k]
        if undo:
            d = await db.scalar(
                select(SimpleDraft)
                .where(
                    SimpleDraft.document_id == row.roadmap_document_id,
                    SimpleDraft.id.in_(c.draft_ids or []),
                )
                .with_for_update()
            )
            if d is None or d.status != "working":
                raise DraftError(
                    409, "Its draft was submitted: undo works only inside a working draft"
                )
            await link(db, session, d)
        else:
            d = await ensure(db, session, row, session.started_by)
        cur = overlaid(row, (d.overlay or {}).get(k) or snapshot(row))
        write(cur, v, c.target)
        d.overlay = {**(d.overlay or {}), k: snapshot(cur)}
        if d.id not in out:
            out.append(d.id)
    await db.flush()
    return out


# --------------------------------------------------------------------------- out


async def _refs(db: AsyncSession, ds: list[SimpleDraft]) -> tuple[dict, dict]:
    docs = (
        {
            d.id: d
            for d in await db.scalars(
                select(Document).where(Document.id.in_({x.document_id for x in ds}))
            )
        }
        if ds
        else {}
    )
    vids = {v for x in ds for v in (x.base_version_id, x.version_id) if v}
    numbers = (
        dict(
            (
                await db.execute(
                    select(DocumentVersion.id, DocumentVersion.number).where(
                        DocumentVersion.id.in_(vids)
                    )
                )
            ).all()
        )
        if vids
        else {}
    )
    return docs, numbers


async def _logs(db: AsyncSession, ds: list[SimpleDraft]) -> dict[uuid.UUID, list]:
    """D-d: each draft's applied changes, not undone, oldest first: who, when, and whether
    in a meeting."""
    ids = [d.id for d in ds]
    out: dict[uuid.UUID, list] = {i: [] for i in ids}
    if not ids:
        return out
    rows = list(
        await db.scalars(
            select(SimpleChange)
            .where(SimpleChange.draft_ids.overlap(ids), SimpleChange.status.in_(COUNTED))
            .order_by(SimpleChange.at, SimpleChange.id)
        )
    )
    if not rows:
        return out
    undone = set(
        await db.scalars(
            select(SimpleChange.undoes_id).where(SimpleChange.undoes_id.in_([c.id for c in rows]))
        )
    )
    rows = [c for c in rows if c.id not in undone]
    sids = {c.session_id for c in rows if c.session_id}
    kinds = (
        dict(
            (
                await db.execute(
                    select(SimpleSession.id, SimpleSession.kind).where(SimpleSession.id.in_(sids))
                )
            ).all()
        )
        if sids
        else {}
    )
    people = {c.by for c in rows}
    names = {
        u.id: u.name or u.email for u in await db.scalars(select(User).where(User.id.in_(people)))
    }
    for c in rows:
        kind = kinds.get(c.session_id) if c.session_id else None
        try:
            item_id = uuid.UUID(str(c.target.get("item_id"))) if c.target.get("item_id") else None
        except ValueError:
            item_id = None
        entry = SimpleDraftChange(
            id=c.id, op=c.op, item_id=item_id, by=c.by, by_name=names.get(c.by, "someone"),
            at=c.at, session_kind=kind, in_meeting=kind == "meeting",  # type: ignore[arg-type]
        )  # fmt: skip
        for i in c.draft_ids:
            if i in out:
                out[i].append(entry)
    return out


async def outs(
    db: AsyncSession, principal: Any, ds: list[SimpleDraft], blocked: list[str] | None = None
) -> list[SimpleDraftOut]:
    w = await who(db, {d.document_id for d in ds})
    docs, numbers = await _refs(db, ds)
    n = await counts(db, ds)
    logs = await _logs(db, ds)
    me = _me(principal)
    out = []
    for d in ds:
        doc = docs[d.document_id]
        reviewer = me is not None and me in w.reviewers.get(d.document_id, [])
        out.append(
            SimpleDraftOut(
                id=d.id,
                document=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
                status=d.status,
                base_version=numbers.get(d.base_version_id),  # type: ignore[arg-type]
                version=numbers.get(d.version_id),
                created_by=d.created_by,
                created_at=d.created_at,
                participant_ids=list(d.participant_ids or []),
                changes=n.get(d.id, 0),
                submitted_at=d.submitted_at,
                submitted_by=d.submitted_by,
                decider_approved=d.decider_approval is not None,
                waiting_on=list(d.waiting_on or []),
                approved_at=d.approved_at,
                blocked_by=blocked or [],
                can_submit=d.status == "working" and can_edit(principal, d.document_id, w),
                can_resume=d.status == "working"
                and me is not None
                and me in (d.created_by, w.deciders.get(d.document_id)),
                can_approve=d.status == "submitted"
                and (_approver_of(principal, d, w) or (reviewer and me in (d.waiting_on or []))),
                change_log=logs.get(d.id, []),
                can_withdraw=d.status == "submitted"
                and me is not None
                and (me == d.created_by or _approver_of(principal, d, w)),
            )
        )
    return out


async def listing(db: AsyncSession, principal: Any) -> list[SimpleDraftOut]:
    """The open drafts the caller may see, oldest first."""
    ds = await open_drafts(db)
    w = await who(db, {d.document_id for d in ds})
    return await outs(db, principal, [d for d in ds if sees(principal, d, w)])


async def _get(db: AsyncSession, principal: Any, draft_id: uuid.UUID) -> tuple[SimpleDraft, Who]:
    d = await db.get(SimpleDraft, draft_id, with_for_update=True)
    w = await who(db, {d.document_id} if d else set())
    if d is None or not sees(principal, d, w):
        raise DraftError(404, "No such draft")
    return d, w


async def one(db: AsyncSession, principal: Any, draft_id: uuid.UUID) -> SimpleDraftOut:
    d, _ = await _get(db, principal, draft_id)
    return (await outs(db, principal, [d]))[0]


# --------------------------------------------------------------------------- submit


OP_WORDS = {
    "move_dates": "New dates for",
    "accept_date_suggestion": "Accepted Oracle's dates for",
    "change_horizon": "Moved",
    "reorder": "Reordered",
    "cut": "Cut",
    "restore": "Restored",
    "edit_title": "Renamed",
    "edit_outcome": "New outcome for",
    "accept_risk": "Accepted a risk on",
    "shift_dependents": "Moved the dependents of",
    "move_dependency": "Moved the dependency of",
    "confirm_item": "Confirmed",
    "edit_line": "New wording for",
    "add_key_date": "Added the key date",
    "edit_key_date": "Changed the key date",
    "remove_key_date": "Removed the key date",
    "add_item": "Added",
    "merge_item": "Merged",
    "keep_both": "Kept beside its look-alikes:",
}


async def _live_changes(db: AsyncSession, d: SimpleDraft) -> list[SimpleChange]:
    rows = list(
        await db.scalars(
            select(SimpleChange)
            .where(SimpleChange.draft_ids.contains([d.id]), SimpleChange.status.in_(COUNTED))
            .order_by(SimpleChange.at, SimpleChange.id)
        )
    )
    undone = (
        set(
            await db.scalars(
                select(SimpleChange.undoes_id).where(
                    SimpleChange.undoes_id.in_([c.id for c in rows])
                )
            )
        )
        if rows
        else set()
    )
    return [c for c in rows if c.id not in undone]


async def submit(db: AsyncSession, principal: Principal, draft_id: uuid.UUID) -> SimpleDraftOut:
    """The draft becomes the roadmap's next version, in review under its policy (the
    caller commits)."""
    from oracle.docs import service as docs_service
    from oracle.roadmap import changeset, schedule, views
    from oracle.roadmap import items as items_mod

    d, w = await _get(db, principal, draft_id)
    if not can_edit(principal, d.document_id, w):
        raise DraftError(
            403, "Only an owner or the roadmap's decider (with none, its owner) submits"
        )
    if d.status != "working":
        raise DraftError(409, f"This draft is {d.status} already")
    live = await _live_changes(db, d)
    if not live:
        raise DraftError(422, "Nothing to submit: the draft has no changes")
    document = await db.get(Document, d.document_id)
    if document.kind != "roadmap":
        return await _submit_sections(db, principal, d, document, live)
    base = await db.get(DocumentVersion, d.base_version_id) if d.base_version_id else None
    approved = await changeset.approved_version(db, document)
    latest = await db.scalar(
        select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == document.id)
    )
    # Versions withdrawn from review are not the roadmap's: the draft's base is still its own.
    newest = await db.scalar(
        select(func.max(DocumentVersion.number)).where(
            DocumentVersion.document_id == document.id, ~_withdrawn()
        )
    )
    if base is None or (approved.id != base.id if approved else newest != base.number):
        raise DraftError(
            409,
            "The published roadmap changed since this draft was opened: its changes were made "
            f"on version {base.number if base else '?'}",
        )
    base_rows = await views.version_items(db, base)
    # S7: the items added in Simple (on no version until now), unless merged away.
    added = [
        r
        for r in await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.simple_draft_id == d.id, RoadmapItem.roadmap_version_id.is_(None))
            .order_by(RoadmapItem.position, RoadmapItem.item_key)
        )
    ]
    titles = {str(r.id): r.title for r in [*base_rows, *added]}
    lines = [f"Changed in Simple on version {base.number}:", ""]
    for c in live:
        kd = None
        if "key_date" in c.after:
            kd = c.after.get("key_date") or c.before.get("key_date")
        what = (
            f"'{kd['name']}'"
            if isinstance(kd, dict)
            else titles.get(str(c.target.get("item_id")), "an item")
        )
        lines.append(f"- {OP_WORDS.get(c.op, c.op)} {what}")
    markdown = await changeset._markdown(db, base, "\n".join(lines))
    result = await docs_service.import_draft(
        db,
        document.slug,
        markdown,
        principal,
        kind="roadmap",
        source_version_id=base.source_version_id,
        base_version=latest,
        cause="simple_draft",
        commit=False,
    )
    version = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document.id,
            DocumentVersion.number == result.version.number,
        )
    )
    await db.execute(delete(RoadmapItem).where(RoadmapItem.roadmap_version_id == version.id))
    overlay = d.overlay or {}
    bases = {
        p: await schedule.verified_bases(db, p)
        for p in {r.prd_document_id for r in [*base_rows, *added]}
    }
    for old in [*base_rows, *added]:
        cur = overlaid(old, overlay.get(str(old.id)))
        if old in added and cur.merged_into:
            continue
        note = (
            f"from version {base.number}, changed in Simple"
            if str(old.id) in overlay
            else f"from version {base.number}"
        )
        if old in added:
            note = f"added in Simple on version {base.number}"
        if cur.note and cur.note != old.note and (old in added or str(old.id) in overlay):
            # Notes a merge moved onto the item (S7).
            note += "\n" + (cur.note[len(old.note or "") :] if cur.note.startswith(old.note or "")
                            else cur.note).strip()  # fmt: skip
        fields = {c: getattr(cur, c) for c in items_mod.COPIED}
        fields.update(
            {f: getattr(cur, f) for f in FIELDS},
            draft=cur.draft,
            milestone=items_mod.recheck_date(
                old.milestone, bases[old.prd_document_id], old.item_key, cur.horizon
            ),
            note=note,
        )
        db.add(
            RoadmapItem(roadmap_document_id=document.id, roadmap_version_id=version.id, **fields)
        )
    return await _in_review(db, principal, d, document, base, version, live)


async def _submit_sections(
    db: AsyncSession, principal: Principal, d: SimpleDraft, document: Document, live: list
) -> SimpleDraftOut:
    """S5: a PRD's draft (one-pager lines as section patches) becomes its next version:
    the published version's markdown with every patched section, imported as a person's
    draft would be, then in review under its policy."""
    from oracle.docs import service as docs_service
    from oracle.simple import one_pager

    base = await db.get(DocumentVersion, d.base_version_id) if d.base_version_id else None
    current = await one_pager.published(db, document)
    if base is None or current.id != base.id:
        raise DraftError(
            409,
            "The published PRD changed since this draft was opened: its changes were made on "
            f"version {base.number if base else '?'}",
        )
    latest = await db.scalar(
        select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == document.id)
    )
    secs = list(
        await db.scalars(
            select(Section).where(Section.version_id == base.id).order_by(Section.ordinal)
        )
    )
    try:
        markdown = one_pager.patched_markdown(base, secs, (d.overlay or {}).get("sections") or {})
    except one_pager.ChangeError as e:
        raise DraftError(e.status, e.detail) from e
    result = await docs_service.import_draft(
        db, document.slug, markdown, principal, kind=document.kind, base_version=latest,
        cause="simple_draft", commit=False,
    )  # fmt: skip
    version = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document.id,
            DocumentVersion.number == result.version.number,
        )
    )
    return await _in_review(db, principal, d, document, base, version, live)


async def _in_review(
    db: AsyncSession,
    principal: Principal,
    d: SimpleDraft,
    document: Document,
    base: DocumentVersion,
    version: DocumentVersion,
    live: list,
) -> SimpleDraftOut:
    from oracle.review.state import effective_policy

    policy = await effective_policy(db, document)
    now = company_time.now()
    d.status, d.version_id, d.submitted_at, d.submitted_by = (
        "submitted",
        version.id,
        now,
        principal.user_id,
    )
    d.waiting_on = list(policy.mandatory_reviewer_ids)
    d.reminders = {}
    for sd in await db.scalars(
        select(SimpleSessionDraft).where(SimpleSessionDraft.draft_id == d.id)
    ):
        sd.draft_version_id = version.id
    await db.flush()
    await audit.record(
        db,
        principal,
        "simple_draft.submitted",
        "simple_draft",
        d.id,
        data={
            "document_id": str(document.id),
            "base_version": base.number,
            "version": version.number,
            "changes": [str(c.id) for c in live],
        },
    )
    return (await outs(db, principal, [d]))[0]


# --------------------------------------------------------------------------- approve


async def principal_for(db: AsyncSession, tenant_id: uuid.UUID, user_id: uuid.UUID) -> Principal:
    user = await db.get(User, user_id)
    if user is None or user.disabled_at is not None:
        raise DraftError(403, "That person is not an active member")
    return Principal(tenant_id=tenant_id, kind="user", role=user.role, user_id=user.id)  # type: ignore[arg-type]


async def _review_error(coro):
    from oracle.review.service import ReviewError

    try:
        return await coro
    except ReviewError as e:
        raise DraftError(403 if e.kind == "forbidden" else 409, e.message) from e


async def _reviewer_approves(
    db: AsyncSession, rp: Principal, document: Document, version: DocumentVersion
) -> None:
    """A required reviewer's approval: their approval of every section of the version,
    as Studio records it (``review_section``)."""
    from oracle.review.service import latest_verdicts, review_section

    keys = list(
        await db.scalars(
            select(Section.section_key)
            .where(Section.version_id == version.id)
            .order_by(Section.ordinal)
        )
    )
    done = {
        k
        for k, r in (await latest_verdicts(db, version.id)).items()
        if r.reviewer_id == rp.user_id and r.verdict == "approved"
    }
    for k in keys:
        if k not in done:
            await _review_error(
                review_section(db, rp, document.slug, version.number, k, "approved", SECTION_NOTE)
            )


async def _settle(db: AsyncSession, d: SimpleDraft, tenant_id: uuid.UUID) -> list[str]:
    """Who is still to approve; the version's approval once the decider's is in and
    nothing else blocks it. Returns what else holds it back."""
    from oracle.review.publish import review_problems
    from oracle.review.service import approve_version
    from oracle.review.state import section_states
    from oracle.simple import key_dates

    if d.status != "submitted":
        # Settled already (approved in the Detailed view, or returned to working).
        return []
    document = await db.get(Document, d.document_id)
    version = await db.get(DocumentVersion, d.version_id)
    states = await section_states(db, document, version)
    blockers, _, _, _ = await review_problems(db, document, version, states)
    d.waiting_on = list(
        dict.fromkeys(i for b in blockers if b.code == "mandatory_reviewer_pending" for i in b.ids)
    )
    other = [b.message for b in blockers if b.code not in APPROVAL_CODES]
    if d.decider_approval is not None and not d.waiting_on and not other:
        dp = await principal_for(db, tenant_id, uuid.UUID(d.decider_approval["by"]))
        await _review_error(approve_version(db, dp, document.slug, version.number))
        if d.status != "submitted":
            # approve_version settled it (on_version_approved).
            await db.flush()
            return other
        d.status, d.approved_at = "approved", company_time.now()
        await key_dates.publish(db, d)
        await drop_added(db, d)
        await audit.record(
            db,
            dp,
            "simple_draft.approved",
            "simple_draft",
            d.id,
            data={"version": version.number, "decider_approval": d.decider_approval},
        )
    await db.flush()
    return other


async def _approve(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    d: SimpleDraft,
    w: Who,
    actor: Principal,
    present: list[uuid.UUID],
    session_id: uuid.UUID | None,
) -> list[str]:
    if d.status != "submitted":
        raise DraftError(409, f"This draft is {d.status}: only a submitted draft is approved")
    document = await db.get(Document, d.document_id)
    version = await db.get(DocumentVersion, d.version_id)
    reviewers = w.reviewers.get(d.document_id, [])
    is_approver = _approver_of(actor, d, w)
    if not is_approver and actor.user_id not in reviewers:
        raise DraftError(403, "Only the decider and the required reviewers approve this draft")
    for r in dict.fromkeys([*([actor.user_id] if actor.user_id in reviewers else []), *present]):
        if r in reviewers:
            rp = actor if r == actor.user_id else await principal_for(db, tenant_id, r)
            await _reviewer_approves(db, rp, document, version)
    if is_approver:
        d.decider_approval = {
            "by": str(actor.user_id),
            "at": company_time.now().isoformat(),
            "session_id": str(session_id) if session_id else None,
            "present": [str(p) for p in present],
        }
    await audit.record(
        db,
        actor,
        "simple_draft.approval",
        "simple_draft",
        d.id,
        data={
            "version": version.number,
            "decider": is_approver,
            "present": [str(p) for p in present],
            "session_id": str(session_id) if session_id else None,
        },
    )
    return await _settle(db, d, tenant_id)


async def approve(db: AsyncSession, principal: Principal, draft_id: uuid.UUID) -> SimpleDraftOut:
    """The caller's approval: the decider's (held until the required reviewers have
    approved) or a required reviewer's (the caller commits)."""
    d, w = await _get(db, principal, draft_id)
    other = await _approve(db, principal.tenant_id, d, w, principal, [], None)
    return (await outs(db, principal, [d], other))[0]


async def approve_in_meeting(
    db: AsyncSession,
    session: SimpleSession,
    decider: uuid.UUID,
    present_reviewer_ids: list[uuid.UUID],
) -> SimpleMeetingApproval:
    """S8: the decider's Approve in a meeting, for every draft the meeting's session
    worked on (a working one is submitted first): records the decider's approval and the
    approvals of the required reviewers present; every absent required reviewer gets an
    Inbox request, and the version is approved only once they all have (owner answer).
    A roadmap the caller does not decide is left for its own decider and reported in
    ``not_approved`` (#730 review), never a 403 for the whole call. The caller commits."""
    dp = await principal_for(db, session.tenant_id, decider)
    ds = list(
        await db.scalars(
            select(SimpleDraft)
            .join(SimpleSessionDraft, SimpleSessionDraft.draft_id == SimpleDraft.id)
            .where(SimpleSessionDraft.session_id == session.id, SimpleDraft.status.in_(OPEN))
            .order_by(SimpleDraft.created_at)
            .with_for_update(of=SimpleDraft)
        )
    )
    out, skipped = [], []
    docs, _ = await _refs(db, ds)
    for d in ds:
        w = await who(db, {d.document_id})
        if not _approver_of(dp, d, w):
            doc = docs[d.document_id]
            skipped.append(
                SimpleNotApproved(
                    draft_id=d.id,
                    document=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
                    reason="Only the roadmap's decider approves it",
                )
            )
            continue
        if d.status == "working":
            await submit(db, dp, d.id)
        other = await _approve(
            db, session.tenant_id, d, w, dp, list(present_reviewer_ids), session.id
        )
        out.extend(await outs(db, dp, [d], other))
    return SimpleMeetingApproval(drafts=out, not_approved=skipped)


# --------------------------------------------------------------------------- settling


async def _return_to_working(
    db: AsyncSession, d: SimpleDraft, actor: Any, why: str, event: str
) -> None:
    """A submitted draft goes back to working (S3b-1): its overlay and changes stay (undo
    works again in their open sessions); its version is marked withdrawn."""
    version = await db.get(DocumentVersion, d.version_id) if d.version_id else None
    if version is not None:
        version.notes = [
            *(version.notes or []),
            {
                "code": WITHDRAWN,
                "message": f"Withdrawn from review in Simple: {why}",
                "draft_id": str(d.id),
                "at": company_time.now().isoformat(),
            },
        ]
    number = version.number if version is not None else None
    d.status, d.version_id, d.submitted_at, d.submitted_by = "working", None, None, None
    d.decider_approval, d.waiting_on = None, []
    for sd in await db.scalars(
        select(SimpleSessionDraft).where(SimpleSessionDraft.draft_id == d.id)
    ):
        sd.draft_version_id = None
    await db.flush()
    await audit.record(db, actor, event, "simple_draft", d.id,
                       data={"version": number, "why": why})  # fmt: skip


async def _submitted_for(db: AsyncSession, version_id: uuid.UUID) -> SimpleDraft | None:
    return await db.scalar(
        select(SimpleDraft)
        .where(SimpleDraft.version_id == version_id, SimpleDraft.status == "submitted")
        .with_for_update()
    )


async def withdraw(db: AsyncSession, principal: Principal, draft_id: uuid.UUID) -> SimpleDraftOut:
    """Its author or the decider takes a submitted draft back to working (the caller
    commits)."""
    d, w = await _get(db, principal, draft_id)
    if principal.user_id != d.created_by and not _approver_of(principal, d, w):
        raise DraftError(403, "Only the draft's author or the roadmap's decider withdraws it")
    if d.status != "submitted":
        raise DraftError(409, f"This draft is {d.status}: only a submitted draft is withdrawn")
    await _return_to_working(db, d, principal, "withdrawn by its author or decider",
                             "simple_draft.withdrawn")  # fmt: skip
    return (await outs(db, principal, [d]))[0]


async def on_version_approved(db: AsyncSession, principal: Any, version: DocumentVersion) -> None:
    """``approve_version`` approved a roadmap version: the Simple draft it came from is
    approved too (the ordinary approval path settles it, S3b-1), and its key dates are
    published."""
    from oracle.simple import key_dates

    d = await _submitted_for(db, version.id)
    if d is None:
        return
    d.status, d.approved_at, d.waiting_on = "approved", company_time.now(), []
    await key_dates.publish(db, d)
    await drop_added(db, d)
    await db.flush()
    await audit.record(db, principal, "simple_draft.approved", "simple_draft", d.id,
                       data={"version": version.number, "via": "approve_version",
                             "decider_approval": d.decider_approval})  # fmt: skip


async def on_section_verdict(
    db: AsyncSession, principal: Any, version: DocumentVersion, verdict: str
) -> None:
    """A section verdict on a version submitted from a Simple draft (S3b-1): a verdict
    other than approved (changes requested, a rejection) returns the draft to working; an
    approval settles it once nothing blocks (the decider approved in Simple)."""
    d = await _submitted_for(db, version.id)
    if d is None:
        return
    if verdict != "approved":
        await _return_to_working(
            db, d, principal, f"a reviewer's verdict: {verdict.replace('_', ' ')}",
            "simple_draft.returned",
        )  # fmt: skip
        return
    await _settle(db, d, principal.tenant_id)


async def withdrawn_message(db: AsyncSession, version: DocumentVersion) -> str | None:
    """Why ``version`` can't be approved when it was withdrawn from review, else None."""
    if version.approved_at is not None or not any(
        isinstance(n, dict) and n.get("code") == WITHDRAWN for n in version.notes or []
    ):
        return None
    return (
        f"Version {version.number} was withdrawn from review in Simple: it can't be approved. "
        "Its changes are back in the roadmap's working draft; submit it again."
    )


# --------------------------------------------------------------------------- resume


async def resume(db: AsyncSession, principal: Principal, draft_id: uuid.UUID):
    """A new editing session on the draft (the caller's open one, when they have one),
    for its author or the decider (the caller commits)."""
    from oracle.simple import changes

    d, w = await _get(db, principal, draft_id)
    if principal.user_id not in (d.created_by, w.deciders.get(d.document_id)):
        raise DraftError(403, "Only the draft's author or the roadmap's decider resumes it")
    if d.status != "working":
        raise DraftError(409, f"This draft is {d.status}: only a working draft resumes")
    s = await changes.start_session(db, principal, "editing")
    await link(db, s, d)
    await audit.record(
        db, principal, "simple_draft.resumed", "simple_draft", d.id, data={"session_id": str(s.id)}
    )
    return s, (await outs(db, principal, [d]))[0]


# --------------------------------------------------------------------------- inbox


async def inbox_rows(db: AsyncSession, principal: Any, seen: Any) -> list[InboxSimpleApproval]:
    """Versions from Simple drafts waiting for my approval as a required reviewer."""
    me = _me(principal)
    if me is None or getattr(principal, "run_token_id", None) is not None:
        return []
    ds = list(
        await db.scalars(
            select(SimpleDraft)
            .where(SimpleDraft.status == "submitted", SimpleDraft.waiting_on.contains([me]))
            .order_by(SimpleDraft.submitted_at)
        )
    )
    if not ds:
        return []
    docs, numbers = await _refs(db, ds)
    return [
        InboxSimpleApproval(
            draft_id=d.id,
            document=SimpleDocRef(
                id=docs[d.document_id].id,
                slug=docs[d.document_id].slug,
                title=docs[d.document_id].title,
            ),
            version=numbers.get(d.version_id),
            submitted_by=d.submitted_by,
            submitted_at=d.submitted_at,
            decider_approved=d.decider_approval is not None,
            state="new" if seen is None or (d.submitted_at and d.submitted_at > seen) else "open",
        )
        for d in ds
    ]
