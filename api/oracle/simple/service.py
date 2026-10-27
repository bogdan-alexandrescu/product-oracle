"""Simple S2 (#723): the company-wide roadmap read (``GET /v1/simple/roadmap``).

Every roadmap's items on one timeline: for each roadmap document the reader may see
(oracle.docs.visibility: an approvers-only roadmap is absent for commenters and viewers),
the items of its latest approved version with items, else of its latest version with
items. Each item comes with its resolved dates and phases (oracle.simple.dates), its open
date suggestion (oracle.simple.suggestions), its milestone, dependencies both ways, goal
(the first confirmed goal its feature supports, in goal key order), track, PRD, status and
constraint flags (oracle.simple.constraints).

S3b: a roadmap's working draft (oracle.simple.drafts) is read in place of its published
items by those who may see it (``overlays``); everyone else gets the published version and
``changes_in_review``. A version submitted from a draft is never shown before it is
approved.

It reads in bulk, a fixed number of statements whatever the company's size, and writes
nothing. :func:`load` is also what the daily suggestions read, as Oracle (no principal).
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.members.names import display_name
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapChangeSet,
    RoadmapItem,
    ScheduleBasis,
    TrackerRecord,
    TrackMilestone,
)
from oracle.simple import constraints, dates
from oracle.simple.models import RoadmapDateSuggestion
from oracle.simple.schemas import (
    DateSuggestionOut,
    SimpleDate,
    SimpleDocRef,
    SimpleFlag,
    SimpleGoalRef,
    SimpleGroup,
    SimpleItemMilestone,
    SimpleMilestone,
    SimpleOpenDecision,
    SimpleOwnerRef,
    SimplePhase,
    SimpleRoadmapItem,
    SimpleRoadmapOut,
    SimpleTrackRef,
    SimpleWindow,
    SimpleWindows,
)
from oracle.tenant_settings_api import company_horizons
from oracle.v2.models import FeasibilityExperiment

OPEN_BLOCKER = ("open", "mitigating")
LIVE_EXPERIMENTS = ("planned", "running")
OPEN_CHANGE_SETS = ("draft", "proposed")
NONE = "none"


@dataclass
class Entry:
    row: RoadmapItem
    roadmap: Document
    prd: Document | None
    track: ProductTrack | None
    goal: Entity | None
    window: tuple[date, date]
    resolved: dates.Resolved
    status: str
    milestone: SimpleItemMilestone | None
    depends_on: list[uuid.UUID] = field(default_factory=list)
    needed_by: list[uuid.UUID] = field(default_factory=list)
    blockers: list[constraints.Blocker] = field(default_factory=list)
    suggestion: RoadmapDateSuggestion | None = None
    flags: list[constraints.Flag] = field(default_factory=list)
    # The track owner's role now (None: no owner, or a disabled one): D-a.
    owner_role: str | None = None
    # S4: the track owner's name (or e-mail) when enabled.
    owner_name: str | None = None


@dataclass
class Read:
    today: date
    windows: dict[str, tuple[date, date]]
    entries: list[Entry]
    milestones: list[TrackMilestone]
    # Roadmap document id -> its designated decider (None: none).
    deciders: dict[uuid.UUID, uuid.UUID | None]

    def by_id(self) -> dict[uuid.UUID, Entry]:
        return {e.row.id: e for e in self.entries}


def owner_decides(entry: Entry) -> uuid.UUID | None:
    """D-a: the item's track owner, when the roadmap names no decider is theirs to act as
    decider only while their role is approver or owner; None otherwise."""
    if entry.track is None or entry.track.owner_id is None or entry.owner_role is None:
        return None
    return entry.track.owner_id if has_role(entry.owner_role, "approver") else None  # type: ignore[arg-type]


def decider_ids(entry: Entry, deciders: dict[uuid.UUID, uuid.UUID | None]) -> list[uuid.UUID]:
    """Who decides on this item, the company's owners apart (D-a): the roadmap's decider,
    else its deciding track owner; [] when the company's owners decide."""
    decider = deciders.get(entry.roadmap.id)
    if decider is not None:
        return [decider]
    owner = owner_decides(entry)
    return [owner] if owner is not None else []


