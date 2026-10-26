"""The Plan (F1, c7 Plan rename): one read of the PRDs in play, their stage, and the
roadmap rows under Now / Next / Later with their state, engineering status and the next
decision.

Every number comes from the roadmap module: a track's health and each item's at-risk
reasons from :func:`oracle.roadmap.views.assess` (the overview's rules), dates as
:func:`oracle.roadmap.items.live_milestones` re-checks them, drift from
:mod:`oracle.roadmap.tracker`, and how a draft item differs from its approved twin from
the one item diff, :func:`oracle.roadmap.diff.diff_items`. This module writes nothing,
calls no model and makes no comparison of its own.

It reads in bulk, a fixed number of statements whatever the company's size (plus the
schedule bases of each PRD whose items carry a date): documents, versions, tracks,
unfinished runs with their segments and pending checkpoints, the items of each roadmap's
latest approved version and of its latest draft, their context, the tracks' milestones
and records, and the goals each item's feature supports.
"""

import uuid
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.plan.schemas import (
    ItemChange,
    ItemHistoryOut,
    ItemTrackerEvent,
    ItemVersion,
    PlanCounts,
    PlanDocument,
    PlanDrift,
    PlanEngineering,
    PlanItem,
    PlanItemPrd,
    PlanItemRoadmap,
    PlanNext,
    PlanOut,
    PlanPrd,
    PlanReason,
    PlanRun,
    PlanScope,
    PlanTrack,
    PlanWho,
    TrackerFieldChange,
)
from oracle.roadmap import diff, schedule, tracker, views
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapItem,
    ScheduleBasis,
    TrackerRecord,
    TrackerRecordEvent,
    TrackMilestone,
)
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.strategy import drift
from oracle.strategy.models import StrategyFinding

# Runs still going: under way, or waiting on a person (as Home's In flight).
UNFINISHED = ("running", "awaiting_checkpoint", "awaiting_approval", "paused_overrun")
LIVE_TRACKS = ("active", "paused")
RANK = {"viewer": 0, "commenter": 1, "approver": 2, "owner": 3}
# The Runs page's checkpoint names (web/app/runs/_lib.tsx CHECKPOINT_LABEL), the feature
# set's in its short form.
CHECKPOINT_LABEL = {
    "baseline_confirm": "Confirm the baseline",
    "feature_set": "Feature set",
    "priority_order": "Priority order",
    "prd_review": "PRD review",
    "eng_review": "Engineering review",
    "roadmap_items": "Roadmap items",
    "roadmap_review": "Roadmap review",
}
# Checkpoints that are a review (journey step 8); the others stop a draft run (step 7).
REVIEWS = ("prd_review", "roadmap_review")
SEGMENT_TITLES = {s.name: s.title for f in flows.FLOWS.values() for s in f.segments}
# The item history lists the newest imports of its tracker issues, this many (#577 review).
TRACKER_HISTORY_LIMIT = 20
# The fields the history names, in this order; the tracker's own status name is not one.
SHOWN_FIELDS = ("state", "target_date", "estimate")
HEALTH_WORD = {"on_track": "On track", "at_risk": "At risk", "off_track": "Off track"}


def _may(viewer_role: str, role: str) -> bool:
    return RANK.get(viewer_role, -1) >= RANK.get(role, len(RANK))


def checkpoint_line(
    kind: str,
    segment: str | None,
    approver_role: str,
    viewer_role: str,
    viewer_id: uuid.UUID | None,
    lead_id: uuid.UUID | None,
) -> tuple[str, int, bool]:
    """A run waiting at a checkpoint: its stage line, journey step, and whether the viewer
    may decide it. Baseline to PRD's engineering stops (F4) name their segment ("check"
    or "dates") and wait for the engineering lead once one is named (A3), else for the
    checkpoint's role."""
    if kind == "eng_review":
        label = "Engineering dates" if segment and "date" in segment else "Engineering check"
        if lead_id is not None:
            mine, who = viewer_id is not None and viewer_id == lead_id, "the engineering lead"
        else:
            mine, who = _may(viewer_role, approver_role), approver_role
    else:
        label = CHECKPOINT_LABEL.get(kind, kind.replace("_", " ").capitalize())
        mine, who = _may(viewer_role, approver_role), approver_role
    step = 8 if kind in REVIEWS else 7
    return f"{label} · waiting for {'you' if mine else who}", step, mine


