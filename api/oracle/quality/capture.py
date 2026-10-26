"""Capture the prediction before shipping (H3 Predicted versus actual).

On the first approval of a roadmap version, one ``predicted`` outcome record per item
whose feature serves a confirmed goal (none for an item that already has one):

- goal: the confirmed goal with the highest weight x contribution of the feature's
  ``supports`` edges;
- outcome entity: an ``outcome`` entity linked to the feature, if any;
- metric, unit, direction: the outcome entity's attrs, else the goal's (target above
  current: increase);
- baseline: the goal's current value; predicted: the outcome entity's target, else a
  number in the item's ``economics.value``, else empty (``needs_prediction``);
- by: the item's milestone date (kept only when verified), else the end of its horizon;
- confidence at prediction: the item's word (high 0.8, medium 0.5, low 0.3), else the
  feature's scored confidence.

Deterministic, no model call. The caller commits.
"""

import uuid
from datetime import date
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.baseline import figures
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import DocumentVersion
from oracle.priorities.scoring import CONFIDENCE_WORDS, FeatureInput, confidence_of
from oracle.quality.models import OutcomeRecord
from oracle.roadmap.models import RoadmapItem
from oracle.tenant_settings_api import company_horizons, horizon_windows

HORIZON_OF_ITEM = {"now": "short", "next": "medium", "later": "long"}
UNSET = "Not set yet"


def number(raw: Any) -> float | None:
    """A figure as a number: 42, "42%", "$4M"; None when there is none."""
    f = figures.parse_figure(raw)
    return f.value if f is not None else None


def goal_value(attrs: dict[str, Any], key: str) -> float | None:
    """A goal's typed value (B5), else the text kept beside it (``<key>_text``)."""
    value = number(attrs.get(key))
    return value if value is not None else number(attrs.get(f"{key}_text"))


def direction_of(attrs: dict[str, Any], target: float | None, current: float | None) -> str | None:
    comparison = attrs.get("comparison")
    if comparison in ("at_least", "above"):
        return "increase"
    if comparison in ("at_most", "below"):
        return "decrease"
    if target is not None and current is not None and target != current:
        return "increase" if target > current else "decrease"
    d = figures.direction(attrs.get("target_text") or attrs.get("target"))
    return None if d is None else ("increase" if d.way == "up" else "decrease")


def figure_text(value: float | None, unit: str | None) -> str | None:
    if value is None:
        return None
    shown = f"{value:g}"
    if not unit:
        return shown
    return f"{shown}{unit}" if unit == "%" else f"{shown} {unit}"


async def _goal_for(db: AsyncSession, feature_id: uuid.UUID) -> Entity | None:
    best: tuple[float, str, Entity] | None = None
    rows = await db.execute(
        select(Edge, Entity)
        .join(Entity, Entity.id == Edge.dst_id)
        .where(
            Edge.src_id == feature_id,
            Edge.type == "supports",
            Edge.status != "rejected",
            Entity.type == "goal",
            Entity.status == "confirmed",
        )
    )
    for edge, goal in rows:
        weight = number((goal.attrs or {}).get("weight")) or 1.0
        contribution = number((edge.attrs or {}).get("contribution")) or 1.0
        key = (weight * contribution, goal.key)
        if best is None or key[0] > best[0] or (key[0] == best[0] and key[1] < best[1]):
            best = (key[0], key[1], goal)
    return best[2] if best else None


async def _outcome_for(db: AsyncSession, feature_id: uuid.UUID) -> Entity | None:
    linked = select(Edge.dst_id).where(Edge.src_id == feature_id, Edge.status != "rejected")
    linking = select(Edge.src_id).where(Edge.dst_id == feature_id, Edge.status != "rejected")
    return await db.scalar(
        select(Entity)
        .where(
            Entity.type == "outcome",
            Entity.status != "rejected",
            or_(Entity.id.in_(linked), Entity.id.in_(linking)),
        )
        .order_by(Entity.key)
        .limit(1)
    )


def _by(item: RoadmapItem, windows: dict[str, tuple[date, date]]) -> date:
    milestone = item.milestone or {}
    if milestone.get("date"):
        try:
            return date.fromisoformat(str(milestone["date"]))
        except ValueError:
            pass
    return windows[HORIZON_OF_ITEM.get(item.horizon, "medium")][1]


