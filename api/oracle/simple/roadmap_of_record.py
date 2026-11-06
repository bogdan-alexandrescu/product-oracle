"""prd-reads-working-draft (production, Nov 6): the company roadmap a PRD's run follows.

The owner edits the company roadmap in Simple (renames, dates, goals, done marks, Delete
to Trash, Add an item, the PRD an item belongs to, its dependencies); those edits live in
the roadmap's working draft (oracle.simple.drafts) until it is sent for review and
published. A PRD's run (Baseline to PRD, its Regenerate, Build next draft) used to see only
the published version and the approved PRD versions, so it undid those edits. It now reads
the roadmap of record (:func:`read`):

- **Which roadmap**: the company's one roadmap (oracle.roadmap.company.active: no name to
  give, one company, one roadmap). Its open draft when one holds edits newer than the
  published version, read exactly as Simple shows it to the owner
  (oracle.simple.service.load with the draft's overlay: its renames, dates, goals, PRDs,
  done marks, cuts, dependencies and the items added in it); else the published version.
- **Trash**: items in Trash are read apart (every other read leaves them out), so the run
  is told to leave them out of the PRD.
- **Its words**: :attr:`OfRecord.label` says which roadmap was read, month first in the
  company's time zone: "Company roadmap, working draft (edited Nov 5, 2026, 11:40 PM
  PST)" or "Company roadmap v7 (published Nov 4)". The run keeps it (``roadmap_read``,
  shown on the run page) and the prompt starts with it.
- **New items**: an item added in the draft without an F-code is flagged "Not in the
  Ground Truth", never refused.
"""

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.docs.models import DocumentVersion
from oracle.roadmap import company
from oracle.simple.models import SimpleChange, SimpleDraft

NAME = "Company roadmap"
NOT_IN_GROUND_TRUTH = "Not in the Ground Truth"
# The steps of a PRD's run that decide its features and write it.
# The engineering steps read it too, so their dates start from the owner's.
SEGMENTS = ("feature_set", "eng_review", "priority", "prd_draft", "eng_dates", "next_draft")
FLOWS = ("baseline_to_prd", "feedback_loop")


@dataclass
class Item:
    key: str
    code: str | None
    title: str
    start: date | None
    end: date | None
    goal: str | None
    prd_id: uuid.UUID | None
    prd: str | None
    # planned, in_progress, done, cut or draft (an added item waiting for its owner).
    status: str
    depends_on: list[str] = field(default_factory=list)
    # Added in the working draft (on no published version yet).
    new: bool = False

    @property
    def name(self) -> str:
        """``F-12 Weekly digest email``: the name with its code."""
        return f"{self.code} {self.title}" if self.code else self.title


@dataclass
class OfRecord:
    document_id: uuid.UUID
    label: str
    draft: bool
    items: list[Item]
    # Items in Trash: (key, name).
    trashed: list[tuple[str, str]]
    # The PRD each item in Trash belongs to, by key.
    trashed_prd: dict[str, uuid.UUID | None] = field(default_factory=dict)

    def under(self, prd_id: uuid.UUID | None) -> list[Item]:
        return [i for i in self.items if prd_id is not None and i.prd_id == prd_id]


def _day(d: date | None) -> str:
    return company_time.calendar_day_with_year(d) if d else "no date"


async def _open_draft(db: AsyncSession, doc_id: uuid.UUID) -> SimpleDraft | None:
    from oracle.simple.drafts import OPEN

    return await db.scalar(
        select(SimpleDraft)
        .where(SimpleDraft.document_id == doc_id, SimpleDraft.status.in_(OPEN))
        .order_by(SimpleDraft.created_at.desc())
        .limit(1)
    )


async def _edited_at(db: AsyncSession, d: SimpleDraft) -> datetime | None:
    """When the draft was last edited: its last change; None when it holds no edit."""
    at = await db.scalar(
        select(func.max(SimpleChange.at)).where(SimpleChange.draft_ids.contains([d.id]))
    )
    if at is not None:
        return at
    return d.created_at if d.overlay else None