@dataclass
class PrdFacts:
    """What the stage of a PRD is read from (:func:`stage_of`)."""

    latest: int | None = None
    approved: int | None = None
    in_review: bool = False
    track_status: str | None = None
    track_has_records: bool = False
    # (kind, segment name, approver role) of the pending checkpoint of an unfinished run.
    checkpoint: tuple[str, str | None, str] | None = None
    # The title of the segment a running run is at.
    running: str | None = None
    # The roadmap draft (version number) with items built from the latest PRD version.
    roadmap_draft: int | None = None


def stage_of(
    f: PrdFacts, viewer_role: str, viewer_id: uuid.UUID | None, lead_id: uuid.UUID | None
) -> tuple[str, str, int, bool]:
    """(stage, stage line, journey step, waiting for the viewer): the first rule that
    matches (F1 §4)."""
    if f.track_status in ("closed", "paused"):
        return f.track_status, f.track_status.capitalize(), 9, False
    if f.checkpoint is not None:
        kind, segment, role = f.checkpoint
        line, step, mine = checkpoint_line(kind, segment, role, viewer_role, viewer_id, lead_id)
        return "waiting", line, step, mine
    if f.running is not None:
        return "drafting", f"Drafting · {f.running}", 7, False
    if f.approved is not None:
        if f.latest is not None and f.latest > f.approved:
            if f.in_review:
                return "in_review", f"Approved v{f.approved} · draft {f.latest} in review", 8, False
            return "draft", f"Approved v{f.approved} · draft {f.latest}", 8, False
        if f.track_has_records:
            return "in_build", f"Approved v{f.approved} · in build", 9, False
        return "approved", f"Approved v{f.approved}", 9, False
    if f.latest is not None:
        if f.in_review:
            line = f"Draft {f.latest} in review"
            if f.roadmap_draft is not None:
                line += f" · roadmap draft {f.roadmap_draft}"
            return "in_review", line, 8, False
        return "draft", f"Draft {f.latest}", 8, False
    return "idea", "Brief", 1, False


def item_state(origin: str, risk: views.ItemRisk, records: list, horizon: str) -> str:
    """The item's state chip: the first rule that matches (F1 §5)."""
    if origin == "draft":
        return "proposed"
    if risk.done:
        return "done"
    if risk.passed or any(d.kind == "overdue" for d in risk.drift):
        return "slipped"
    if risk.reasons:
        return "at_risk"
    if horizon == "now" and records:
        return "on_track"
    return "planned"


def _who(role: str, user_id: uuid.UUID | None = None) -> PlanWho:
    return PlanWho(role=role, user_id=user_id)  # type: ignore[arg-type]


def next_of(
    origin: str,
    item: RoadmapItem,
    risk: views.ItemRisk,
    engineering: PlanEngineering,
    blockers: list[Any],
    track: ProductTrack | None,
    prd_href: str | None,
    viewer_role: str,
    lead_id: uuid.UUID | None,
) -> PlanNext:
    """The next decision on the item and who makes it: the first rule that matches
    (F1 §7). ``who`` names a person when one is set, else the role."""
    lead = _who("engineering_lead", lead_id) if lead_id is not None else _who("approver")

    def decision(action: str, label: str, who: PlanWho, href: str | None = None) -> PlanNext:
        role = "approver" if who.role in ("engineering_lead", "track_owner") else who.role
        return PlanNext(action=action, label=label, who=who, href=href,  # type: ignore[arg-type]
                        viewer_may=_may(viewer_role, role))  # fmt: skip

    if origin == "draft":
        return decision("review_prd", "PRD review", _who("approver"), prd_href)
    if engineering.date_status == "unverified":
        return decision("verify_date", "Verify date", lead)
    if engineering.date_status == "withdrawn":
        return decision("reverify_date", "Re-verify date", lead)
    if risk.passed or any(d.kind in ("date_slip", "overdue") for d in risk.drift):
        if track is not None and track.owner_id is not None:
            return decision("decide_slip", "Decide on slip", _who("track_owner", track.owner_id))
        return decision("decide_slip", "Decide on slip", _who("owner"))
    open_blockers = [b for b in blockers if not b.resolved]
    if open_blockers:
        critical = any(b.critical for b in open_blockers)
        return decision(
            "resolve_blocker",
            "Resolve blocker",
            _who("owner" if critical else "approver"),
            f"/baseline?entity={open_blockers[0].id}",
        )
    if any(r["kind"] == "stale" for r in risk.reasons):
        return decision("reconcile", "Reconcile", _who("approver"))
    if item.horizon in ("now", "next") and not engineering.tracked:
        return decision("link_issue", "Link issue", lead)
    return PlanNext(action=None, label="—", who=None)


