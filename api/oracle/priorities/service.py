"""Load the baseline into the scoring inputs; store and read priority snapshots.

Readers see saved snapshots unless they ask for another status (C8): a run's order is
proposed until its priority stop is approved (oracle.priorities.run_order)."""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.baseline import evidence as baseline_evidence
from oracle.baseline import scoring as baseline_scoring
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.priorities.models import PrioritySnapshot
from oracle.priorities.schemas import (
    CompareCheckpoint,
    CompareOut,
    CompareRow,
    CompareRun,
    PriorityRanking,
    PrioritySnapshotOut,
    PrioritySnapshotSummary,
    RankedFeature,
    RankingCounts,
    SnapshotDocument,
)
from oracle.priorities.scoring import EvidenceRef, FeatureInput, GoalLink, rank
from oracle.sources.models import SourceItem


class NotFoundError(LookupError):
    pass


def _float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _contribution(value: Any) -> int | None:
    number = _float(value)
    return None if number is None else int(min(3, max(0, round(number))))


async def load_features(
    db: AsyncSession, *, rescore: bool = True, principal: Principal | None = None
) -> list[FeatureInput]:
    """Features (not rejected) with their confirmed-goal links, evidence and dependencies.

    Scores unscored evidence in the session (flushed, not committed); ``rescore=False``
    reads only (readiness checks never write), leaving unscored evidence unscored.
    """
    entities = list(
        await db.scalars(
            select(Entity).where(Entity.type.in_(["feature", "goal"]), Entity.status != "rejected")
        )
    )
    features = {e.id: e for e in entities if e.type == "feature"}
    goals = {e.id: e for e in entities if e.type == "goal" and e.status == "confirmed"}
    inputs = {
        e.id: FeatureInput(
            id=str(e.id),
            key=e.key,
            title=e.title,
            status=e.status,
            attrs=dict(e.attrs or {}),
            stored_confidence=float(e.confidence) if e.confidence is not None else None,
        )
        for e in features.values()
    }
    if not inputs:
        return []
    edges = await db.scalars(
        select(Edge).where(
            Edge.type.in_(["supports", "depends_on", "blocks"]), Edge.status != "rejected"
        )
    )
    for edge in edges:
        if edge.type == "supports" and edge.src_id in inputs and edge.dst_id in goals:
            goal = goals[edge.dst_id]
            inputs[edge.src_id].goals.append(
                GoalLink(
                    goal_key=goal.key,
                    goal_title=goal.title,
                    weight=_float((goal.attrs or {}).get("weight")),
                    contribution=_contribution((edge.attrs or {}).get("contribution")),
                    edge_status=edge.status,
                )
            )
        elif edge.type == "depends_on" and edge.src_id in inputs and edge.dst_id in inputs:
            inputs[edge.src_id].depends_on.append(inputs[edge.dst_id].key)
        elif edge.type == "blocks" and edge.src_id in inputs and edge.dst_id in inputs:
            inputs[edge.dst_id].depends_on.append(inputs[edge.src_id].key)
    evidence = list(await db.scalars(select(Evidence).where(Evidence.entity_id.in_(list(inputs)))))
    # Evidence the baseline has not scored yet is scored now, through the baseline's own
    # scoring (source, freshness, mentions, goal impact), so every feature's confidence
    # comes from the same numbers the Baseline screen shows.
    unscored = {ev.entity_id for ev in evidence if ev.confidence is None}
    if unscored and rescore:
        await baseline_scoring.rescore_targets(db, entity_ids=unscored)
    from_items = {ev.source_item_id for ev in evidence if ev.source_item_id}
    removed: set[uuid.UUID] = set()
    if from_items:
        removed = set(
            (
                await db.scalars(
                    select(SourceItem.id).where(
                        SourceItem.id.in_(from_items), SourceItem.deleted_at.is_not(None)
                    )
                )
            ).all()
        )
    # A run reads every score as of its pin, as the entity detail does (S6).
    view = await baseline_evidence.run_view(db, principal, entity_ids=list(inputs))
    if view is not None:
        for f in features.values():
            inputs[f.id].stored_confidence = view.confidence("entity", f.id)
    for ev in evidence:
        inputs[ev.entity_id].evidence.append(  # type: ignore[index]
            EvidenceRef(
                id=str(ev.id),
                confidence=(
                    view.by_evidence.get(ev.id)
                    if view is not None
                    else (float(ev.confidence) if ev.confidence is not None else None)
                ),
                ref=ev.url or ev.ref,
                source_removed=ev.source_item_id in removed,
            )
        )
    for f in inputs.values():
        f.goals.sort(key=lambda g: g.goal_key)
        f.depends_on.sort()
    return sorted(inputs.values(), key=lambda f: f.key)


