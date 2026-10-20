"""Read views: a roadmap's items (brief and full), the read-only alignment report, and a
track's overview (one calm view: health, the next milestone, what needs attention).

Views only read. :func:`monitor` is the one write: it stores the overview's snapshot on
the track and records a ``product_track`` change event (oracle.changes) when the track's
health, its at-risk items or its next milestone changed. It is deterministic (no model
call); model work for a track (re-deriving its roadmap) is a ``prd_to_roadmap`` run in
SwarmCloud (V2c, V2d).
"""

import uuid
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import changes
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import items as items_mod
from oracle.roadmap import tracker
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapItem,
    ScheduleBasis,
    TrackerRecord,
    TrackMilestone,
)
from oracle.roadmap.schemas import (
    AlignmentItem,
    AlignmentReport,
    AtRiskItem,
    BlockerDependency,
    DocumentRef,
    DriftEntry,
    EntityRef,
    MilestoneOut,
    NextMilestone,
    PrdAnchor,
    RoadmapItemOut,
    RoadmapItemsOut,
    TraceLink,
    TrackOut,
    TrackOverview,
    TrackSummary,
)
from oracle.runs.flows import prd_link

RESOLVED = ("resolved", "accepted_risk", "feasibility_only")
HORIZON_ORDER = {"now": 0, "next": 1, "later": 2}
# Monitoring at most this often per track from the ticker.
MONITOR_EVERY_SECONDS = 3600


def today() -> date:
    return datetime.now(UTC).date()


# --- documents and versions --------------------------------------------------------------


async def _doc_ref(
    db: AsyncSession, document: Document | None, version: DocumentVersion | None = None
) -> DocumentRef | None:
    if document is None:
        return None
    return DocumentRef(
        id=document.id,
        slug=document.slug,
        title=document.title,
        version=version.number if version else None,
        approved=(version.approved_at is not None) if version else None,
    )