def _change(d: diff.ItemDiff) -> ItemChange:
    kind = {"added": "new"}.get(d.status, d.status)
    out = ItemChange(
        kind=kind,  # type: ignore[arg-type]
        fields=[c.field for c in d.changes],
        notes=[n.field for n in d.notes],
    )
    if d.status == "moved" and d.base is not None and d.head is not None:
        out.from_horizon, out.to_horizon = d.base.horizon, d.head.horizon  # type: ignore[assignment]
    return out


@dataclass
class _Read:
    """Everything one Plan read loads, by id."""

    docs: dict[uuid.UUID, Document]
    versions: dict[uuid.UUID, Any]
    by_doc: dict[uuid.UUID, list[Any]]
    with_items: set[uuid.UUID]
    items: dict[uuid.UUID, list[RoadmapItem]] = field(default_factory=dict)

    def number(self, version_id: uuid.UUID | None) -> int | None:
        v = self.versions.get(version_id) if version_id else None
        return v.number if v is not None else None

    def latest_approved(self, doc_id: uuid.UUID) -> Any:
        return next((v for v in reversed(self.by_doc[doc_id]) if v.approved_at), None)

    def approved_with_items(self, doc_id: uuid.UUID) -> Any:
        return next(
            (v for v in reversed(self.by_doc[doc_id]) if v.approved_at and v.id in self.with_items),
            None,
        )

    def draft_with_items(self, doc_id: uuid.UUID) -> Any:
        """The latest unapproved version with items, newer than the approved one."""
        approved = self.approved_with_items(doc_id)
        for v in reversed(self.by_doc[doc_id]):
            if approved is not None and v.number <= approved.number:
                return None
            if v.approved_at is None and v.id in self.with_items:
                return v
        return None

    def followed(self, doc_id: uuid.UUID) -> Any:
        """The version a track follows (views.items_version, approved first)."""
        vs = self.by_doc[doc_id]
        return (
            self.approved_with_items(doc_id)
            or next((v for v in reversed(vs) if v.id in self.with_items), None)
            or (vs[-1] if vs else None)
        )


async def _load(db: AsyncSession) -> _Read:
    docs = {d.id: d for d in await db.scalars(select(Document))}
    rows = (
        await db.execute(
            select(
                DocumentVersion.id,
                DocumentVersion.document_id,
                DocumentVersion.number,
                DocumentVersion.approved_at,
                DocumentVersion.source_version_id,
            ).order_by(DocumentVersion.document_id, DocumentVersion.number)
        )
    ).all()
    by_doc: dict[uuid.UUID, list[Any]] = defaultdict(list)
    for v in rows:
        by_doc[v.document_id].append(v)
    with_items = set(await db.scalars(select(RoadmapItem.roadmap_version_id).distinct()))
    return _Read(docs, {v.id: v for v in rows}, by_doc, with_items)