def _confidence(item: RoadmapItem, feature: Entity) -> float:
    word = (item.confidence or "").strip().lower()
    if word in CONFIDENCE_WORDS:
        return CONFIDENCE_WORDS[word]
    value, _ = confidence_of(
        FeatureInput(
            id=str(feature.id), key=feature.key, title=feature.title, status=feature.status,
            attrs=dict(feature.attrs or {}),
            stored_confidence=float(feature.confidence) if feature.confidence is not None else None,
        )
    )  # fmt: skip
    return round(min(max(value, 0.0), 1.0), 3)


def prediction_for(
    item: RoadmapItem, goal: Entity, outcome: Entity | None, by: date
) -> dict[str, Any]:
    g = dict(goal.attrs or {})
    o = dict(outcome.attrs or {}) if outcome is not None else {}
    baseline = goal_value(g, "current")
    predicted = goal_value(o, "target") if o else None
    if predicted is None:
        predicted = number((item.economics or {}).get("value"))
    unit = o.get("unit") or g.get("unit") or None
    metric = o.get("metric") or g.get("metric") or item.outcome or item.title
    direction = direction_of(o, predicted, baseline) if o else None
    direction = direction or direction_of(g, goal_value(g, "target"), baseline)
    if predicted is not None and baseline is not None and direction is not None:
        # A prediction that does not move the stated way is not one: ask for it.
        if (predicted - baseline) * (1 if direction == "increase" else -1) <= 0:
            predicted = None
    return {
        "metric": str(metric)[:300],
        "baseline": figure_text(baseline, unit),
        "predicted": figure_text(predicted, unit) or UNSET,
        "threshold": None,
        "by": by.isoformat(),
        "unit": unit,
        "direction": direction,
        "baseline_value": baseline,
        "predicted_value": predicted,
        "threshold_value": None,
    }


async def predictions_for_roadmap(
    db: AsyncSession, principal: Any, version: DocumentVersion, *, owner_id: uuid.UUID | None
) -> list[OutcomeRecord]:
    """One predicted record per item of the approved version that serves a confirmed goal
    and has none yet (for this item row, or this item key on its track)."""
    if version.approved_at is None:
        return []
    windows = horizon_windows(await company_horizons(db), await company_time.company_today(db))
    items = list(
        await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == version.id)
            .order_by(RoadmapItem.position)
        )
    )
    created = []
    for item in items:
        if item.feature_id is None:
            continue
        feature = await db.get(Entity, item.feature_id)
        if feature is None or feature.status == "rejected":
            continue
        goal = await _goal_for(db, feature.id)
        if goal is None:
            continue
        track_id = item.track_id
        if track_id is None and item.prd_document_id is not None:
            from oracle.roadmap.tracks import track_of_prd

            track = await track_of_prd(db, item.prd_document_id)
            track_id = track.id if track else None
        same = [OutcomeRecord.roadmap_item_id == item.id]
        if track_id is not None:
            same.append(
                (OutcomeRecord.track_id == track_id)
                & (OutcomeRecord.roadmap_item_key == item.item_key)
            )
        if await db.scalar(select(OutcomeRecord.id).where(or_(*same)).limit(1)):
            continue
        outcome = await _outcome_for(db, feature.id)
        prediction = prediction_for(item, goal, outcome, _by(item, windows))
        row = OutcomeRecord(
            title=item.title,
            goal_id=goal.id,
            outcome_entity_id=outcome.id if outcome else None,
            document_id=item.prd_document_id,
            prd_version_id=item.prd_version_id,
            roadmap_version_id=version.id,
            roadmap_item_key=item.item_key,
            roadmap_item_id=item.id,
            track_id=track_id,
            prediction=prediction,
            module_keys=[],
            gap_categories=[],
            status="predicted",
            needs_prediction=prediction["predicted_value"] is None,
            confidence_at_prediction=_confidence(item, feature),
            assessments=[],
            owner_id=owner_id,
            created_by=owner_id,
        )
        db.add(row)
        await db.flush()
        await audit.record(
            db, principal, "outcome.predicted", "outcome_record", row.id,
            {"roadmap_item_id": str(item.id), "goal_id": str(goal.id),
             "needs_prediction": row.needs_prediction},
        )  # fmt: skip
        created.append(row)
    return created
