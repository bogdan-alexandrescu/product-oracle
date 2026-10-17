"""Traceability report (F3b): every feature should serve a confirmed goal, with evidence.

Flags on a feature (not rejected):
- ``serves_no_goal``: no ``supports`` edge (not rejected) to a confirmed goal;
- ``no_evidence``: nothing cites it;
- ``low_confidence``: every piece of its evidence scores below ``low``.
"""

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import confidence
from oracle.baseline import scoring
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.baseline.schemas import (
    TraceFeature,
    TraceGoal,
    TraceGoalFeature,
    TraceGoalLink,
    TraceReport,
    TraceSummary,
)


def _num(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


async def report(db: AsyncSession) -> TraceReport:
    low = float(confidence.merged(await scoring.company_weights(db))["low"])
    entities = (
        await db.scalars(
            select(Entity)
            .where(Entity.type.in_(("feature", "goal")), Entity.status != "rejected")
            .order_by(Entity.key)
        )
    ).all()
    features = [e for e in entities if e.type == "feature"]
    goals = [e for e in entities if e.type == "goal"]
    by_id = {e.id: e for e in entities}

    supports = (
        await db.scalars(
            select(Edge).where(
                Edge.type == "supports",
                Edge.status != "rejected",
                Edge.src_id.in_([f.id for f in features]),
            )
        )
    ).all()
    links: dict = defaultdict(list)
    for edge in supports:
        goal = by_id.get(edge.dst_id)
        if goal is not None and goal.type == "goal":
            links[edge.src_id].append((goal, int((edge.attrs or {}).get("contribution", 0))))

    scores: dict = defaultdict(list)
    rows = await db.execute(
        select(Evidence.entity_id, Evidence.confidence).where(
            Evidence.entity_id.in_([f.id for f in features])
        )
    )
    for entity_id, conf in rows.all():
        scores[entity_id].append(None if conf is None else float(conf))

    out_features = []
    goal_features: dict = defaultdict(list)
    for f in features:
        confirmed = [(g, c) for g, c in links[f.id] if g.status == "confirmed"]
        flags = []
        if not confirmed:
            flags.append("serves_no_goal")
        evidence = scores[f.id]
        if not evidence:
            flags.append("no_evidence")
        elif all(c is None or c < low for c in evidence):
            flags.append("low_confidence")
        out_features.append(
            TraceFeature(
                id=f.id,
                key=f.key,
                title=f.title,
                status=f.status,
                confidence=_num(f.confidence),
                evidence_count=len(evidence),
                goals=[
                    TraceGoalLink(goal_id=g.id, key=g.key, title=g.title, contribution=c)
                    for g, c in sorted(links[f.id], key=lambda gc: -gc[1])
                ],
                flags=flags,
            )
        )
        for g, c in links[f.id]:
            goal_features[g.id].append(
                TraceGoalFeature(id=f.id, key=f.key, title=f.title, contribution=c)
            )

    out_goals = [
        TraceGoal(
            id=g.id,
            key=g.key,
            title=g.title,
            status=g.status,
            weight=_num((g.attrs or {}).get("weight")),
            confidence=_num(g.confidence),
            features=sorted(goal_features[g.id], key=lambda x: -x.contribution),
            coverage=sum(x.contribution for x in goal_features[g.id]),
        )
        for g in goals
    ]
    flagged = [f for f in out_features if f.flags]
    confirmed_goals = [g for g in out_goals if g.status == "confirmed"]
    return TraceReport(
        low=low,
        features=out_features,
        flagged=flagged,
        goals=out_goals,
        summary=TraceSummary(
            features=len(out_features),
            flagged=len(flagged),
            serves_no_goal=sum("serves_no_goal" in f.flags for f in out_features),
            weak_evidence=sum(
                "no_evidence" in f.flags or "low_confidence" in f.flags for f in out_features
            ),
            goals=len(out_goals),
            confirmed_goals=len(confirmed_goals),
            uncovered_goals=sum(not g.features for g in confirmed_goals),
        ),
    )
