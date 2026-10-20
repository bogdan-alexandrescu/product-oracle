"""Load the baseline into the scoring inputs; store and read priority snapshots."""

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
    PriorityRanking,
    PrioritySnapshotOut,
    PrioritySnapshotSummary,
    RankedFeature,
    RankingCounts,
)
from oracle.priorities.scoring import EvidenceRef, FeatureInput, GoalLink, rank


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


def _summary(s: PrioritySnapshot) -> dict[str, Any]:
    return {
        "id": s.id,
        "method": s.method,
        "created_by": s.created_by,
        "created_at": s.created_at,
        "note": (s.params or {}).get("note"),
        "feature_count": len(s.ranking or []),
        "top": [r["key"] for r in (s.ranking or [])[:5]],
    }


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
        **_summary(snapshot), params=snapshot.params, ranking=ranking.features
    )


async def list_snapshots(db: AsyncSession, limit: int = 50) -> list[PrioritySnapshotSummary]:
    rows = await db.scalars(
        select(PrioritySnapshot).order_by(PrioritySnapshot.created_at.desc()).limit(limit)
    )
    return [PrioritySnapshotSummary(**_summary(s)) for s in rows]


async def read_snapshot(db: AsyncSession, snapshot_id: uuid.UUID) -> PrioritySnapshotOut:
    s = await db.get(PrioritySnapshot, snapshot_id)
    if s is None:
        raise NotFoundError("priority snapshot not found")
    return PrioritySnapshotOut(
        **_summary(s),
        params=s.params or {},
        ranking=[RankedFeature.model_validate(r) for r in s.ranking or []],
    )
