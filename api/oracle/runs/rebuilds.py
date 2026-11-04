"""The rebuild sign (owner's pick A, PR 1232): the runs that will make a new version of a
document a person may read, as the chip beside the version pill says them.

A run that writes a document (a segment of its flow imports the draft) reads as:

- **scheduled**: created and not started yet (draft, or waiting for an owner's approval);
  ``scheduled_for`` is the time it is set to start, when the run says one;
- **running**: a segment is under way; ``step`` of ``steps``, about ``minutes_left``;
- **waiting**: at a stop, on a person (``waits_on``) and what they do (``waits_on_action``);
- **failed**: the latest run on its document stopped, in the last :data:`FAILED_DAYS`;
- **done**: its draft is the document's latest version and not approved yet. The sign
  goes away once that version is approved (and, per person, once they open it: the web).

Read through GET /v1/runs' own visibility (H8, creator-only runs, hidden research), so a
person never learns of a run they could not list.
"""

import statistics
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import User
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.schemas import CompanyRoadmapRebuilds, Rebuild, RebuildsOut, RunSummary
from oracle.runs.service import CHECKPOINT_TITLES

FAILED_DAYS = 7
# What the person at a stop does there, in plain words.
STOP_ACTIONS = {
    "baseline_confirm": "confirm the baseline",
    "feature_set": "approve the feature set",
    "eng_review": "check the engineering review",
    "eng_dates": "set the engineering dates",
    "priority_order": "approve the priority order",
    "prd_review": "review the new draft",
    "roadmap_items": "approve the roadmap items",
    "roadmap_review": "review the new roadmap",
}
STATES = {
    "draft": "scheduled",
    "awaiting_approval": "scheduled",
    "running": "running",
    "awaiting_checkpoint": "waiting",
    "paused_overrun": "waiting",
    "failed": "failed",
    "succeeded": "done",
}


def _writes_document(flow: str) -> bool:
    f = flows.FLOWS.get(flow)
    return f is not None and any(s.imports_draft for s in f.segments)


def _stop_on(run: Run, kind: str | None) -> bool:
    if kind is None:
        return False
    return bool(((run.knobs or {}).get("checkpoints") or {}).get(kind, True))


def _imported(segments: list[RunSegment]) -> int | None:
    numbers = [
        int(imp["version"])
        for s in segments
        if isinstance(imp := (s.artifacts or {}).get("import"), dict)
        and imp.get("version") is not None
        and not imp.get("error")
    ]
    return max(numbers) if numbers else None


async def _durations(db: AsyncSession, flow: str) -> dict[str, float]:
    """The median minutes each of the flow's segments took in its finished runs."""
    rows = await db.execute(
        select(RunSegment.name, RunSegment.started_at, RunSegment.finished_at)
        .join(Run, Run.id == RunSegment.run_id)
        .where(
            Run.flow == flow,
            RunSegment.status == "succeeded",
            RunSegment.started_at.is_not(None),
            RunSegment.finished_at.is_not(None),
        )
        .order_by(RunSegment.finished_at.desc())
        .limit(200)
    )
    took: dict[str, list[float]] = {}
    for name, start, end in rows.all():
        took.setdefault(name, []).append(max(0.0, (end - start).total_seconds() / 60))
    return {k: statistics.median(v) for k, v in took.items()}


async def _name(db: AsyncSession, user_id: uuid.UUID | None) -> str | None:
    u = await db.get(User, user_id) if user_id else None
    return (u.name or u.email) if u else None


async def _decider(db: AsyncSession, document: Document | None) -> str | None:
    # Who decides the document's stops, as the Ask panel routes a decision.
    from oracle.simple.chat_actions import ask_decider

    u = await ask_decider(db, document)
    return (u.name or u.email) if u else None