def can_decide(principal: Any, entry: Entry, deciders: dict[uuid.UUID, uuid.UUID | None]) -> bool:
    """Who accepts, edits or dismisses a date suggestion and applies a change (#723 owner
    answer, D-a): an owner; the roadmap's decider; with no decider, the item's track owner
    when their role is approver or owner, else the company's owners. A viewer or commenter
    who owns a track decides nothing."""
    if principal is None:
        return False
    if has_role(principal.role, "owner"):
        return True
    user_id = getattr(principal, "user_id", None)
    if user_id is None:
        return False
    decider = deciders.get(entry.roadmap.id)
    if decider is not None:
        return decider == user_id
    return (
        entry.track is not None
        and entry.track.owner_id == user_id
        and has_role(principal.role, "approver")
    )


def _versions(
    rows: list[Any], with_items: set[uuid.UUID], hidden: set[uuid.UUID] | None = None
) -> dict[uuid.UUID, uuid.UUID]:
    """Roadmap document id -> the version whose items are shown."""
    by_doc: dict[uuid.UUID, list[Any]] = defaultdict(list)
    for v in rows:
        if v.id in with_items and v.id not in (hidden or set()):
            by_doc[v.document_id].append(v)
    out = {}
    for doc_id, vs in by_doc.items():
        vs.sort(key=lambda v: v.number)
        approved = [v for v in vs if v.approved_at is not None]
        out[doc_id] = (approved or vs)[-1].id
    return out