async def compute(
    db: AsyncSession, method: str, principal: Principal | None = None
) -> PriorityRanking:
    result = rank(await load_features(db, principal=principal), method)
    features = [RankedFeature.model_validate(r) for r in result["features"]]
    return PriorityRanking(
        method=result["method"],
        formula=result["formula"],
        generated_at=datetime.now(UTC),
        features=features,
        cycles=result["cycles"],
        counts=RankingCounts(
            features=len(features),
            no_goal=sum(1 for f in features if not f.serves_goal),
            unscored=sum(1 for f in features if f.score is None),
            in_cycles=sum(len(c) for c in result["cycles"]),
        ),
    )


def _summary(s: PrioritySnapshot, document: SnapshotDocument | None) -> dict[str, Any]:
    return {
        "id": s.id,
        "method": s.method,
        "created_by": s.created_by,
        "created_at": s.created_at,
        "note": (s.params or {}).get("note"),
        "feature_count": len(s.ranking or []),
        "top": [r["key"] for r in (s.ranking or [])[:5]],
        "status": s.status,
        "run_id": s.run_id,
        "document": document,
        "decided_by": s.decided_by,
        "decided_at": s.decided_at,
    }


async def _documents(
    db: AsyncSession, snapshots: list[PrioritySnapshot]
) -> dict[uuid.UUID, SnapshotDocument]:
    """The PRD of each run snapshot: its document, else the slug its run writes."""
    from oracle.docs.models import Document
    from oracle.runs.models import Run

    doc_ids = {s.document_id for s in snapshots if s.document_id}
    run_ids = {s.run_id for s in snapshots if s.run_id and not s.document_id}
    docs = (
        {d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(doc_ids)))}
        if doc_ids
        else {}
    )
    runs = (
        {r.id: r for r in await db.scalars(select(Run).where(Run.id.in_(run_ids)))}
        if run_ids
        else {}
    )
    out: dict[uuid.UUID, SnapshotDocument] = {}
    for s in snapshots:
        if s.document_id in docs:
            d = docs[s.document_id]
            out[s.id] = SnapshotDocument(id=d.id, slug=d.slug, title=d.title)
        elif s.run_id in runs and (slug := (runs[s.run_id].knobs or {}).get("document_slug")):
            out[s.id] = SnapshotDocument(slug=str(slug))
    return out


def _out(s: PrioritySnapshot, document: SnapshotDocument | None) -> PrioritySnapshotOut:
    return PrioritySnapshotOut(
        **_summary(s, document),
        params=s.params or {},
        ranking=[RankedFeature.model_validate(r) for r in s.ranking or []],
        checkpoint_id=s.checkpoint_id,
        scope_id=s.scope_id,
        check_result=s.check_result or None,
    )


async def create_snapshot(
    db: AsyncSession, method: str, note: str | None, principal: Principal
) -> PrioritySnapshotOut:
    ranking = await compute(db, method)
    snapshot = PrioritySnapshot(
        method=method,
        params={
            "note": note,
            "formula": ranking.formula,
            "generated_at": ranking.generated_at.isoformat(),
            "cycles": ranking.cycles,
            "counts": ranking.counts.model_dump(),
        },
        ranking=[f.model_dump(mode="json") for f in ranking.features],
        created_by=principal.id,
    )
    db.add(snapshot)
    await db.flush()
    await audit.record(
        db,
        principal,
        "priority_snapshot.created",
        "priority_snapshot",
        snapshot.id,
        {"method": method, "features": len(ranking.features)},
    )
    await db.commit()
    await db.refresh(snapshot)
    return PrioritySnapshotOut(
        **_summary(snapshot, None), params=snapshot.params, ranking=ranking.features
    )


def _status_filter(status: str):
    return None if status == "all" else PrioritySnapshot.status == status


