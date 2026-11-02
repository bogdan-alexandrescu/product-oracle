"""approved-prd-roadmap (the owner's pick, 2026-11-02: 'Add them as a roadmap draft'):
approving a PRD version puts its dated items and its milestones on its roadmap's working
draft, for the roadmap's owner to review and publish. No run, no cost.

**What approval writes** (:func:`on_prd_approved`, from ``approve_version``):

- the roadmap: the PRD's track's, else the roadmap its published items are on, else the one
  its derived items (E1, ``draft_roadmaps``) name, else the company's only roadmap; none:
  nothing is written. A roadmap whose draft is in review waits: nothing is written;
- its items: the approved version's derived items that have a date. The end is the date the
  engineering lead accepted (the PRD's newest verified schedule basis for the item, source
  ``engineering``), else the item's own; the start is the item's own (an end-only item stays
  end-only, its start estimated). An undated item is not added. Each is an item added to the
  working draft (``simple_draft_id``, as S7's additions), with the PRD as its PRD;
- an item already on the published roadmap (same PRD, same key) only adds what changed:
  its dates or title, as the draft's fields on the published item; unchanged, nothing;
- its milestones (the plan, oracle.simple.plan) as key dates on their end (else start) day,
  noted "From <PRD>", in ``overlay["key_dates"]``; one already published unchanged: nothing.

What came from which PRD is ``overlay["from_prds"]`` (PRD id -> {version, items,
key_dates}: ids); the draft says how many (``SimpleDraftOut.from_prds``).

**Approving again** (a later version, or the same one): the PRD's earlier additions in the
draft are taken out first, then written again, so the draft never holds them twice.
"""

import logging
import uuid
from datetime import date
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem, ScheduleBasis
from oracle.simple import drafts
from oracle.simple.models import SimpleDraft
from oracle.simple.schemas import SimpleDocRef, SimpleDraftPrd

log = logging.getLogger(__name__)

KEY = "from_prds"
KEY_DATES = "key_dates"
# The E1 fields an added item keeps.
KEPT = ("outcome", "horizon", "feature_id", "prd_section_key", "depends_on", "goal_ids")


async def _roadmap(db: AsyncSession, prd: Document, derived: list[RoadmapItem]) -> uuid.UUID | None:
    from oracle.roadmap import tracks

    track = await tracks.track_of_prd(db, prd.id)
    if track is not None and track.roadmap_document_id is not None:
        return track.roadmap_document_id
    on = await db.scalar(
        select(RoadmapItem.roadmap_document_id)
        .where(RoadmapItem.prd_document_id == prd.id, RoadmapItem.roadmap_version_id.is_not(None))
        .order_by(RoadmapItem.created_at.desc())
        .limit(1)
    )
    if on is not None:
        return on
    named = next((r.roadmap_document_id for r in derived if r.roadmap_document_id), None)
    if named is not None:
        return named
    roadmaps = list(await db.scalars(select(Document.id).where(Document.kind == "roadmap")))
    return roadmaps[0] if len(roadmaps) == 1 else None


async def _accepted(db: AsyncSession, prd_id: uuid.UUID) -> dict[str, date]:
    """Each item's date the engineering lead accepted: its newest verified basis."""
    out: dict[str, date] = {}
    for b in await db.scalars(
        select(ScheduleBasis)
        .where(
            ScheduleBasis.prd_document_id == prd_id,
            ScheduleBasis.status == "verified",
            ScheduleBasis.item_key.is_not(None),
        )
        .order_by(ScheduleBasis.verified_at.nulls_first(), ScheduleBasis.created_at)
    ):
        out[b.item_key] = b.supports_date  # type: ignore[index]
    return out


def _dated(row: RoadmapItem, accepted: dict[str, date]) -> tuple[date | None, date, str] | None:
    """(start, end, source) of a derived item, or None when it has no date."""
    end, source = accepted.get(row.item_key), "engineering"
    if end is None:
        end, source = row.end_date, row.date_source or "accepted"
    if end is None:
        return None
    start = row.start_date if row.start_date and row.start_date <= end else None
    return start, end, source


async def _draft(db: AsyncSession, doc: uuid.UUID, me: uuid.UUID) -> SimpleDraft | None:
    """The roadmap's working draft, opened as S7's additions open it when it has none; None
    while a draft of it is in review."""
    from oracle.simple.additions import _shown_version

    d = await db.scalar(
        select(SimpleDraft)
        .where(SimpleDraft.document_id == doc, SimpleDraft.status == "working")
        .with_for_update()
    )
    if d is not None:
        return d
    waiting = await db.scalar(
        select(SimpleDraft.id).where(
            SimpleDraft.document_id == doc, SimpleDraft.status == "submitted"
        )
    )
    if waiting is not None:
        return None
    d = SimpleDraft(
        document_id=doc,
        base_version_id=await _shown_version(db, doc),
        status="working",
        overlay={},
        created_by=me,
        participant_ids=[me],
    )
    db.add(d)
    await db.flush()
    return d


def _key_date_id(roadmap: uuid.UUID, prd: uuid.UUID, code: str) -> str:
    return str(uuid.uuid5(roadmap, f"{prd}:{code}"))


async def _take_out(db: AsyncSession, d: SimpleDraft, prd_id: str) -> dict[str, Any]:
    """The PRD's earlier additions leave the draft; the overlay without them."""
    overlay = dict(d.overlay or {})
    sources = dict(overlay.get(KEY) or {})
    before = sources.pop(prd_id, None) or {}
    ids = [str(i) for i in before.get("items") or []]
    added = [uuid.UUID(i) for i in ids]
    if added:
        await db.execute(
            delete(RoadmapItem).where(
                RoadmapItem.id.in_(added),
                RoadmapItem.simple_draft_id == d.id,
                RoadmapItem.roadmap_version_id.is_(None),
            )
        )
    for i in ids:
        overlay.pop(i, None)
    kds = dict(overlay.get(KEY_DATES) or {})
    for k in before.get(KEY_DATES) or []:
        kds.pop(k, None)
    overlay[KEY_DATES] = kds
    overlay[KEY] = sources
    return overlay