async def load(db: AsyncSession, overlays: dict[uuid.UUID, dict[str, Any]] | None = None) -> Read:
    """Everything the read needs, as the session's principal may see it; ``overlays``
    (roadmap document id -> {item id -> fields}): the working drafts the reader sees."""
    from oracle.simple import drafts

    today = await company_time.company_today(db)
    windows = dates.windows(await company_horizons(db), today)
    docs = {
        d.id: d
        for d in await db.scalars(select(Document).where(Document.kind.in_(("roadmap", "prd"))))
    }
    roadmap_ids = [d.id for d in docs.values() if d.kind == "roadmap"]
    entries: list[Entry] = []
    if not roadmap_ids:
        return Read(today, windows, entries, [], {})
    versions = (
        await db.execute(
            select(
                DocumentVersion.id,
                DocumentVersion.document_id,
                DocumentVersion.number,
                DocumentVersion.approved_at,
            ).where(DocumentVersion.document_id.in_(roadmap_ids))
        )
    ).all()
    with_items = set(
        await db.scalars(
            select(RoadmapItem.roadmap_version_id)
            .where(RoadmapItem.roadmap_document_id.in_(roadmap_ids))
            .distinct()
        )
    )
    shown = _versions(versions, with_items, await drafts.submitted_versions(db))
    rows: list[RoadmapItem] = []
    if shown:
        rows = list(
            await db.scalars(
                select(RoadmapItem)
                .where(RoadmapItem.roadmap_version_id.in_(list(shown.values())))
                .order_by(RoadmapItem.position, RoadmapItem.item_key)
            )
        )
    if overlays:
        rows = [
            drafts.overlaid(r, overlays.get(r.roadmap_document_id, {}).get(str(r.id))) for r in rows
        ]
        # S7: the items added in Simple to the drafts the reader sees.
        rows += await drafts.added_rows(db, overlays)
        rows.sort(key=lambda r: (r.position, r.item_key))
    tracks: dict[uuid.UUID, ProductTrack] = {}
    owner_roles: dict[uuid.UUID, str] = {}
    owner_names: dict[uuid.UUID, str] = {}
    for t, role, name, email in (
        await db.execute(
            select(ProductTrack, User.role, User.name, User.email).outerjoin(
                User, (User.id == ProductTrack.owner_id) & User.disabled_at.is_(None)
            )
        )
    ).all():
        tracks[t.id] = t
        if role is not None:
            owner_roles[t.id] = role
            owner_names[t.id] = name or email
    track_of_prd = {t.prd_document_id: t for t in tracks.values()}
    milestones = list(
        await db.scalars(
            select(TrackMilestone).order_by(
                TrackMilestone.target_date.nulls_last(), TrackMilestone.created_at
            )
        )
    )
    keys = {r.item_key for r in rows}
    records: dict[tuple[Any, str], list[TrackerRecord]] = defaultdict(list)
    prd_records: dict[tuple[Any, str], list[TrackerRecord]] = defaultdict(list)
    if keys:
        for rec in await db.scalars(select(TrackerRecord).where(TrackerRecord.item_key.in_(keys))):
            if rec.track_id is not None:
                records[(rec.track_id, rec.item_key)].append(rec)
            else:
                prd_records[(rec.prd_document_id, rec.item_key)].append(rec)
    bases_by_key: dict[tuple[Any, str], list[ScheduleBasis]] = defaultdict(list)
    bases_by_ref: dict[tuple[Any, str], list[ScheduleBasis]] = defaultdict(list)
    for b in await db.scalars(
        select(ScheduleBasis).where(
            ScheduleBasis.status == "verified",
            (ScheduleBasis.item_key.is_not(None)) | (ScheduleBasis.tracker_key.is_not(None)),
        )
    ):
        if b.item_key:
            bases_by_key[(b.prd_document_id, b.item_key)].append(b)
        else:
            bases_by_ref[(b.prd_document_id, b.tracker_key)].append(b)
    goals = await _goals(db, {r.feature_id for r in rows if r.feature_id})
    # S7: the goals items are linked to directly (dropped on, suggested for).
    linked = {
        g.id: g
        for g in await db.scalars(
            select(Entity).where(
                Entity.id.in_({g for r in rows for g in r.goal_ids or []}),
                Entity.type == "goal",
            )
        )
    }
    blockers = await _blockers(db, {b for r in rows for b in r.blocker_ids or []})
    cut = await _cut(db, roadmap_ids)
    suggestions = {
        s.item_id: s
        for s in await db.scalars(
            select(RoadmapDateSuggestion).where(RoadmapDateSuggestion.status == "open")
        )
    }
    deciders = {
        p.document_id: p.decider_id
        for p in await db.scalars(
            select(DocumentReviewPolicy).where(DocumentReviewPolicy.document_id.in_(roadmap_ids))
        )
    }
    track_ms: dict[tuple[uuid.UUID, str], TrackMilestone] = {}
    for m in milestones:
        if m.status == "dropped":
            continue
        for k in m.item_keys or []:
            track_ms.setdefault((m.track_id, k), m)

    for row in rows:
        roadmap = docs[row.roadmap_document_id]
        prd = docs.get(row.prd_document_id) if row.prd_document_id else None
        track = tracks.get(row.track_id) if row.track_id else None
        if track is None and row.prd_document_id is not None:
            t = track_of_prd.get(row.prd_document_id)
            if t is not None and t.roadmap_document_id == roadmap.id:
                track = t
        recs = (
            records.get((track.id, row.item_key), []) if track is not None else []
        ) or prd_records.get((row.prd_document_id, row.item_key), [])
        window = windows.get(row.horizon, windows["now"])
        cands = _candidates(row, recs, bases_by_key, bases_by_ref)
        milestone = _milestone(row, track, track_ms)
        entries.append(
            Entry(
                row=row,
                roadmap=roadmap,
                prd=prd,
                track=track,
                goal=(goals.get(row.feature_id) if row.feature_id else None)
                or next((linked[g] for g in row.goal_ids or [] if g in linked), None),
                window=window,
                resolved=dates.resolve(cands, window),
                status=_status(row, recs, cut.get(roadmap.id, set())),
                milestone=milestone,
                blockers=[blockers[b] for b in row.blocker_ids or [] if b in blockers],
                suggestion=suggestions.get(row.id),
                owner_role=owner_roles.get(track.id) if track is not None else None,
                owner_name=owner_names.get(track.id) if track is not None else None,
            )
        )
    # Dependencies within each roadmap version, by item key.
    by_version: dict[tuple[Any, str], Entry] = {
        (e.row.roadmap_version_id, e.row.item_key): e for e in entries
    }
    for e in entries:
        for k in e.row.depends_on or []:
            dep = by_version.get((e.row.roadmap_version_id, k))
            if dep is not None and dep is not e:
                e.depends_on.append(dep.row.id)
                dep.needed_by.append(e.row.id)
    nodes = [
        constraints.Node(
            id=str(e.row.id),
            title=e.row.title,
            start=e.resolved.start,
            end=e.resolved.end,
            depends_on=[str(d) for d in e.depends_on],
            status=e.status,
            draft=e.row.draft,
            owner_id=str(e.track.owner_id) if e.track and e.track.owner_id else None,
            blockers=e.blockers,
            milestone=(e.milestone.name or "Milestone", e.milestone.date)
            if e.milestone is not None and e.milestone.date is not None
            else None,
            accepted_risks=list(e.row.accepted_risks or []),
        )
        for e in entries
    ]
    flags = constraints.check(nodes)
    for e in entries:
        e.flags = flags.get(str(e.row.id), [])
    shown_tracks = {e.track.id for e in entries if e.track is not None} | {
        t.id for t in tracks.values() if t.roadmap_document_id in docs
    }
    return Read(
        today, windows, entries, [m for m in milestones if m.track_id in shown_tracks], deciders
    )


