"""Verified schedule bases: the only thing a roadmap date may rest on (O4, §11.4).

Now/Next/Later on the B2 horizons is the default and needs no date. A date (a dated
milestone, an item's milestone date) is accepted only when a verified estimate, capacity
figure or commitment supports exactly that date:

- an engineering lead or an owner (an approver while no lead is named) records and so
  verifies the basis (``POST /v1/schedule-bases``; an approver's waits as proposed until
  a lead verifies it, F3) for
  one PRD (O4, owner 2026-10-19), with the reference a roadmap names (``ENG-412``), its
  kind, and the date it supports; optionally only for one roadmap item (``item_key``) or
  for the items one tracker issue is matched to (``tracker_key``); it may come from a
  tracker record read back (E1), whose own target date must agree;
- a roadmap item's milestone ``date_source`` must name the reference of such a basis of
  the item's own PRD (and in its scope), and the basis must support the item's date; only
  items in Now carry a date; a track milestone lists its bases;
- a withdrawn basis supports nothing: milestones lose the date it alone supported, and
  roadmap items whose date rested on it are marked potentially stale. An item's date is
  re-checked whenever it is read (:func:`oracle.roadmap.items.recheck_date`), so a
  withdrawn or out-of-scope basis takes the date off the item, the track's headline and
  the drift checks, without rewriting an approved version's rows.

Oracle never proposes a date of its own.
"""

import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import wording
from oracle.roadmap.models import ScheduleBasis

UNVERIFIED = (
    "a date needs a verified estimate, capacity or commitment recorded for this PRD (and "
    f"item) that supports it ({wording.RECORD_DATE_BASIS}); Oracle never invents dates"
)
OUTSIDE_NOW = "dated milestones belong only in now; the date was dropped"


@dataclass(frozen=True)
class Basis:
    """What the date checks need from a verified basis. ``item_keys``: the roadmap item
    keys it is limited to (None: every item of its PRD)."""

    id: uuid.UUID
    kind: str
    reference: str
    supports_date: date
    prd_document_id: uuid.UUID | None = None
    item_keys: frozenset[str] | None = None
    item_key: str | None = None
    tracker_key: str | None = None

    def covers(self, item_key: str | None) -> bool:
        return self.item_keys is None or (item_key is not None and item_key in self.item_keys)

    def as_json(self) -> dict[str, Any]:
        out = {
            "id": str(self.id),
            "kind": self.kind,
            "reference": self.reference,
            "supports_date": self.supports_date.isoformat(),
        }
        if self.item_key:
            out["item_key"] = self.item_key
        if self.tracker_key:
            out["tracker_key"] = self.tracker_key
            out["item_keys"] = sorted(self.item_keys or ())
        return out


def now() -> datetime:
    return datetime.now(UTC)


async def verified_bases(db: AsyncSession, prd_document_id: uuid.UUID | None) -> list[Basis]:
    """The verified bases recorded for this PRD, each with the item keys it is limited
    to. No PRD: none (a basis always belongs to one PRD)."""
    return await bases_with_status(db, prd_document_id, "verified")


async def bases_with_status(
    db: AsyncSession, prd_document_id: uuid.UUID | None, status: str
) -> list[Basis]:
    """The bases of this PRD in ``status`` (verified or withdrawn), with their scope."""
    return (await bases_by_status(db, prd_document_id, (status,)))[status]