async def on_prd_approved(
    db: AsyncSession, principal: Any, prd: Document, version: DocumentVersion
) -> None:
    from oracle.roadmap import draft_items, views
    from oracle.simple import key_dates
    from oracle.simple import plan as plans

    derived_row = await draft_items._row(db, version.id)
    derived = (
        await draft_items.draft_items(db, derived_row)
        if derived_row is not None and derived_row.status == "ready"
        else []
    )
    doc = await _roadmap(db, prd, derived)
    if doc is None:
        return
    me = drafts._me(principal)
    if me is None:
        return
    view = (await plans.views(db, {prd.id})).get(prd.id)
    milestones = [m for m in (view.milestones if view else []) if m.end_date or m.start_date]
    accepted = await _accepted(db, prd.id)
    dated = [(r, got) for r in derived if (got := _dated(r, accepted)) is not None]
    d = await _draft(db, doc, me)
    if d is None:
        log.info("approved-prd-roadmap: %s's draft is in review; nothing written", doc)
        return
    overlay = await _take_out(db, d, str(prd.id))
    base = await db.get(DocumentVersion, d.base_version_id) if d.base_version_id else None
    published = await views.version_items(db, base) if base is not None else []
    ours = {r.item_key: r for r in published if r.prd_document_id == prd.id}
    taken = {r.item_key for r in published} | set(
        await db.scalars(
            select(RoadmapItem.item_key).where(
                RoadmapItem.simple_draft_id == d.id, RoadmapItem.roadmap_version_id.is_(None)
            )
        )
    )
    position = await db.scalar(
        select(func.max(RoadmapItem.position)).where(
            (RoadmapItem.roadmap_version_id == d.base_version_id)
            | (RoadmapItem.simple_draft_id == d.id)
        )
    )
    position = position or 0
    from oracle.roadmap import tracks

    track = await tracks.track_of_prd(db, prd.id)
    note = f"From {prd.title} (version {version.number})"
    items: list[str] = []
    for row, (start, end, source) in dated:
        pub = ours.get(row.item_key)
        if pub is not None:
            cur = drafts.overlaid(pub, overlay.get(str(pub.id)))
            if (cur.start_date, cur.end_date, cur.title) == (start, end, row.title):
                continue
            changed = drafts.overlaid(pub, drafts.snapshot(cur))
            changed.start_date, changed.end_date, changed.title = start, end, row.title
            changed.date_source = source
            overlay[str(pub.id)] = drafts.snapshot(changed)
            items.append(str(pub.id))
            continue
        key, n = row.item_key, 2
        while key in taken:
            key, n = f"{row.item_key[:21]}-{n}", n + 1
        taken.add(key)
        position += 1
        added = RoadmapItem(
            roadmap_document_id=doc,
            roadmap_version_id=None,
            simple_draft_id=d.id,
            item_key=key,
            position=position,
            title=row.title,
            **{f: getattr(row, f) for f in KEPT},
            draft=False,
            track_id=track.id if track is not None else None,
            prd_document_id=prd.id,
            prd_version_id=version.id,
            note=note,
            start_date=start,
            end_date=end,
            date_source=source,
        )
        db.add(added)
        await db.flush()
        items.append(str(added.id))
    pub_kds = (await key_dates.published(db, {doc}))[doc]
    kds = dict(overlay.get(KEY_DATES) or {})
    kd_ids: list[str] = []
    for m in milestones:
        kd_id = _key_date_id(doc, prd.id, m.code)
        value = {
            "name": m.name,
            "date": (m.end_date or m.start_date).isoformat(),  # type: ignore[union-attr]
            "note": f"From {prd.title}",
        }
        if pub_kds.get(kd_id) == value:
            continue
        kds[kd_id] = value
        kd_ids.append(kd_id)
    if kds:
        overlay[KEY_DATES] = kds
    else:
        overlay.pop(KEY_DATES, None)
    sources = dict(overlay.get(KEY) or {})
    if items or kd_ids:
        sources[str(prd.id)] = {"version": version.number, "items": items, KEY_DATES: kd_ids}
    if sources:
        overlay[KEY] = sources
    else:
        overlay.pop(KEY, None)
    d.overlay = overlay
    if me not in (d.participant_ids or []):
        d.participant_ids = [*(d.participant_ids or []), me]
    await db.flush()


async def sources_out(db: AsyncSession, d: SimpleDraft) -> list[SimpleDraftPrd]:
    """How many items and key dates in the draft came from each approved PRD."""
    sources = (d.overlay or {}).get(KEY) or {}
    if not sources:
        return []
    docs = {
        x.id: x
        for x in await db.scalars(
            select(Document).where(Document.id.in_([uuid.UUID(k) for k in sources]))
        )
    }
    out = []
    for k, v in sources.items():
        doc = docs.get(uuid.UUID(k))
        if doc is None:
            continue
        out.append(
            SimpleDraftPrd(
                prd=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
                version=v.get("version"),
                items=len(v.get("items") or []),
                key_dates=len(v.get(KEY_DATES) or []),
            )
        )
    return sorted(out, key=lambda s: s.prd.title.casefold())


def has_sources(d: SimpleDraft) -> bool:
    return bool((d.overlay or {}).get(KEY))