def _candidates(
    row: RoadmapItem,
    recs: list[TrackerRecord],
    bases_by_key: dict[tuple[Any, str], list[ScheduleBasis]],
    bases_by_ref: dict[tuple[Any, str], list[ScheduleBasis]],
) -> list[dates.Candidate]:
    out: list[dates.Candidate] = []
    if row.start_date or row.end_date:
        out.append(dates.Candidate(row.start_date, row.end_date, row.date_source or "typed",
                                   row.updated_at))  # fmt: skip
    ms_date = dates.as_date((row.milestone or {}).get("date"))
    if ms_date is not None:
        out.append(dates.Candidate(None, ms_date, "engineering", row.updated_at))
    bases = list(bases_by_key.get((row.prd_document_id, row.item_key), []))
    for r in recs:
        bases += bases_by_ref.get((row.prd_document_id, r.external_ref), [])
    for b in bases:
        out.append(dates.Candidate(None, b.supports_date, "engineering",
                                   b.verified_at or b.created_at))  # fmt: skip
    for r in recs:
        if r.target_date is not None and r.state != "cancelled":
            out.append(dates.Candidate(None, r.target_date, "tracker", r.updated_at))
    return out


def _status(row: RoadmapItem, recs: list[TrackerRecord], cut: set[str]) -> str:
    if row.merged_into:
        return "merged"
    if row.draft:
        return "draft"
    if row.cut or row.item_key in cut:
        return "cut"
    states = {r.state for r in recs if r.state != "cancelled"}
    if states and states <= {"done"}:
        return "done"
    if states & {"in_progress", "done"}:
        return "in_progress"
    return "planned"


def _milestone(
    row: RoadmapItem,
    track: ProductTrack | None,
    track_ms: dict[tuple[uuid.UUID, str], TrackMilestone],
) -> SimpleItemMilestone | None:
    own = row.milestone or {}
    own_date = dates.as_date(own.get("date"))
    if own_date is not None:
        return SimpleItemMilestone(name=own.get("name"), date=own_date, source="item")
    m = track_ms.get((track.id, row.item_key)) if track is not None else None
    if m is not None:
        return SimpleItemMilestone(name=m.name, date=m.target_date, source="track")
    if own.get("name"):
        return SimpleItemMilestone(name=own.get("name"), date=None, source="item")
    return None