async def list_rebuilds(db: AsyncSession, visible: list[RunSummary]) -> RebuildsOut:
    """``visible``: GET /v1/runs' rows for the caller (its visibility already applied)."""
    rows = [
        r for r in visible if r.document_slug and r.status in STATES and _writes_document(r.flow)
    ]
    hidden = await visibility.hidden_document_ids(db)
    slugs = {r.document_slug for r in rows}
    docs = {
        d.slug: d
        for d in await db.scalars(select(Document).where(Document.slug.in_(slugs or {""})))
        if d.id not in hidden
    }
    ids = [r.id for r in rows]
    runs = {r.id: r for r in await db.scalars(select(Run).where(Run.id.in_(ids or [uuid.uuid4()])))}
    segments: dict[uuid.UUID, list[RunSegment]] = {i: [] for i in ids}
    pending: dict[uuid.UUID, Checkpoint] = {}
    if ids:
        for seg in await db.scalars(
            select(RunSegment).where(RunSegment.run_id.in_(ids)).order_by(RunSegment.seq)
        ):
            segments[seg.run_id].append(seg)
        for cp in await db.scalars(
            select(Checkpoint).where(Checkpoint.run_id.in_(ids), Checkpoint.status == "pending")
        ):
            pending[cp.run_id] = cp
    versions: dict[uuid.UUID, tuple[int | None, int | None]] = {}
    for d in docs.values():
        latest = await db.scalar(
            select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == d.id)
        )
        approved = await db.scalar(
            select(func.max(DocumentVersion.number)).where(
                DocumentVersion.document_id == d.id, DocumentVersion.approved_at.is_not(None)
            )
        )
        versions[d.id] = (latest, approved)

    now = datetime.now(UTC)
    newest: dict[str, datetime] = {}
    for r in rows:
        newest[r.document_slug] = max(newest.get(r.document_slug, r.created_at), r.created_at)  # type: ignore[index]
    durations: dict[str, dict[str, float]] = {}
    deciders: dict[str, str | None] = {}
    out: list[Rebuild] = []
    for s in rows:
        doc = docs.get(s.document_slug)  # type: ignore[arg-type]
        run = runs.get(s.id)
        if run is None or (doc is None and s.document_id is not None):
            continue
        state = STATES[s.status]
        latest, approved = versions.get(doc.id, (None, None)) if doc else (None, None)
        segs = [g for g in segments[s.id] if g.status != "skipped"]
        flow = flows.FLOWS[s.flow]
        made = _imported(segs) if state == "done" else None
        if state == "done" and (made is None or made != latest or approved == latest):
            continue
        if state == "failed" and (
            s.created_at < newest[s.document_slug]  # type: ignore[index]
            or (s.finished_at or s.created_at) < now - timedelta(days=FAILED_DAYS)
        ):
            continue
        current = (
            next((i for i, g in enumerate(segs) if g.status == "failed"), None)
            if state == "failed"
            else None
        )
        if current is None:
            current = next((i for i, g in enumerate(segs) if g.status == "running"), None)
        if current is None:
            current = next((i for i, g in enumerate(segs) if g.status == "pending"), None)
        if state == "waiting":
            # At a stop: the segment that opened it, the last one that finished.
            done = [i for i, g in enumerate(segs) if g.status == "succeeded"]
            current = done[-1] if done else 0
        if current is None:
            current = max(len(segs) - 1, 0)
        kind = doc.kind if doc else (flow.target_kind or "prd")
        stop_seg = next(
            (g for g in segs[current:] if _stop_on(run, flow.segment(g.name).checkpoint_for(kind))),
            None,
        )
        stop_kind = flow.segment(stop_seg.name).checkpoint_for(kind) if stop_seg else None
        key = s.document_slug or ""
        if key not in deciders:
            deciders[key] = await _decider(db, doc)
        who = deciders[key]
        minutes = None
        if state == "running":
            if s.flow not in durations:
                durations[s.flow] = await _durations(db, s.flow)
            took = durations[s.flow]
            left = [took.get(g.name) for g in segs[current:]]
            if left and all(m is not None for m in left):
                total = sum(m for m in left if m is not None)
                cur = segs[current]
                if cur.started_at:
                    total -= min(left[0] or 0, (now - cur.started_at).total_seconds() / 60)
                minutes = max(1, round(total))
        start_at = _when((run.knobs or {}).get("start_at")) if state == "scheduled" else None
        cp = pending.get(s.id)
        waiting_kind = cp.kind if cp is not None else None
        out.append(
            Rebuild(
                run_id=s.id,
                flow=s.flow,
                flow_title=s.flow_title,
                document_slug=s.document_slug or "",
                document_title=s.document_title,
                document_kind=s.document_kind,
                state=state,  # type: ignore[arg-type]
                steps=[flow.segment(g.name).title for g in segs],
                step=len(segs) if state == "done" else min(current + 1, max(len(segs), 1)),
                from_version=approved,
                to_version=made if made is not None else (latest or 0) + 1,
                started_by=await _name(db, s.created_by),
                started_at=s.started_at,
                scheduled_for=start_at,
                minutes_left=minutes,
                next_stop=CHECKPOINT_TITLES.get(stop_kind, stop_kind) if stop_kind else None,
                next_stop_who=who if stop_kind and state in ("running", "scheduled") else None,
                next_stop_action=STOP_ACTIONS.get(stop_kind or "")
                if state in ("running", "scheduled")
                else None,
                waits_on=(who if waiting_kind else await _owner_name(db))
                if state == "waiting"
                else None,
                waits_on_action=(
                    STOP_ACTIONS.get(waiting_kind or "")
                    or (
                        f"decide the {CHECKPOINT_TITLES.get(waiting_kind, waiting_kind).lower()}"
                        if waiting_kind
                        else "approve the extra spend"
                    )
                )
                if state == "waiting"
                else None,
                review_link=s.review_link,
                error=s.error if state == "failed" else None,
            )
        )
    return RebuildsOut(rebuilds=out, company_roadmap=await _company_roadmap(db, hidden))


async def _owner_name(db: AsyncSession) -> str | None:
    u = await db.scalar(
        select(User)
        .where(User.role == "owner", User.disabled_at.is_(None))
        .order_by(User.created_at, User.id)
    )
    return (u.name or u.email) if u else None


def _when(raw: Any) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


async def _company_roadmap(db: AsyncSession, hidden: Any) -> CompanyRoadmapRebuilds | None:
    """The company roadmap every PRD feeds (one-roadmap-many-prds), with how many PRDs."""
    roadmap = await db.scalar(
        select(Document).where(Document.company_roadmap.is_(True)).order_by(Document.id)
    )
    if roadmap is None or roadmap.id in hidden:
        return None
    prds = await db.scalar(select(func.count()).select_from(Document).where(Document.kind == "prd"))
    return CompanyRoadmapRebuilds(slug=roadmap.slug, title=roadmap.title, prds=int(prds or 0))