async def list_snapshots(
    db: AsyncSession, limit: int = 50, status: str = "saved"
) -> list[PrioritySnapshotSummary]:
    q = select(PrioritySnapshot).order_by(PrioritySnapshot.created_at.desc()).limit(limit)
    if (where := _status_filter(status)) is not None:
        q = q.where(where)
    rows = list(await db.scalars(q))
    docs = await _documents(db, rows)
    return [PrioritySnapshotSummary(**_summary(s, docs.get(s.id))) for s in rows]


async def _snapshot(db: AsyncSession, snapshot_id: uuid.UUID, status: str) -> PrioritySnapshot:
    s = await db.get(PrioritySnapshot, snapshot_id)
    if s is None or (status != "all" and s.status != status):
        raise NotFoundError("priority snapshot not found")
    return s


async def read_snapshot(
    db: AsyncSession, snapshot_id: uuid.UUID, status: str = "saved"
) -> PrioritySnapshotOut:
    s = await _snapshot(db, snapshot_id, status)
    return _out(s, (await _documents(db, [s])).get(s.id))


async def compare(db: AsyncSession, snapshot_id: uuid.UUID, principal: Principal) -> CompareOut:
    """A snapshot in any status next to the live ranking of its method, restricted to the
    features it ranks, with the check's problems per row (C8), and the run and checkpoint
    that decide it."""
    from oracle.priorities import run_order

    s = await _snapshot(db, snapshot_id, "all")
    live = await compute(db, s.method)
    stored = {r["key"]: r for r in s.ranking or []}
    check = s.check_result or {}
    order = check.get("order") or [
        {"key": r["key"], "rank": r["rank"], "explanation": r.get("run_explanation")}
        for r in s.ranking or []
    ]
    order = sorted(order, key=lambda r: r["rank"])
    live_rows = [f.model_dump(mode="json") for f in live.features]
    ranks = run_order.live_ranks([r["key"] for r in order], live_rows)
    by_key = {f.key: f for f in live.features}
    problems = [p for p in check.get("problems") or [] if p.get("feature")]
    rows = []
    for r in order:
        key = r["key"]
        f = by_key.get(key)
        live_rank = ranks.get(key)
        rows.append(
            CompareRow(
                key=key,
                title=f.title if f else (stored.get(key) or {}).get("title") or key,
                run_rank=r["rank"],
                live_rank=live_rank,
                delta=None if live_rank is None else live_rank - r["rank"],
                run_explanation=r.get("explanation"),
                live_explanation=_live_explanation(f) if f else None,
                problems=[p for p in problems if p["feature"] == key],
            )
        )
    run, checkpoint = await _deciding(db, s, principal)
    return CompareOut(
        snapshot=_out(s, (await _documents(db, [s])).get(s.id)),
        rows=rows,
        live_generated_at=live.generated_at,
        run=run,
        checkpoint=checkpoint,
    )


def _live_explanation(f: RankedFeature) -> str:
    e = f.explanation
    return " ".join(p for p in [e.formula, *e.steps[:3], *e.order[:2]] if p)[:400]


async def _deciding(
    db: AsyncSession, s: PrioritySnapshot, principal: Principal
) -> tuple[CompareRun | None, CompareCheckpoint | None]:
    from oracle.authz import has_role
    from oracle.runs import flows
    from oracle.runs.models import Checkpoint, Run
    from oracle.runs.service import _cannot_approve

    run = await db.get(Run, s.run_id) if s.run_id else None
    if run is None:
        return None, None
    flow = flows.FLOWS.get(run.flow)
    out = CompareRun(
        id=run.id,
        flow_title=flow.title if flow else run.flow,
        status=run.status,
        document_slug=(run.knobs or {}).get("document_slug"),
    )
    if out.document_slug is None and run.document_id:
        from oracle.docs.models import Document

        doc = await db.get(Document, run.document_id)
        out.document_slug = doc.slug if doc else None
    cp = await db.get(Checkpoint, s.checkpoint_id) if s.checkpoint_id else None
    if cp is None:
        return out, None
    return out, CompareCheckpoint(
        id=cp.id,
        status=cp.status,
        approver_role=cp.approver_role,
        cannot_approve=_cannot_approve(cp),
        can_decide=cp.status == "pending" and has_role(principal.role, cp.approver_role),  # type: ignore[arg-type]
    )