async def _goals(db: AsyncSession, features: set[uuid.UUID]) -> dict[uuid.UUID, Entity]:
    """Feature id -> the first confirmed goal it supports (goal key order)."""
    out: dict[uuid.UUID, Entity] = {}
    if not features:
        return out
    for edge_src, goal in (
        await db.execute(
            select(Edge.src_id, Entity)
            .join(Entity, Entity.id == Edge.dst_id)
            .where(
                Edge.type == "supports",
                Edge.status != "rejected",
                Edge.src_id.in_(features),
                Entity.type == "goal",
                Entity.status == "confirmed",
            )
            .order_by(Entity.key)
        )
    ).all():
        out.setdefault(edge_src, goal)
    return out


async def _blockers(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, constraints.Blocker]:
    """Each blocker's expected date: its live feasibility experiments' latest decision
    gate, else its own review date."""
    if not ids:
        return {}
    gates: dict[uuid.UUID, date] = {}
    for x in await db.scalars(
        select(FeasibilityExperiment).where(
            FeasibilityExperiment.blocker_id.in_(ids),
            FeasibilityExperiment.status.in_(LIVE_EXPERIMENTS),
            FeasibilityExperiment.decision_gate_at.is_not(None),
        )
    ):
        day = x.decision_gate_at.date()
        gates[x.blocker_id] = max(day, gates.get(x.blocker_id, day))
    out = {}
    for e in await db.scalars(select(Entity).where(Entity.id.in_(ids))):
        spec = (e.attrs or {}).get("blocker") or {}
        expected = gates.get(e.id) or dates.as_date(spec.get("review_at"))
        out[e.id] = constraints.Blocker(
            id=str(e.id),
            title=e.title,
            expected=expected,
            open=spec.get("status", "open") in OPEN_BLOCKER and e.status != "rejected",
        )
    return out


async def _cut(db: AsyncSession, roadmap_ids: list[uuid.UUID]) -> dict[uuid.UUID, set[str]]:
    """Item keys an open change set of each roadmap cuts."""
    out: dict[uuid.UUID, set[str]] = defaultdict(set)
    for cs in await db.scalars(
        select(RoadmapChangeSet).where(
            RoadmapChangeSet.roadmap_document_id.in_(roadmap_ids),
            RoadmapChangeSet.status.in_(OPEN_CHANGE_SETS),
        )
    ):
        for c in cs.changes or []:
            if isinstance(c, dict) and c.get("op") == "cut" and c.get("key"):
                out[cs.roadmap_document_id].add(str(c["key"]))
    return out


# --------------------------------------------------------------------------- the answer


def _ref(d: Document | None) -> SimpleDocRef | None:
    return SimpleDocRef(id=d.id, slug=d.slug, title=d.title) if d is not None else None


def _date(d: dates.Dated) -> SimpleDate:
    return SimpleDate(date=d.date, source=d.source, estimated=d.estimated)


def suggestion_out(s: RoadmapDateSuggestion, row: RoadmapItem, may: bool) -> DateSuggestionOut:
    return DateSuggestionOut(
        id=s.id,
        item_id=s.item_id,
        item_key=row.item_key,
        item_title=row.title,
        start_date=s.start_date,
        end_date=s.end_date,
        basis=s.basis,
        status=s.status,  # type: ignore[arg-type]
        created_at=s.created_at,
        decided_by=s.decided_by,
        decided_at=s.decided_at,
        can_decide=may,
    )


def _reasons(e: Entry) -> list[str]:
    """S4: up to 3 one-line reasons, from the item's evidence: its priority's rationale,
    the goal its feature supports, the PRD section it was drawn from."""
    out: list[str] = []
    why = (e.row.priority or {}).get("rationale") or (e.row.priority or {}).get("reason")
    if isinstance(why, str) and why.strip():
        out.append(why.strip().splitlines()[0])
    if e.goal is not None:
        out.append(f"Serves the goal {e.goal.title}.")
    if e.prd is not None and e.row.prd_section_key:
        out.append(f"From {e.prd.title}, section {e.row.prd_section_key}.")
    return out[:3]