async def bases_by_status(
    db: AsyncSession, prd_document_id: uuid.UUID | None, statuses: Iterable[str]
) -> dict[str, list[Basis]]:
    """The bases of this PRD in each of ``statuses``, with their scope: one query for the
    bases and at most one for the tracker records their tracker keys are matched to."""
    from oracle.roadmap.models import ProductTrack, TrackerRecord

    statuses = tuple(statuses)
    out: dict[str, list[Basis]] = {s: [] for s in statuses}
    if prd_document_id is None:
        return out
    rows = list(
        await db.scalars(
            select(ScheduleBasis)
            .where(
                ScheduleBasis.status.in_(statuses),
                ScheduleBasis.prd_document_id == prd_document_id,
            )
            .order_by(ScheduleBasis.supports_date, ScheduleBasis.reference)
        )
    )
    tracker_keys = {r.tracker_key for r in rows if r.tracker_key}
    matched: dict[str, set[str]] = {}
    if tracker_keys:
        # A tracker issue's items: its records on this PRD's track, matched to an item.
        for ref, key in (
            await db.execute(
                select(TrackerRecord.external_ref, TrackerRecord.item_key)
                .join(ProductTrack, ProductTrack.id == TrackerRecord.track_id)
                .where(
                    ProductTrack.prd_document_id == prd_document_id,
                    TrackerRecord.external_ref.in_(tracker_keys),
                    TrackerRecord.item_key.is_not(None),
                )
            )
        ).all():
            matched.setdefault(ref, set()).add(key)
    for r in rows:
        scope: frozenset[str] | None = None
        if r.item_key:
            scope = frozenset({r.item_key})
        elif r.tracker_key:
            scope = frozenset(matched.get(r.tracker_key, ()))
        out[r.status].append(
            Basis(
                r.id,
                r.kind,
                r.reference,
                r.supports_date,
                r.prd_document_id,
                scope,
                r.item_key,
                r.tracker_key,
            )  # fmt: skip
        )
    return out


def _names(reference: str, text: str) -> bool:
    """Whether ``text`` names ``reference`` as an exact token, case-insensitively: not
    inside a longer key (``ENG-41`` is not named by ``ENG-41-2``, ``ENG-41.2``,
    ``A-ENG-41`` or ``ENG-412``); trailing punctuation (``ENG-41.``) is not part of it."""
    ref = reference.strip()
    if not ref:
        return False
    pattern = (
        r"(?<![A-Za-z0-9_])(?<![A-Za-z0-9][-./])"
        + re.escape(ref)
        + r"(?![A-Za-z0-9_])(?![-./][A-Za-z0-9])"
    )
    return re.search(pattern, text, re.IGNORECASE) is not None


def as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def supporting(
    when: Any, date_source: str | None, bases: Iterable[Basis], item_key: str | None = None
) -> list[Basis]:
    """The verified bases a milestone date rests on: of the item's PRD (the caller passes
    only those), covering ``item_key``, named in ``date_source`` and supporting exactly
    that date. Empty: the date is refused."""
    day = as_date(when)
    if day is None or not date_source:
        return []
    return [
        b
        for b in bases
        if b.supports_date == day and b.covers(item_key) and _names(b.reference, date_source)
    ]


async def recheck_tracker_milestones(db: AsyncSession, refs: Iterable[str]) -> list[uuid.UUID]:
    """Tracker records were (re-)matched: a verified basis for one of these tracker keys
    now covers the items its issue is matched to now. A track milestone keeps such a
    basis only while it still covers every item the milestone lists, and loses its date
    when no basis is left. Returns the milestones that lost their date. The caller
    commits."""
    from oracle.roadmap.models import TrackMilestone

    refs = set(refs)
    if not refs:
        return []
    affected = list(
        await db.scalars(
            select(ScheduleBasis).where(
                ScheduleBasis.status == "verified", ScheduleBasis.tracker_key.in_(refs)
            )
        )
    )
    if not affected:
        return []
    scopes: dict[uuid.UUID, frozenset[str] | None] = {}
    for prd in {b.prd_document_id for b in affected}:
        for b in await verified_bases(db, prd):
            scopes[b.id] = b.item_keys
    ids = [b.id for b in affected]
    undated: list[uuid.UUID] = []
    for m in await db.scalars(
        select(TrackMilestone)
        .where(TrackMilestone.basis_ids.overlap(ids))
        .order_by(TrackMilestone.id)
        .with_for_update()
    ):
        keys = set(m.item_keys or [])
        kept = [
            b
            for b in m.basis_ids
            if b not in scopes or scopes[b] is None or (keys and keys <= scopes[b])
        ]
        if kept == list(m.basis_ids):
            continue
        m.basis_ids = kept
        if not kept and m.target_date is not None:
            m.target_date = None
            undated.append(m.id)
    await db.flush()
    return undated