async def _goals(db: AsyncSession, rows: list[RoadmapItem]) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Feature id -> the goals it supports (``supports`` edges), in goal key order."""
    features = {i.feature_id for i in rows if i.feature_id}
    out: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    if not features:
        return out
    for src, dst in (
        await db.execute(
            select(Edge.src_id, Edge.dst_id)
            .join(Entity, Entity.id == Edge.dst_id)
            .where(
                Edge.type == "supports",
                Edge.status != "rejected",
                Edge.src_id.in_(features),
                Entity.type == "goal",
                Entity.status != "rejected",
            )
            .order_by(Entity.key)
        )
    ).all():
        out[src].append(dst)
    return out


def _withdrawn_bases(
    item: RoadmapItem, records: list[TrackerRecord], withdrawn: list[ScheduleBasis]
) -> list[schedule.Basis]:
    """The item's PRD's withdrawn bases with their scope, as schedule.bases_by_status
    scopes them: one item, the items a tracker issue is matched to (the item's own
    records name the issues matched to it), or the whole PRD."""
    refs = {r.external_ref for r in records}
    out = []
    for b in withdrawn:
        if b.prd_document_id != item.prd_document_id:
            continue
        scope: frozenset[str] | None = None
        if b.item_key:
            scope = frozenset({b.item_key})
        elif b.tracker_key:
            scope = frozenset({item.item_key}) if b.tracker_key in refs else frozenset()
        out.append(
            schedule.Basis(
                b.id,
                b.kind,
                b.reference,
                b.supports_date,
                b.prd_document_id,
                scope,
                b.item_key,
                b.tracker_key,
            )
        )
    return out


def _engineering(
    item: RoadmapItem,
    records: list[TrackerRecord],
    milestone: dict[str, Any] | None,
    dated: dict[str, date],
    withdrawn: list[ScheduleBasis],
) -> PlanEngineering:
    ms = milestone or {}
    day: date | None = None
    status = None
    basis_ids: list[uuid.UUID] = []
    if ms.get("date"):
        day, status = schedule.as_date(ms["date"]), "verified"
        # items.recheck_date kept the date on these (schedule.supporting).
        basis_ids = [uuid.UUID(str(b)) for b in ms.get("basis_ids") or []]
    elif ms.get("refused_date"):
        day = schedule.as_date(ms["refused_date"])
        source = ms.get("date_source") or ""
        named = any(
            b.prd_document_id == item.prd_document_id and schedule._names(b.reference, source)
            for b in withdrawn
        )
        status = "withdrawn" if named else "unverified"
        if named:
            basis_ids = [
                b.id
                for b in schedule.supporting(
                    day, source, _withdrawn_bases(item, records, withdrawn), item.item_key
                )
            ]
    when = tracker.milestone_date(item, dated, milestone)
    slips = [
        (r.target_date - when).days
        for r in records
        if when is not None
        and r.state not in ("done", "cancelled")
        and r.target_date
        and r.target_date > when
    ]
    return PlanEngineering(
        records=[tracker.ref(r) for r in records],
        date=day,
        date_status=status,  # type: ignore[arg-type]
        basis_ids=sorted(basis_ids, key=str),
        slip_days=max(slips) if slips else None,
        tracked=bool(records),
    )


async def build(db: AsyncSession, principal: Principal, scope: PlanScope = "all") -> PlanOut:
    """The Plan as ``principal`` sees it (F1 §11)."""
    now = views.today()
    viewer_role, viewer_id = principal.role, principal.user_id
    # The company's engineering lead (A3 Engineering lead role); none can be named yet,
    # so engineering decisions fall to the approvers.
    lead_id: uuid.UUID | None = None
    read = await _load(db)
    tracks = list(await db.scalars(select(ProductTrack)))
    track_of_prd = {t.prd_document_id: t for t in tracks}
    live = [t for t in tracks if t.status in LIVE_TRACKS]
    runs = list(
        await db.scalars(
            select(Run)
            .where(Run.status.in_(UNFINISHED), Run.document_id.is_not(None))
            .order_by(Run.created_at.desc())
        )
    )
    run_ids = [r.id for r in runs]
    pending: dict[uuid.UUID, Checkpoint] = {}
    segments: dict[uuid.UUID, list[RunSegment]] = defaultdict(list)
    if run_ids:
        for c in await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.run_id.in_(run_ids), Checkpoint.status == "pending")
            .order_by(Checkpoint.created_at)
        ):
            pending[c.run_id] = c
        for s in await db.scalars(
            select(RunSegment).where(RunSegment.run_id.in_(run_ids)).order_by(RunSegment.seq)
        ):
            segments[s.run_id].append(s)

    # The roadmap versions read: each roadmap's latest approved one with items, its
    # latest draft with items, and the one each live track follows.
    roadmaps = [d for d in read.docs.values() if d.kind == "roadmap"]
    approved_v = {r.id: read.approved_with_items(r.id) for r in roadmaps}
    draft_v = {r.id: read.draft_with_items(r.id) for r in roadmaps}
    followed = {
        t.id: read.followed(t.roadmap_document_id)
        for t in live
        if t.roadmap_document_id in read.docs
    }
    wanted = {v.id for v in [*approved_v.values(), *followed.values()] if v is not None}
    if scope == "all":
        wanted |= {v.id for v in draft_v.values() if v is not None}
    rows: list[RoadmapItem] = []
    if wanted:
        rows = list(
            await db.scalars(
                select(RoadmapItem)
                .where(RoadmapItem.roadmap_version_id.in_(wanted))
                .order_by(RoadmapItem.position, RoadmapItem.item_key)
            )
        )
    for i in rows:
        read.items.setdefault(i.roadmap_version_id, []).append(i)
    ctx = await views.ItemContext.load(db, rows)
    goals = await _goals(db, rows)

    live_ids = [t.id for t in live]
    milestones: dict[uuid.UUID, list[TrackMilestone]] = defaultdict(list)
    records: dict[uuid.UUID, list[TrackerRecord]] = defaultdict(list)
    bases: list[ScheduleBasis] = []
    if live_ids:
        for m in await db.scalars(
            select(TrackMilestone)
            .where(TrackMilestone.track_id.in_(live_ids))
            .order_by(TrackMilestone.target_date.nulls_last(), TrackMilestone.created_at)
        ):
            milestones[m.track_id].append(m)
        for r in await db.scalars(
            select(TrackerRecord)
            .where(TrackerRecord.track_id.in_(live_ids))
            .order_by(TrackerRecord.tracker, TrackerRecord.external_ref)
        ):
            records[r.track_id].append(r)
        chosen = [views.chosen_milestone(milestones[t], now) for t in live_ids]
        basis_ids = {b for m in chosen if m is not None for b in m.basis_ids or []}
        if basis_ids:
            bases = list(
                await db.scalars(select(ScheduleBasis).where(ScheduleBasis.id.in_(basis_ids)))
            )
    withdrawn = list(
        await db.scalars(select(ScheduleBasis).where(ScheduleBasis.status == "withdrawn"))
    )

    # Each live track assessed as GET /v1/tracks/{id} assesses it.
    health: dict[uuid.UUID, str] = {}
    risks: dict[uuid.UUID, views.ItemRisk] = {}
    for t in live:
        roadmap = read.docs.get(t.roadmap_document_id) if t.roadmap_document_id else None
        version = followed.get(t.id)
        approved = read.latest_approved(t.prd_document_id)
        base = views.track_out_of(
            t,
            read.docs.get(t.prd_document_id),
            roadmap,
            version,
            started=read.number(t.started_version_id),
            current=read.number(t.current_version_id),
            latest_approved=approved.number if approved else None,
        )
        overview, item_risks = views.assess(
            t,
            base,
            read.items.get(version.id, []) if version is not None else [],
            ctx,
            milestones[t.id],
            records[t.id],
            bases,
            read.number(version.source_version_id) if version is not None else None,
            now,
        )
        health[t.id] = overview.health
        risks.update(item_risks)
    tracks_by_id = {t.id: t for t in tracks}

    def prd_of_roadmap(r: Document) -> uuid.UUID | None:
        for v in reversed(read.by_doc[r.id]):
            src = read.versions.get(v.source_version_id) if v.source_version_id else None
            if src is not None:
                return src.document_id
        return None

    drift_of = await _drift(db, viewer_role)
    items: list[PlanItem] = []
    drafts_of_prd: dict[uuid.UUID, list[PlanItem]] = defaultdict(list)
    order = sorted(roadmaps, key=lambda d: d.updated_at, reverse=True)
    for roadmap in order:
        a = approved_v[roadmap.id]
        d = draft_v[roadmap.id] if scope == "all" else None
        a_rows = read.items.get(a.id, []) if a is not None else []
        d_rows = read.items.get(d.id, []) if d is not None else []
        if not a_rows and not d_rows:
            continue
        picked: list[tuple[RoadmapItem, Any, str, ItemChange | None]] = []
        if not d_rows:
            picked = [(i, a, "approved", None) for i in a_rows]
        else:

            def snap(i: RoadmapItem) -> diff.ItemSnapshot:
                return diff.snapshot_from_row(i, ctx.milestone_of(i))

            a_by_key = {i.item_key: i for i in a_rows}
            d_by_key = {i.item_key: i for i in d_rows}
            for entry in diff.diff_items(
                [snap(i) for i in a_rows], [snap(i) for i in d_rows]
            ).items:
                if entry.status == "dropped":
                    change = ItemChange(kind="dropped", draft_version=d.number)
                    picked.append((a_by_key[entry.key], a, "approved", change))
                else:
                    picked.append((d_by_key[entry.key], d, "draft", _change(entry)))
        fallback_prd = prd_of_roadmap(roadmap)
        for row, rv, origin, change in picked:
            item = _item(
                row, rv, roadmap, origin, change, read, ctx, goals, risks, tracks_by_id,
                milestones, withdrawn, fallback_prd, viewer_role, lead_id, now,
            )  # fmt: skip
            item.drift = drift_of(row, origin)
            items.append(item)
            if origin == "draft" and (row.prd_document_id or fallback_prd):
                drafts_of_prd[row.prd_document_id or fallback_prd].append(item)

    # The PRDs in play (F1 §4).
    run_of_prd: dict[uuid.UUID, Run] = {}
    for r in runs:
        have = run_of_prd.get(r.document_id)
        if have is None or (r.id in pending and have.id not in pending):
            run_of_prd[r.document_id] = r
    draft_sources = {v.source_version_id: v.number for v in draft_v.values() if v is not None}
    cards: list[tuple[tuple, PlanPrd]] = []
    for doc in read.docs.values():
        if doc.kind != "prd":
            continue
        vs = read.by_doc[doc.id]
        latest = vs[-1] if vs else None
        track = track_of_prd.get(doc.id)
        run = run_of_prd.get(doc.id)
        if not (
            (track is not None and track.status in LIVE_TRACKS)
            or run is not None
            or latest is None
            or latest.approved_at is None
        ):
            continue
        approved = read.latest_approved(doc.id)
        cp = pending.get(run.id) if run is not None else None
        running = None
        if run is not None and cp is None and run.status == "running":
            seg = next((s for s in segments[run.id] if s.status == "running"), None) or next(
                (s for s in segments[run.id] if s.status == "pending"), None
            )
            running = SEGMENT_TITLES.get(seg.name, seg.name) if seg is not None else "draft run"
        facts = PrdFacts(
            latest=latest.number if latest else None,
            approved=approved.number if approved else None,
            in_review=doc.status == "in_review",
            track_status=track.status if track is not None else None,
            track_has_records=bool(track is not None and records.get(track.id)),
            checkpoint=(cp.kind, (cp.payload or {}).get("segment"), cp.approver_role)
            if cp is not None
            else None,
            running=running,
            roadmap_draft=draft_sources.get(latest.id) if latest is not None else None,
        )
        stage, line, step, mine = stage_of(facts, viewer_role, viewer_id, lead_id)
        word = HEALTH_WORD.get(health.get(track.id, "")) if track is not None else None
        drafts = drafts_of_prd.get(doc.id, [])
        figure = None
        if word:
            figure = word
        elif drafts:
            moved = sum(1 for i in drafts if i.change and i.change.kind == "moved")
            figure = f"{len(drafts)} items" + (f" · {moved} moved" if moved else "")
        elif cp is not None and isinstance((cp.payload or {}).get("features"), list):
            figure = f"{len(cp.payload['features'])} features"
        out = PlanPrd(
            document=PlanDocument(id=doc.id, slug=doc.slug, title=doc.title),
            stage=stage,  # type: ignore[arg-type]
            stage_label=line,
            journey_step=step,
            latest_version=facts.latest,
            approved_version=facts.approved,
            run=PlanRun(
                id=run.id,
                status=run.status,
                checkpoint=cp.kind if cp is not None else None,
                checkpoint_role=cp.approver_role if cp is not None else None,
                segment=running,
            )
            if run is not None
            else None,
            track=PlanTrack(
                id=track.id,
                status=track.status,  # type: ignore[arg-type]
                health=health.get(track.id, track.status),  # type: ignore[arg-type]
                owner_id=track.owner_id,
            )
            if track is not None
            else None,
            figure=figure,
            waiting_for_viewer=mine,
            updated_at=doc.updated_at,
        )
        risky = track is not None and health.get(track.id) in ("at_risk", "off_track")
        cards.append(((not mine, not risky, -doc.updated_at.timestamp(), doc.slug), out))
    prds = [c for _, c in sorted(cards, key=lambda c: c[0])]
    return PlanOut(
        scope=scope,
        generated_at=datetime.now(UTC),
        counts=PlanCounts(
            prds=len(prds),
            at_risk=sum(1 for i in items if i.state in ("at_risk", "slipped")),
            proposed=sum(1 for i in items if i.origin == "draft"),
            items=len(items),
        ),
        prds=prds,
        items=items,
    )


async def _drift(
    db: AsyncSession, viewer_role: str
) -> Callable[[RoadmapItem, str], list[PlanDrift]]:
    """Each item's drift (H4 §5), for owners and approvers (who sees it): an approved
    item's stored findings, open or waived; a draft item's measured now (E1 "draft")."""
    if not has_role(viewer_role, "approver"):
        return lambda row, origin: []
    graph = await drift.load_for_items(db)
    stored: dict[uuid.UUID, list[StrategyFinding]] = defaultdict(list)
    for f in await db.scalars(
        select(StrategyFinding).where(
            StrategyFinding.subject_kind == "roadmap_item",
            StrategyFinding.kind.in_(drift.ITEM_KINDS),
            StrategyFinding.status.in_(("open", "waived")),
        )
    ):
        stored[f.subject_id].append(f)  # type: ignore[index]

    def of(row: RoadmapItem, origin: str) -> list[PlanDrift]:
        live = {d.kind: d for d in drift.item_drift(graph, row.feature_id, row.horizon)}
        if origin == "draft":
            return [
                PlanDrift(kind=d.kind, severity=d.severity, label=d.label, text=d.text,
                          status="open")  # type: ignore[arg-type]
                for d in live.values()
            ]  # fmt: skip
        out = [
            PlanDrift(
                kind=f.kind,  # type: ignore[arg-type]
                severity=f.severity,  # type: ignore[arg-type]
                label=drift.ITEM_LABELS[f.kind],
                text=live[f.kind].text if f.kind in live else STALE_DRIFT[f.kind],
                status=f.status,  # type: ignore[arg-type]
                finding_id=f.id,
                waive_reason=f.waive_reason,
                waived_at=f.waived_at,
            )
            for f in stored.get(row.id, [])
        ]
        return sorted(out, key=lambda d: (d.severity != "high", d.kind))

    return of


# A stored finding's words when the strategy moved since the last check measured it.
STALE_DRIFT = {
    "outside_strategy": "Outside the product strategy at the last check.",
    "stopped_but_planned": "On the product strategy's stop list at the last check.",
}


def _item(
    row: RoadmapItem,
    rv: Any,
    roadmap: Document,
    origin: str,
    change: ItemChange | None,
    read: _Read,
    ctx: views.ItemContext,
    goals: dict[uuid.UUID, list[uuid.UUID]],
    risks: dict[uuid.UUID, views.ItemRisk],
    tracks: dict[uuid.UUID, ProductTrack],
    milestones: dict[uuid.UUID, list[TrackMilestone]],
    withdrawn: list[ScheduleBasis],
    fallback_prd: uuid.UUID | None,
    viewer_role: str,
    lead_id: uuid.UUID | None,
    now: date,
) -> PlanItem:
    track = tracks.get(row.track_id) if row.track_id else None
    track_milestones = milestones.get(row.track_id, []) if row.track_id else []
    dated = views.dated_items(track_milestones)
    if origin == "draft":
        risk = views.ItemRisk()
    else:
        risk = risks.get(row.id) or views.item_risk(row, ctx, track_milestones, dated, now)
    records = sorted(ctx.records_of(row), key=lambda r: r.external_ref)
    engineering = _engineering(row, records, ctx.milestone_of(row), dated, withdrawn)
    doc = read.docs.get(row.prd_document_id or fallback_prd)  # type: ignore[arg-type]
    pv = read.versions.get(row.prd_version_id) if row.prd_version_id else None
    prd = None
    prd_href = None
    if doc is not None:
        link = None
        if pv is not None:
            prd_href = f"/documents/{doc.slug}/v/{pv.number}"
            link = flows.prd_link(doc.slug, pv.number, row.prd_section_key or "").rstrip("#")
        prd = PlanItemPrd(
            id=doc.id,
            slug=doc.slug,
            title=doc.title,
            version=pv.number if pv is not None else None,
            approved=pv is not None and pv.approved_at is not None,
            link=link,
        )
    blockers = [views.blocker_dependency(e) for e in ctx.blockers.get(row.id, [])]
    return PlanItem(
        id=row.id,
        key=row.item_key,
        title=row.title,
        outcome=row.outcome,
        horizon=row.horizon,  # type: ignore[arg-type]
        position=row.position,
        origin=origin,  # type: ignore[arg-type]
        change=change,
        prd=prd,
        roadmap=PlanItemRoadmap(
            slug=roadmap.slug, version=rv.number, anchor=f"{row.horizon}-{row.item_key}"
        ),
        track_id=row.track_id,
        goal_ids=goals.get(row.feature_id, []) if row.feature_id else [],
        feature=views.entity_ref(ctx.entities[row.feature_id])
        if row.feature_id in ctx.entities
        else None,
        requirements=[
            views.entity_ref(ctx.entities[r])
            for r in row.requirement_ids or []
            if r in ctx.entities
        ],
        state=item_state(origin, risk, records, row.horizon),  # type: ignore[arg-type]
        reasons=[PlanReason(**r) for r in risk.reasons],
        engineering=engineering,
        next=next_of(
            origin, row, risk, engineering, blockers, track, prd_href, viewer_role, lead_id
        ),  # fmt: skip
    )


async def item_history(db: AsyncSession, roadmap: Document, key: str) -> ItemHistoryOut:
    """The item across the roadmap's versions, one entry per version that has it."""
    rows = (
        await db.execute(
            select(
                DocumentVersion.number,
                DocumentVersion.approved_at,
                RoadmapItem.horizon,
                RoadmapItem.prd_version_id,
                RoadmapItem.track_id,
                RoadmapItem.prd_document_id,
            )
            .join(RoadmapItem, RoadmapItem.roadmap_version_id == DocumentVersion.id)
            .where(DocumentVersion.document_id == roadmap.id, RoadmapItem.item_key == key)
            .order_by(DocumentVersion.number)
        )
    ).all()
    prd_ids = {r.prd_version_id for r in rows if r.prd_version_id}
    numbers: dict[uuid.UUID, int] = {}
    if prd_ids:
        numbers = dict(
            (
                await db.execute(
                    select(DocumentVersion.id, DocumentVersion.number).where(
                        DocumentVersion.id.in_(prd_ids)
                    )
                )
            ).all()
        )
    events, older = await _tracker_events(db, rows, key)
    return ItemHistoryOut(
        roadmap=roadmap.slug,
        item=key,
        versions=[
            ItemVersion(
                version=r.number,
                prd_version=numbers.get(r.prd_version_id) if r.prd_version_id else None,
                horizon=r.horizon,
                approved_at=r.approved_at,
            )
            for r in rows
        ],
        tracker_events=events,
        tracker_events_older=older,
    )