async def _open_decisions(
    db: AsyncSession, ids: set[uuid.UUID]
) -> dict[uuid.UUID, list[SimpleOpenDecision]]:
    """S4: the proposed decisions naming each item (a ``roadmap_item`` subject), in one
    statement."""
    from oracle.decisions.models import Decision

    out: dict[uuid.UUID, list[SimpleOpenDecision]] = defaultdict(list)
    if not ids:
        return out
    rows = await db.scalars(
        select(Decision)
        .where(Decision.status == "proposed")
        .where(Decision.subjects.contains([{"kind": "roadmap_item"}]))
        .order_by(Decision.number)
    )
    for d in rows:
        for subject in d.subjects or []:
            try:
                item_id = uuid.UUID(str(subject.get("id")))
            except ValueError:
                continue
            if subject.get("kind") == "roadmap_item" and item_id in ids:
                out[item_id].append(SimpleOpenDecision(id=d.id, number=d.number, title=d.title))
    return out


def item_out(
    e: Entry,
    principal: Any,
    deciders: dict,
    names: dict | None = None,
    owners: list | None = None,
    decisions: dict[uuid.UUID, list[SimpleOpenDecision]] | None = None,
    extra: dict[uuid.UUID, dict[str, Any]] | None = None,
) -> SimpleRoadmapItem:
    row, r = e.row, e.resolved
    names = names or {}
    may = can_decide(principal, e, deciders) if principal is not None else False
    return SimpleRoadmapItem(
        id=row.id,
        key=row.item_key,
        title=row.title,
        outcome=row.outcome,
        horizon=row.horizon,  # type: ignore[arg-type]
        roadmap=_ref(e.roadmap),  # type: ignore[arg-type]
        prd=_ref(e.prd),
        goal=SimpleGoalRef(id=e.goal.id, key=e.goal.key, title=e.goal.title, metric=_metric(e.goal))
        if e.goal
        else None,
        track=SimpleTrackRef(id=e.track.id, title=e.track.title) if e.track else None,
        confidence=row.confidence,
        status=e.status,  # type: ignore[arg-type]
        draft=row.draft,
        start=_date(r.start),
        end=_date(r.end),
        source=r.source,
        estimated=r.estimated,
        suggestion=suggestion_out(e.suggestion, row, may) if e.suggestion is not None else None,
        milestone=e.milestone,
        phases=[
            SimplePhase(key=p.key, start=p.start, end=p.end, estimated=p.estimated)  # type: ignore[arg-type]
            for p in dates.phases(r.start, r.end, row.milestone, row.validation_gates)
        ],
        depends_on=e.depends_on,
        needed_by=e.needed_by,
        flags=[
            SimpleFlag(
                kind=f.kind,
                reason=f.reason,
                fixes=f.fixes,
                state=f.state,  # type: ignore[arg-type]
                subject=f.subject,
                risk_note=f.risk_note,
            )  # fmt: skip
            for f in e.flags
        ],
        owner=SimpleOwnerRef(id=e.track.owner_id, name=e.owner_name)  # type: ignore[arg-type]
        if e.track is not None and e.track.owner_id is not None and e.owner_name
        else None,
        can_decide=may,
        deciders=[names[i] for i in decider_ids(e, deciders) or owners or [] if i in names],
        reasons=_reasons(e),
        open_decisions=(decisions or {}).get(row.id, []),
        goal_ids=[str(g) for g in row.goal_ids or []],
        **(extra or {}).get(row.id, {}),
    )


def _metric(goal: Entity) -> str | None:
    metric = (goal.attrs or {}).get("metric")
    if isinstance(metric, dict):
        metric = metric.get("name") or metric.get("title")
    return metric if isinstance(metric, str) and metric else None


def _matches(e: Entry, value: str | None, *refs: Any) -> bool:
    if not value:
        return True
    return any(r is not None and value in (str(r), getattr(r, "slug", None)) for r in refs)