async def _milestone_effects(
    db: AsyncSession, basis: ScheduleBasis
) -> list[tuple[Any, list[uuid.UUID]]]:
    """Each track milestone listing ``basis``, with the other verified bases still
    supporting its date (withdraw's query, shared with :func:`impact`)."""
    from oracle.roadmap.models import TrackMilestone

    out: list[tuple[Any, list[uuid.UUID]]] = []
    for m in await db.scalars(
        select(TrackMilestone)
        .where(TrackMilestone.basis_ids.contains([basis.id]))
        .order_by(TrackMilestone.id)
    ):
        rest = [b for b in m.basis_ids if b != basis.id]
        still = (
            list(
                await db.scalars(
                    select(ScheduleBasis.id).where(
                        ScheduleBasis.id.in_(rest),
                        ScheduleBasis.status == "verified",
                        ScheduleBasis.supports_date == m.target_date,
                    )
                )
            )
            if rest
            else []
        )
        out.append((m, still))
    return out


async def _resting_items(db: AsyncSession, basis: ScheduleBasis) -> list[Any]:
    """The roadmap items of approved roadmaps whose stored date rests on ``basis``
    (withdraw's query, shared with :func:`impact`)."""
    from oracle.roadmap.models import RoadmapItem

    return list(
        await db.scalars(
            select(RoadmapItem)
            .where(
                RoadmapItem.milestone["basis_ids"].astext.contains(str(basis.id)),
                # E1: a PRD draft's items (no roadmap version yet) never go stale.
                RoadmapItem.roadmap_version_id.is_not(None),
            )
            .order_by(RoadmapItem.id)
        )
    )


async def withdraw(
    db: AsyncSession, principal: Any, basis: ScheduleBasis, reason: str
) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
    """Withdraw a basis, keeping the reason on it (F3). Milestones keep their date only
    if another verified basis supports it; roadmap items whose date rested on it go
    potentially stale (their content stays: an approved version is never rewritten; the
    date is withheld when the item is read, unless another basis supports it). The
    caller commits."""
    from oracle import audit

    basis.status = "withdrawn"
    basis.withdrawn_by = principal.id
    basis.withdrawn_at = now()
    basis.withdrawn_reason = reason
    await db.flush()
    undated: list[uuid.UUID] = []
    for m, still in await _milestone_effects(db, basis):
        m.basis_ids = still
        if not still and m.target_date is not None:
            m.target_date = None
            undated.append(m.id)
    stale: list[uuid.UUID] = []
    when = now()
    reason_text = f"the schedule basis {basis.reference} was withdrawn"
    for item in await _resting_items(db, basis):
        if item.freshness != "potentially_stale" or item.stale_since is None:
            item.stale_since = when
        item.freshness = "potentially_stale"
        item.stale_reasons = [*(item.stale_reasons or []), reason_text][-20:]
        stale.append(item.id)
    await db.flush()
    await audit.record(
        db,
        principal,
        "schedule_basis.withdrawn",
        "schedule_basis",
        basis.id,
        {
            "reference": basis.reference,
            "reason": reason,
            "undated_milestones": [str(i) for i in undated],
            "stale_items": [str(i) for i in stale],
        },
    )
    return undated, stale