async def _published(db: AsyncSession, doc_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == doc_id, DocumentVersion.approved_at.is_not(None))
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _latest(db: AsyncSession, doc_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == doc_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _sees(db: AsyncSession, d: SimpleDraft, reader: Any) -> bool:
    """Whether ``reader`` (a user id; True: Oracle itself) may see the draft, by the
    drafts' own rule (oracle.simple.drafts.sees: owners, its participants, the roadmap's
    decider, reviewers and owners)."""
    from oracle.simple import drafts

    if reader is True:
        return True
    if not isinstance(reader, uuid.UUID):
        return False
    try:
        principal = await drafts.principal_for(db, d.tenant_id, reader)
    except drafts.DraftError:
        return False
    return drafts.sees(principal, d, await drafts.who(db, {d.document_id}))


async def read(db: AsyncSession, *, reader: Any = True) -> OfRecord | None:
    """The company roadmap of record (module doc); None when the company has none.
    ``reader``: whose eyes read the draft (a user id: the draft only when they may see it,
    else the published version; None: nobody's, the published version)."""
    from oracle.simple import drafts, service, trash_items

    doc = await company.active(db)
    if doc is None:
        return None
    zone = await company_time.company_time_zone(db)
    published = await _published(db, doc.id)
    d = await _open_draft(db, doc.id)
    if d is not None and not await _sees(db, d, reader):
        d = None
    edited = await _edited_at(db, d) if d is not None else None
    use_draft = (
        d is not None
        and edited is not None
        and (published is None or published.approved_at is None or edited > published.approved_at)
    )
    if use_draft:
        assert d is not None and edited is not None
        state = "working draft" if d.status == "working" else "draft in review"
        label = f"{NAME}, {state} (edited {company_time.stamp(edited, zone)})"
    elif published is not None and published.approved_at is not None:
        label = (
            f"{NAME} v{published.number} "
            f"(published {company_time.day_in_words(published.approved_at, zone)})"
        )
    else:
        latest = await _latest(db, doc.id)
        label = f"{NAME} v{latest.number} (not published yet)" if latest else f"{NAME} (empty)"
    overlays = {doc.id: dict(d.overlay or {})} if use_draft and d is not None else None
    got = await service.load(db, overlays)
    added = {a.id for a, _ in await drafts.added_raw(db, overlays)} if overlays else set()
    entries = [
        e for e in got.entries if e.row.roadmap_document_id == doc.id and e.status != "merged"
    ]
    await service.item_codes(db, entries)
    by_id = {e.row.id: e for e in entries}
    items: list[Item] = []
    for e in entries:
        row = e.row
        items.append(
            Item(
                key=row.item_key,
                code=e.code,
                title=row.title,
                start=e.resolved.start.date if not e.resolved.start.estimated else row.start_date,
                end=e.resolved.end.date if not e.resolved.end.estimated else row.end_date,
                goal=e.goal.title if e.goal is not None else None,
                prd_id=row.prd_document_id,
                prd=e.prd.title if e.prd is not None else None,
                status=e.status,
                depends_on=[_name(by_id[i]) for i in e.depends_on if i in by_id]
                or list(row.depends_on or []),
                new=row.id in added,
            )
        )
    in_trash = {key: (title, prd) for key, title, prd in await trash_items.trashed_rows(db, doc.id)}
    trashed = sorted((key, title) for key, (title, _) in in_trash.items())
    trashed_prd = {key: prd for key, (_, prd) in in_trash.items()}
    return OfRecord(doc.id, label, use_draft, items, trashed, trashed_prd)


def _name(e) -> str:
    return f"{e.code} {e.row.title}" if e.code else e.row.title


def _line(i: Item, *, own: bool, unseen: frozenset[str] = frozenset()) -> str:
    bits = [f"{_day(i.start)} to {_day(i.end)}" if i.start or i.end else "no dates"]
    if i.goal:
        bits.append(f"goal: {i.goal}")
    if not own:
        bits.append(f"PRD: {i.prd or 'none'}")
    status = {"done": "DONE (mark it done)", "cut": "cut (not now)", "draft": "draft"}.get(i.status)
    if status:
        bits.append(status)
    depends_on = [n for n in i.depends_on if n not in unseen]
    if depends_on:
        bits.append("depends on " + ", ".join(depends_on))
    else:
        bits.append("depends on nothing")
    if i.new and not i.code:
        bits.append(f"{NOT_IN_GROUND_TRUTH} (new, no F-code: keep it and flag it)")
    elif i.new:
        bits.append("new")
    return f"- {i.name} [key {i.key}]: " + "; ".join(bits)


def prompt_lines(
    record: OfRecord | None, prd_id: uuid.UUID | None, hidden: Any = None
) -> list[str]:
    """What a PRD's run is told of the roadmap of record (module doc). ``hidden``: what a
    commenter may not see, for a run that reads as a member (oracle.docs.visibility.Hidden):
    the items of a PRD it hides, or whose line names something it hides, are left out, and
    so are their names in other items' dependencies."""
    if record is None:
        return []
    items = record.items
    trashed = record.trashed
    unseen: frozenset[str] = frozenset()
    if hidden is not None:
        out_of_view = [
            i
            for i in items
            if (i.prd_id is not None and i.prd_id in hidden.document_ids)
            or hidden.names(_line(i, own=False))
        ]
        unseen = frozenset(i.name for i in out_of_view) | frozenset(i.key for i in out_of_view)
        items = [i for i in items if i not in out_of_view]
        trashed = [
            (key, name)
            for key, name in trashed
            if record.trashed_prd.get(key) not in hidden.document_ids and not hidden.names(name)
        ]
    source = (
        "the owner's working draft, newer than the published version: it holds the owner's "
        "edits, so it wins over the published roadmap, the approved PRD versions and any "
        "earlier draft"
        if record.draft
        else "the published version (no newer working draft)"
    )
    out = [
        f"The roadmap of record is {record.label}: {source}. Oracle found it for you (one "
        "company, one roadmap); no other roadmap needs finding. Say which roadmap you read, "
        "in these words, in your summary. Take from it each item's current name with its "
        "code, its dates, goal, PRD, done mark, dependencies, and whether it is cut or in "
        "Trash. Leave items in Trash out of the PRD; mark done items done; keep cut items "
        "out of the plan. A new item without an F-code is flagged "
        f'"{NOT_IN_GROUND_TRUTH}" and kept, never refused.'
    ]
    own = [i for i in record.under(prd_id) if i in items]
    if own:
        out.append("Items under this PRD on it:")
        out += [_line(i, own=True, unseen=unseen) for i in own if not i.new]
        added = [i for i in own if i.new]
        if added:
            out.append("New items added under this PRD (include them):")
            out += [_line(i, own=True, unseen=unseen) for i in added]
    others = [i for i in items if i not in own]
    if others:
        out.append("Other items on it (for names and dependencies):")
        out += [_line(i, own=False, unseen=unseen) for i in others]
    if trashed:
        out.append("In Trash (leave out of the PRD, never bring back):")
        out += [f"- {name} [key {key}]" for key, name in trashed]
    return out