def _group_of(e: Entry, group: str) -> tuple[str, str, str]:
    """(key, title, sort key) of the item's group."""
    if group == "goal":
        if e.goal is not None:
            return str(e.goal.id), e.goal.title, f"0{e.goal.key}"
        return NONE, "No goal", "1"
    if group == "track":
        if e.track is not None:
            return str(e.track.id), e.track.title, f"0{e.track.title.casefold()}{e.track.id}"
        return NONE, "No track", "1"
    if e.prd is not None:
        return str(e.prd.id), e.prd.title, f"0{e.prd.title.casefold()}{e.prd.id}"
    return NONE, "No PRD", "1"


async def build(
    db: AsyncSession,
    principal: Any,
    group: str = "goal",
    prd: str | None = None,
    goal: str | None = None,
    track: str | None = None,
    start: date | None = None,
    end: date | None = None,
) -> SimpleRoadmapOut:
    from oracle.simple import drafts, key_dates

    seen = await drafts.reader(db, principal)
    read = await load(db, seen.overlays)
    shown = [
        e
        for e in read.entries
        if _matches(e, prd, e.prd, e.prd.id if e.prd else None)
        and (not goal or (e.goal is not None and goal in (str(e.goal.id), e.goal.key)))
        and (not track or (e.track is not None and track == str(e.track.id)))
        and (start is None or e.resolved.end.date >= start)
        and (end is None or e.resolved.start.date <= end)
    ]
    groups: dict[str, tuple[str, str, list[uuid.UUID]]] = {}
    for e in shown:
        key, title, sort = _group_of(e, group)
        groups.setdefault(key, (sort, title, []))[2].append(e.row.id)
    ordered = sorted(groups.items(), key=lambda kv: kv[1][0])
    owners = list(
        await db.scalars(
            select(User.id)
            .where(User.role == "owner", User.disabled_at.is_(None))
            .order_by(User.created_at, User.id)
        )
    )
    people = set(owners) | {i for e in shown for i in decider_ids(e, read.deciders)}
    names = {
        u.id: display_name(u.email, u.name)
        for u in await db.scalars(select(User).where(User.id.in_(people)))
    }
    decisions = await _open_decisions(db, {e.row.id for e in shown})
    from oracle.simple import additions

    extra = await additions.item_extras(db, read, shown)
    ids = {e.row.id for e in read.entries}
    keyed = {(e.track.id, e.row.item_key): e.row.id for e in read.entries if e.track is not None}
    w = read.windows
    kds, kd_roadmaps = await key_dates.roadmap_key_dates(
        db, principal, {e.roadmap.id: e.roadmap for e in shown}
    )
    from oracle.simple import visuals

    flows = await visuals.flows_for(db, "feature", [e.row.id for e in shown])
    items = [
        item_out(e, principal, read.deciders, names, owners, decisions, extra) for e in shown
    ]
    for it in items:
        # A draft's own visual (S7) first, else its feature's (S10).
        it.flow = it.flow or flows.get(it.id)
    return SimpleRoadmapOut(
        today=read.today,
        group=group,  # type: ignore[arg-type]
        windows=SimpleWindows(
            **{h: SimpleWindow(start=w[h][0], end=w[h][1]) for h in ("now", "next", "later")}
        ),
        groups=[SimpleGroup(key=k, title=t, item_ids=i) for k, (_, t, i) in ordered],
        items=items,
        milestones=[
            SimpleMilestone(
                id=m.id,
                track_id=m.track_id,
                name=m.name,
                date=m.target_date,
                horizon=m.horizon,  # type: ignore[arg-type]
                status=m.status,  # type: ignore[arg-type]
                item_ids=[
                    keyed[(m.track_id, k)]
                    for k in m.item_keys or []
                    if keyed.get((m.track_id, k)) in ids
                ],
            )
            for m in read.milestones
        ],
        changes_in_review=seen.changes_in_review,
        drafts=seen.visible,
        key_dates=kds,
        key_date_roadmaps=kd_roadmaps,
    )