async def items_version(
    db: AsyncSession, document: Document, number: int | None = None, *, approved_first: bool = False
) -> DocumentVersion | None:
    """The roadmap version to show: ``number``, else the latest with items (the latest
    approved one first, for monitoring), else the latest."""
    if number is not None:
        return await db.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == document.id, DocumentVersion.number == number
            )
        )
    with_items = (
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == document.id,
            select(RoadmapItem.id)
            .where(RoadmapItem.roadmap_version_id == DocumentVersion.id)
            .exists(),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if approved_first:
        found = await db.scalar(with_items.where(DocumentVersion.approved_at.is_not(None)))
        if found is not None:
            return found
    found = await db.scalar(with_items)
    if found is not None:
        return found
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def version_items(db: AsyncSession, version: DocumentVersion | None) -> list[RoadmapItem]:
    if version is None:
        return []
    rows = await db.scalars(
        select(RoadmapItem)
        .where(RoadmapItem.roadmap_version_id == version.id)
        .order_by(RoadmapItem.position)
    )
    return list(rows)


# --- items -------------------------------------------------------------------------------


def _entity_ref(e: Entity) -> EntityRef:
    return EntityRef(id=e.id, type=e.type, key=e.key, title=e.title, status=e.status)


def blocker_dependency(e: Entity) -> BlockerDependency:
    spec = (e.attrs or {}).get("blocker")
    if not isinstance(spec, dict):
        # A plain constraint, with no blocker strategy: shown, but it blocks nothing.
        return BlockerDependency(
            **_entity_ref(e).model_dump(), blocker_status="constraint", resolved=True,
            critical=False,
        )  # fmt: skip
    status = str(spec.get("status") or "open")
    resolved = status in RESOLVED or e.status == "rejected"
    return BlockerDependency(
        **_entity_ref(e).model_dump(),
        blocker_status=status,
        severity=spec.get("severity"),
        blocker_type=spec.get("type"),
        resolved=resolved,
        critical=not resolved and spec.get("severity") == "critical" and spec.get("type") == "hard",
    )


class _Context:
    """Entities, live blockers, PRD documents and tracker records for a set of items."""

    def __init__(self) -> None:
        self.entities: dict[uuid.UUID, Entity] = {}
        self.blockers: dict[uuid.UUID, list[Entity]] = {}
        self.docs: dict[uuid.UUID, Document] = {}
        self.versions: dict[uuid.UUID, DocumentVersion] = {}
        self.records: dict[tuple[uuid.UUID | None, str], list[TrackerRecord]] = {}

    @classmethod
    async def load(cls, db: AsyncSession, rows: list[RoadmapItem]) -> "_Context":
        ctx = cls()
        ids: set[uuid.UUID] = set()
        for i in rows:
            ids.update(i.requirement_ids or [])
            ids.update(i.blocker_ids or [])
            if i.feature_id:
                ids.add(i.feature_id)
        if ids:
            ctx.entities = {
                e.id: e for e in await db.scalars(select(Entity).where(Entity.id.in_(ids)))
            }
        for i in rows:
            targets = ([i.feature_id] if i.feature_id else []) + list(i.requirement_ids or [])
            live = await items_mod.blockers_of(db, targets)
            stored = [ctx.entities[b] for b in i.blocker_ids or [] if b in ctx.entities]
            ctx.blockers[i.id] = list({e.id: e for e in [*stored, *live]}.values())
        version_ids = {i.prd_version_id for i in rows if i.prd_version_id}
        if version_ids:
            for v in await db.scalars(
                select(DocumentVersion).where(DocumentVersion.id.in_(version_ids))
            ):
                ctx.versions[v.id] = v
        doc_ids = {i.prd_document_id for i in rows if i.prd_document_id}
        if doc_ids:
            for d in await db.scalars(select(Document).where(Document.id.in_(doc_ids))):
                ctx.docs[d.id] = d
        track_ids = {i.track_id for i in rows if i.track_id}
        if track_ids:
            for r in await db.scalars(
                select(TrackerRecord).where(TrackerRecord.track_id.in_(track_ids))
            ):
                if r.item_key:
                    ctx.records.setdefault((r.track_id, r.item_key), []).append(r)
        return ctx

    def records_of(self, item: RoadmapItem) -> list[TrackerRecord]:
        return self.records.get((item.track_id, item.item_key), [])


def item_out(item: RoadmapItem, ctx: _Context, view: str = "full") -> RoadmapItemOut:
    doc = ctx.docs.get(item.prd_document_id) if item.prd_document_id else None
    version = ctx.versions.get(item.prd_version_id) if item.prd_version_id else None
    link = None
    if doc is not None and version is not None:
        link = prd_link(doc.slug, version.number, item.prd_section_key or "").rstrip("#")
    out = RoadmapItemOut(
        id=item.id,
        item_key=item.item_key,
        position=item.position,
        title=item.title,
        outcome=item.outcome,
        horizon=item.horizon,  # type: ignore[arg-type]
        milestone=item.milestone,
        freshness=item.freshness,  # type: ignore[arg-type]
        stale_reasons=list(item.stale_reasons or []),
        stale_since=item.stale_since,
        caused_by_change_id=item.caused_by_change_id,
        prd=PrdAnchor(
            document=DocumentRef(
                id=doc.id,
                slug=doc.slug,
                title=doc.title,
                version=version.number if version else None,
                approved=(version.approved_at is not None) if version else None,
            )
            if doc
            else None,
            section_key=item.prd_section_key,
            section_hash=item.prd_section_hash,
            link=link,
        ),
        track_id=item.track_id,
        note=item.note,
    )
    if view == "brief":
        return out
    feature = ctx.entities.get(item.feature_id) if item.feature_id else None
    return out.model_copy(
        update={
            "feature": _entity_ref(feature) if feature else None,
            "requirements": [
                _entity_ref(ctx.entities[r])
                for r in item.requirement_ids or []
                if r in ctx.entities
            ],
            "blockers": [blocker_dependency(e) for e in ctx.blockers.get(item.id, [])],
            "trace": [TraceLink.model_validate(t) for t in item.trace or []],
            "depends_on": list(item.depends_on or []),
            "validation_gates": list(item.validation_gates or []),
            "economics": dict(item.economics or {}),
            "priority": item.priority,
            "confidence": item.confidence,
            "engineering": [tracker.ref(r) for r in ctx.records_of(item)],
        }
    )


async def items_view(
    db: AsyncSession, document: Document, version: DocumentVersion | None, view: str
) -> RoadmapItemsOut:
    rows = await version_items(db, version)
    ctx = await _Context.load(db, rows)
    source = None
    if version is not None and version.source_version_id:
        sv = await db.get(DocumentVersion, version.source_version_id)
        if sv is not None:
            source = await _doc_ref(db, await db.get(Document, sv.document_id), sv)
    track_id = next((i.track_id for i in rows if i.track_id), None)
    if track_id is None:
        track_id = await db.scalar(
            select(ProductTrack.id).where(ProductTrack.roadmap_document_id == document.id)
        )
    return RoadmapItemsOut(
        roadmap=await _doc_ref(db, document, version),
        source=source,
        track_id=track_id,
        view=view,  # type: ignore[arg-type]
        items=[item_out(i, ctx, view) for i in rows],
    )


# --- alignment ---------------------------------------------------------------------------


async def _dated_items(db: AsyncSession, track_id: uuid.UUID | None) -> dict[str, date]:
    """Item key -> the date of the dated, planned track milestone that lists it."""
    if track_id is None:
        return {}
    out: dict[str, date] = {}
    for m in await db.scalars(
        select(TrackMilestone).where(
            TrackMilestone.track_id == track_id,
            TrackMilestone.target_date.is_not(None),
            TrackMilestone.status == "planned",
        )
    ):
        for key in m.item_keys or []:
            if key not in out or m.target_date < out[key]:
                out[key] = m.target_date
    return out


async def alignment(
    db: AsyncSession, document: Document, version: DocumentVersion | None
) -> AlignmentReport:
    rows = await version_items(db, version)
    track_id = next((i.track_id for i in rows if i.track_id), None)
    if track_id is None:
        track_id = await db.scalar(
            select(ProductTrack.id).where(ProductTrack.roadmap_document_id == document.id)
        )
    records = await tracker.records_for_track(db, track_id)
    by_key: dict[str, list[TrackerRecord]] = {}
    for r in records:
        if r.item_key:
            by_key.setdefault(r.item_key, []).append(r)
    dated = await _dated_items(db, track_id)
    now = today()
    out_items = []
    counts = {"items": len(rows), "aligned": 0, "drift": 0, "untracked": 0, "done": 0}
    for item in rows:
        mine = by_key.get(item.item_key, [])
        drift = tracker.drift_of(item, mine, tracker.milestone_date(item, dated), now)
        if not mine:
            state = "untracked"
        elif drift:
            state = "drift"
        elif {r.state for r in mine} <= {"done"}:
            state = "done"
        else:
            state = "aligned"
        counts[state] += 1
        out_items.append(
            AlignmentItem(
                item_key=item.item_key,
                title=item.title,
                horizon=item.horizon,  # type: ignore[arg-type]
                milestone=item.milestone,
                alignment=state,  # type: ignore[arg-type]
                tracker=[tracker.ref(r) for r in mine],
                drift=drift,
            )
        )
    extra = tracker.unplanned(records, {i.item_key for i in rows})
    counts["unplanned"] = len(extra)
    return AlignmentReport(
        generated_at=datetime.now(UTC),
        roadmap=await _doc_ref(db, document, version),
        track_id=track_id,
        connector=tracker.connector(),
        counts=counts,
        items=out_items,
        unplanned=extra,
    )


# --- tracks ------------------------------------------------------------------------------


async def _number(db: AsyncSession, version_id: uuid.UUID | None) -> int | None:
    if version_id is None:
        return None
    return await db.scalar(select(DocumentVersion.number).where(DocumentVersion.id == version_id))


async def track_out(db: AsyncSession, track: ProductTrack) -> TrackOut:
    prd = await db.get(Document, track.prd_document_id)
    roadmap = (
        await db.get(Document, track.roadmap_document_id) if track.roadmap_document_id else None
    )
    roadmap_version = await items_version(db, roadmap, approved_first=True) if roadmap else None
    latest = await db.scalar(
        select(func.max(DocumentVersion.number)).where(
            DocumentVersion.document_id == track.prd_document_id,
            DocumentVersion.approved_at.is_not(None),
        )
    )
    return TrackOut(
        id=track.id,
        title=track.title,
        status=track.status,  # type: ignore[arg-type]
        owner_id=track.owner_id,
        prd=await _doc_ref(db, prd),
        started_version=await _number(db, track.started_version_id),
        current_version=await _number(db, track.current_version_id),
        latest_approved_version=latest,
        roadmap=await _doc_ref(db, roadmap, roadmap_version) if roadmap else None,
        lock_version=track.lock_version,
        created_at=track.created_at,
        monitored_at=track.monitored_at,
    )


async def milestones_of(db: AsyncSession, track_id: uuid.UUID) -> list[TrackMilestone]:
    rows = await db.scalars(
        select(TrackMilestone)
        .where(TrackMilestone.track_id == track_id)
        .order_by(TrackMilestone.target_date.nulls_last(), TrackMilestone.created_at)
    )
    return list(rows)


async def _next_milestone(
    db: AsyncSession, milestones: list[TrackMilestone], rows: list[RoadmapItem]
) -> NextMilestone | None:
    now = today()
    planned = [m for m in milestones if m.status == "planned"]
    dated = sorted(
        (m for m in planned if m.target_date and m.target_date >= now), key=lambda m: m.target_date
    )
    undated = sorted(
        (m for m in planned if m.target_date is None), key=lambda m: HORIZON_ORDER[m.horizon]
    )
    chosen = dated[0] if dated else (undated[0] if undated else None)
    if chosen is not None:
        bases = []
        if chosen.basis_ids:
            bases = [
                {"id": str(b.id), "kind": b.kind, "reference": b.reference}
                for b in await db.scalars(
                    select(ScheduleBasis).where(ScheduleBasis.id.in_(chosen.basis_ids))
                )
            ]
        return NextMilestone(
            milestone_id=chosen.id,
            name=chosen.name,
            horizon=chosen.horizon,  # type: ignore[arg-type]
            target_date=chosen.target_date,
            dated=chosen.target_date is not None,
            bases=bases,
            items=len(chosen.item_keys or []),
        )
    # No track milestones: the items' own, earliest horizon first, dated before undated.
    named: dict[str, list[RoadmapItem]] = {}
    for i in rows:
        name = (i.milestone or {}).get("name")
        if name:
            named.setdefault(name, []).append(i)
    if not named:
        return None

    def order(entry: tuple[str, list[RoadmapItem]]) -> tuple:
        name, members = entry
        horizon = min(HORIZON_ORDER[i.horizon] for i in members)
        days = [d for i in members if (d := (i.milestone or {}).get("date"))]
        return (horizon, 0 if days else 1, min(days) if days else "", name)

    name, members = sorted(named.items(), key=order)[0]
    days = sorted(d for i in members if (d := (i.milestone or {}).get("date")))
    horizon = min(members, key=lambda i: HORIZON_ORDER[i.horizon]).horizon
    return NextMilestone(
        name=name,
        horizon=horizon,  # type: ignore[arg-type]
        target_date=date.fromisoformat(days[0]) if days else None,
        dated=bool(days),
        bases=[],
        items=len(members),
    )


def _headline(health: str, counts: dict[str, int], nxt: NextMilestone | None) -> str:
    if health == "closed":
        return "Closed."
    if health == "paused":
        return "Paused."
    if health == "no_roadmap":
        return "No roadmap items yet: derive the roadmap from the PRD."
    when = ""
    if nxt is not None:
        when = f" Next: {nxt.name}" + (f" ({nxt.target_date})." if nxt.target_date else ".")
    if health == "on_track":
        return f"On track: {counts['items']} items.{when}"
    parts = [
        f"{counts[k]} {label}"
        for k, label in (("blocked", "blocked"), ("stale", "stale"), ("slipping", "slipping"))
        if counts[k]
    ]
    word = "Off track" if health == "off_track" else "At risk"
    attention = f"{counts['at_risk']} of {counts['items']} items need attention"
    return f"{word}: {attention}" + (f" ({', '.join(parts)})." if parts else ".") + when


async def overview(db: AsyncSession, track: ProductTrack) -> TrackOverview:
    base = await track_out(db, track)
    roadmap = (
        await db.get(Document, track.roadmap_document_id) if track.roadmap_document_id else None
    )
    version = await items_version(db, roadmap, approved_first=True) if roadmap else None
    rows = await version_items(db, version)
    ctx = await _Context.load(db, rows)
    milestones = await milestones_of(db, track.id)
    dated = await _dated_items(db, track.id)
    now = today()
    nxt = await _next_milestone(db, milestones, rows)
    next_keys: set[str] = set()
    if nxt is not None and nxt.milestone_id is not None:
        next_keys = set(next(m.item_keys for m in milestones if m.id == nxt.milestone_id) or [])
    elif nxt is not None:
        next_keys = {i.item_key for i in rows if (i.milestone or {}).get("name") == nxt.name}

    counts = {k: 0 for k in ("items", "now", "next", "later", "at_risk", "blocked", "stale",
                             "slipping", "done")}  # fmt: skip
    counts["items"] = len(rows)
    at_risk: list[AtRiskItem] = []
    drift: list[DriftEntry] = []
    off = False
    for item in rows:
        counts[item.horizon] += 1
        records = ctx.records_of(item)
        if records and {r.state for r in records} <= {"done"}:
            counts["done"] += 1
        reasons: list[dict[str, str]] = []
        for b in (blocker_dependency(e) for e in ctx.blockers.get(item.id, [])):
            if not b.resolved:
                reasons.append({"kind": "blocked", "detail": f"{b.title} ({b.blocker_status})"})
                if b.critical and item.horizon == "now":
                    off = True
        if item.freshness in ("potentially_stale", "under_review"):
            why = "; ".join(item.stale_reasons or []) or "its PRD trace changed"
            reasons.append({"kind": "stale", "detail": why})
        item_drift = tracker.drift_of(item, records, tracker.milestone_date(item, dated), now)
        drift += item_drift
        for d in item_drift:
            if d.kind in ("date_slip", "overdue", "cancelled"):
                reasons.append({"kind": "slipping", "detail": d.detail})
                if item.item_key in next_keys:
                    off = True
        for m in milestones:
            if (
                m.status == "planned"
                and m.target_date
                and m.target_date < now
                and item.item_key in (m.item_keys or [])
                and not (records and {r.state for r in records} <= {"done"})
            ):
                detail = f"Milestone {m.name} ({m.target_date}) has passed."
                if all(r["detail"] != detail for r in reasons):
                    reasons.append({"kind": "slipping", "detail": detail})
        if reasons:
            for kind in ("blocked", "stale", "slipping"):
                if any(r["kind"] == kind for r in reasons):
                    counts[kind] += 1
            at_risk.append(
                AtRiskItem(
                    item_key=item.item_key,
                    title=item.title,
                    horizon=item.horizon,  # type: ignore[arg-type]
                    reasons=reasons,
                )
            )
    counts["at_risk"] = len(at_risk)
    records = await tracker.records_for_track(db, track.id)
    drift += tracker.unplanned(records, {i.item_key for i in rows})
    source_number = None
    if version is not None and version.source_version_id:
        source_number = await _number(db, version.source_version_id)
    prd_moved = bool(
        source_number
        and base.latest_approved_version
        and base.latest_approved_version > source_number
    )
    if track.status in ("closed", "paused"):
        health = track.status
    elif not rows:
        health = "no_roadmap"
    elif off:
        health = "off_track"
    elif at_risk or prd_moved:
        health = "at_risk"
    else:
        health = "on_track"
    headline = _headline(health, counts, nxt)
    if prd_moved and health not in ("closed", "paused"):
        headline += f" The PRD has a newer approved version (v{base.latest_approved_version})."
    return TrackOverview(
        **base.model_dump(),
        health=health,  # type: ignore[arg-type]
        headline=headline,
        counts=counts,
        next_milestone=nxt,
        at_risk=at_risk,
        drift=drift,
        engineering_known=bool(records),
        prd_moved=prd_moved,
        milestones=[MilestoneOut.model_validate(m) for m in milestones],
    )


async def summary(db: AsyncSession, track: ProductTrack) -> TrackSummary:
    full = await overview(db, track)
    return TrackSummary(**{k: getattr(full, k) for k in TrackSummary.model_fields})


def snapshot(o: TrackOverview) -> dict[str, Any]:
    nxt = o.next_milestone
    return {
        "health": o.health,
        "at_risk": sorted(i.item_key for i in o.at_risk),
        "next_milestone": None
        if nxt is None
        else {"name": nxt.name, "date": nxt.target_date.isoformat() if nxt.target_date else None},
        "prd_moved": o.prd_moved,
        "counts": o.counts,
    }


async def monitor(
    db: AsyncSession, track: ProductTrack, actor: Any
) -> tuple[TrackOverview, uuid.UUID | None, list[str]]:
    """Compute the overview, store its snapshot, and record a ``product_track`` change
    when health, at-risk items or the next milestone changed. The caller commits."""
    o = await overview(db, track)
    after = snapshot(o)
    before = dict(track.monitor or {})
    changed = [
        k for k in ("health", "at_risk", "next_milestone", "prd_moved") if before.get(k) != after[k]
    ]
    event_id = None
    if changed:
        prd = await db.get(Document, track.prd_document_id)
        event = await changes.record_change(
            db,
            "product_track",
            cause="track_monitored",
            actor=actor,
            subject_id=track.id,
            subject_ref=f"track:{prd.slug if prd else track.id}",
            document_id=track.prd_document_id,
            data={"before": before or None, "after": after, "changed": changed},
        )
        event_id = event.id
    track.monitor = after
    track.monitored_at = datetime.now(UTC)
    await db.flush()
    o = o.model_copy(update={"monitored_at": track.monitored_at})
    return o, event_id, changed


async def monitor_due(db: AsyncSession, *, limit: int = 20) -> int:
    """The ticker's call: monitor active tracks not monitored within the hour."""
    cutoff = datetime.now(UTC).timestamp() - MONITOR_EVERY_SECONDS
    rows = await db.scalars(
        select(ProductTrack)
        .where(
            ProductTrack.status == "active",
            (ProductTrack.monitored_at.is_(None))
            | (func.extract("epoch", ProductTrack.monitored_at) < cutoff),
        )
        .order_by(ProductTrack.monitored_at.nulls_first())
        .limit(limit)
    )
    done = 0
    for track in list(rows):
        await monitor(db, track, "system")
        done += 1
    return done