async def _tracker_events(
    db: AsyncSession, rows: list[Any], key: str
) -> tuple[list[ItemTrackerEvent], int]:
    """The tracker history of the item's issues (F2 §2): one entry per import of an issue
    (its events share the record, the observed time and the transaction's ``created_at``),
    naming every field it changed; the newest TRACKER_HISTORY_LIMIT, oldest first, and how
    many older ones are left out. The records are those matched to the key on the item's
    track, or by its PRD (F7), as the Plan matches them. A change of the tracker's own status
    name alone is no entry: the state says it in Oracle's words."""
    tracks = {r.track_id for r in rows if r.track_id}
    prds = {r.prd_document_id for r in rows if r.prd_document_id}
    if not tracks and not prds:
        return [], 0
    matched = []
    if tracks:
        matched.append(TrackerRecord.track_id.in_(tracks))
    if prds:
        matched.append(TrackerRecord.prd_document_id.in_(prds))
    E = TrackerRecordEvent  # noqa: N806
    shown_fields = E.field.in_(SHOWN_FIELDS)
    imports = (
        await db.execute(
            select(E.record_id, E.observed_at, E.created_at, func.count().over().label("total"))
            .join(TrackerRecord, TrackerRecord.id == E.record_id)
            .where(TrackerRecord.item_key == key, or_(*matched), shown_fields)
            .group_by(E.record_id, E.observed_at, E.created_at)
            .order_by(E.observed_at.desc(), E.created_at.desc(), E.record_id)
            .limit(TRACKER_HISTORY_LIMIT)
        )
    ).all()
    if not imports:
        return [], 0
    found = await db.execute(
        select(E, TrackerRecord.tracker, TrackerRecord.external_ref)
        .join(TrackerRecord, TrackerRecord.id == E.record_id)
        .where(
            tuple_(E.record_id, E.observed_at, E.created_at).in_(
                [(i.record_id, i.observed_at, i.created_at) for i in imports]
            ),
            shown_fields,
        )
    )
    groups: dict[tuple, ItemTrackerEvent] = {}
    for e, tracker_name, ref in found.all():
        group = groups.setdefault(
            (e.record_id, e.observed_at, e.created_at),
            ItemTrackerEvent(
                record_id=e.record_id, tracker=tracker_name, external_ref=ref,
                observed_at=e.observed_at, changes=[],
            ),
        )  # fmt: skip
        group.changes.append(TrackerFieldChange(field=e.field, before=e.before, after=e.after))  # type: ignore[arg-type]
    for g in groups.values():
        g.changes.sort(key=lambda c: SHOWN_FIELDS.index(c.field))
    ordered = [groups[(i.record_id, i.observed_at, i.created_at)] for i in reversed(imports)]
    return ordered, imports[0].total - len(imports)