async def impact(db: AsyncSession, basis: ScheduleBasis) -> Any:
    """What :func:`withdraw` would change for ``basis`` (F3), writing nothing: the
    milestones it dates (and whether another verified basis keeps the date), the roadmap
    items whose date rests on it, and for each roadmap version showing its PRD's dates
    (each roadmap's latest version, and every version holding one of those items) the
    places that would show "date withdrawn" (:func:`oracle.roadmap.doc_dates.
    marks_for_version`, read with the basis withdrawn inside a savepoint rolled back)."""
    from oracle.docs.models import Document, DocumentVersion, Section
    from oracle.roadmap import doc_dates
    from oracle.roadmap.models import ProductTrack
    from oracle.roadmap.schemas import (
        BasisImpactOut,
        ImpactDocument,
        ImpactItem,
        ImpactMilestone,
    )

    milestones = [
        ImpactMilestone(
            id=m.id,
            track_id=m.track_id,
            name=m.name,
            target_date=m.target_date,
            keeps_date=bool(still) or m.target_date is None,
        )
        for m, still in await _milestone_effects(db, basis)
    ]
    rows = await _resting_items(db, basis)
    numbers: dict[uuid.UUID, tuple[str, int, uuid.UUID]] = {}
    version_ids = {r.roadmap_version_id for r in rows}
    if basis.status == "verified":
        # Each roadmap whose dates rest on this PRD: built from one of its versions, or
        # its track's roadmap; its latest version.
        prd_versions = select(DocumentVersion.id).where(
            DocumentVersion.document_id == basis.prd_document_id
        )
        docs = set(
            await db.scalars(
                select(DocumentVersion.document_id).where(
                    DocumentVersion.source_version_id.in_(prd_versions)
                )
            )
        ) | set(
            await db.scalars(
                select(ProductTrack.roadmap_document_id).where(
                    ProductTrack.prd_document_id == basis.prd_document_id,
                    ProductTrack.roadmap_document_id.is_not(None),
                )
            )
        )
        for doc in docs:
            latest = await db.scalar(
                select(DocumentVersion.id)
                .where(DocumentVersion.document_id == doc)
                .order_by(DocumentVersion.number.desc())
                .limit(1)
            )
            if latest is not None:
                version_ids.add(latest)
    versions = (
        list(
            await db.scalars(
                select(DocumentVersion)
                .where(DocumentVersion.id.in_(version_ids))
                .order_by(DocumentVersion.document_id, DocumentVersion.number)
            )
        )
        if version_ids
        else []
    )
    slugs = (
        dict(
            (
                await db.execute(
                    select(Document.id, Document.slug).where(
                        Document.id.in_({v.document_id for v in versions}),
                        Document.kind.in_(doc_dates.DATED_KINDS),
                    )
                )
            ).all()
        )
        if versions
        else {}
    )
    for v in versions:
        numbers[v.id] = (slugs.get(v.document_id, ""), v.number, v.document_id)
    items = [
        ImpactItem(
            id=r.id,
            roadmap=numbers[r.roadmap_version_id][0] if r.roadmap_version_id in numbers else "",
            version=numbers[r.roadmap_version_id][1] if r.roadmap_version_id in numbers else 0,
            item_key=r.item_key,
        )
        for r in rows
    ]
    documents: list[ImpactDocument] = []
    if basis.status == "verified":
        for v in versions:
            if v.document_id not in slugs:
                continue
            sections = list(
                await db.scalars(
                    select(Section).where(Section.version_id == v.id).order_by(Section.ordinal)
                )
            )
            try:
                before = await doc_dates.marks_for_version(db, v, sections)
                savepoint = await db.begin_nested()
                try:
                    basis.status = "withdrawn"
                    await db.flush()
                    after = await doc_dates.marks_for_version(db, v, sections)
                finally:
                    await savepoint.rollback()
                    # The rollback expired the row: read it back as stored.
                    await db.refresh(basis)
            except doc_dates.DatesUnavailable:
                continue
            was = {(m.section_key, m.text, m.where) for m in before if m.status == "withdrawn"}
            marks = sum(
                1
                for m in after
                if m.status == "withdrawn" and (m.section_key, m.text, m.where) not in was
            )
            if marks:
                documents.append(
                    ImpactDocument(slug=slugs[v.document_id], version=v.number, marks=marks)
                )
    return BasisImpactOut(
        basis_id=basis.id, milestones=milestones, items=items, documents=documents
    )
