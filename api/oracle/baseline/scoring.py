"""Confidence of the baseline's evidence, entities and edges (oracle.confidence).

Each evidence row is scored from oracle.confidence.Factors:

- source and item kind from its source item ("manual" for free-standing evidence);
- latest timestamp: the item's updated / occurred time, else its newest version's
  fetch time, else the evidence's retrieved_at;
- mentions: distinct source items behind the same entity or edge;
- goal contribution: the highest ``supports`` contribution from the entity (for an
  edge, its source entity) to a confirmed goal; a goal itself counts 3;
- planning document: the item's acl (or acl.attrs) ``doc_type`` is ``planning``.

The row keeps the confidence, the inputs, each factor's value and weight, and when it
was scored. An entity's or edge's confidence is ``confidence.aggregate`` of its
evidence (None without evidence). Weights come from the ``confidence_weights``
company setting.
"""

import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import confidence
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.tenant_settings import TenantSetting

SETTINGS_KEY = "confidence_weights"
FREE_STANDING_KIND = "manual"


async def company_weights(db: AsyncSession) -> dict[str, Any]:
    value = await db.scalar(select(TenantSetting.value).where(TenantSetting.key == SETTINGS_KEY))
    return value if isinstance(value, dict) else {}


def _planning(acl: dict[str, Any] | None) -> bool:
    acl = acl or {}
    attrs = acl.get("attrs") if isinstance(acl.get("attrs"), dict) else {}
    return acl.get("doc_type") == "planning" or attrs.get("doc_type") == "planning"


def source_kind_of(source: Source | None, item: SourceItem | None) -> str:
    """ "github:issue" style kind of a piece of evidence; "manual" when free-standing."""
    if source is None or item is None:
        return FREE_STANDING_KIND
    return f"{source.kind}:{item.kind}"


async def _items(
    db: AsyncSession, item_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, tuple[SourceItem, Source, datetime | None]]:
    ids = list({i for i in item_ids if i})
    if not ids:
        return {}
    rows = await db.execute(
        select(SourceItem, Source, SourceItemVersion.fetched_at)
        .join(Source, Source.id == SourceItem.source_id)
        .outerjoin(SourceItemVersion, SourceItemVersion.id == SourceItem.current_version_id)
        .where(SourceItem.id.in_(ids))
    )
    return {item.id: (item, source, fetched) for item, source, fetched in rows.all()}


async def goal_contributions(
    db: AsyncSession, entity_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, int | None]:
    """Highest supports contribution to a confirmed goal per entity; goals count 3."""
    ids = list(set(entity_ids))
    out: dict[uuid.UUID, int | None] = dict.fromkeys(ids)
    if not ids:
        return out
    goals = await db.execute(select(Entity.id).where(Entity.id.in_(ids), Entity.type == "goal"))
    for (goal_id,) in goals.all():
        out[goal_id] = 3
    rows = await db.execute(
        select(Edge.src_id, Edge.attrs)
        .join(Entity, Entity.id == Edge.dst_id)
        .where(
            Edge.src_id.in_(ids),
            Edge.type == "supports",
            Edge.status != "rejected",
            Entity.type == "goal",
            Entity.status == "confirmed",
        )
    )
    for src_id, attrs in rows.all():
        c = (attrs or {}).get("contribution")
        if isinstance(c, int) and (out[src_id] is None or c > out[src_id]):
            out[src_id] = c
    return out


def _dec(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(str(round(value, 3)))


async def rescore_targets(
    db: AsyncSession,
    *,
    entity_ids: Iterable[uuid.UUID] = (),
    edge_ids: Iterable[uuid.UUID] = (),
    now: datetime | None = None,
) -> tuple[int, int, int]:
    """Rescore the evidence of these entities and edges and their aggregates."""
    entity_ids, edge_ids = set(entity_ids), set(edge_ids)
    if not entity_ids and not edge_ids:
        return 0, 0, 0
    now = now or datetime.now(UTC)
    settings = await company_weights(db)

    conds = []
    if entity_ids:
        conds.append(Evidence.entity_id.in_(entity_ids))
    if edge_ids:
        conds.append(Evidence.edge_id.in_(edge_ids))
    evidence = list((await db.scalars(select(Evidence).where(or_(*conds)))).all())
    items = await _items(db, (e.source_item_id for e in evidence))

    edges = (
        {e.id: e for e in (await db.scalars(select(Edge).where(Edge.id.in_(edge_ids)))).all()}
        if edge_ids
        else {}
    )
    contributions = await goal_contributions(db, entity_ids | {e.src_id for e in edges.values()})

    by_target: dict[uuid.UUID, list[Evidence]] = defaultdict(list)
    for ev in evidence:
        by_target[ev.entity_id or ev.edge_id].append(ev)

    for target, rows in by_target.items():
        mentions = max(1, len({r.source_item_id for r in rows if r.source_item_id}))
        entity_id = target if target in entity_ids else edges[target].src_id
        for ev in rows:
            item, source, fetched = items.get(ev.source_item_id, (None, None, None))
            if item is not None:
                stamps = [t for t in (item.source_updated_at, item.occurred_at) if t]
                latest = max(stamps) if stamps else (fetched or ev.retrieved_at)
            else:
                latest = ev.retrieved_at
            factors = confidence.Factors(
                source_kind=source.kind if source else FREE_STANDING_KIND,
                item_kind=item.kind if item else None,
                latest_at=latest,
                mentions=mentions,
                goal_contribution=contributions.get(entity_id),
                planning_doc=_planning(item.acl if item else None),
            )
            result = confidence.score(factors, settings, now=now)
            inputs = asdict(factors)
            inputs["latest_at"] = latest.isoformat() if latest else None
            ev.confidence = _dec(result.confidence)
            ev.confidence_factors = {
                "inputs": inputs,
                "breakdown": result.breakdown,
                "weights": {k: v["weight"] for k, v in result.breakdown.items()},
            }
            ev.scored_at = now

    for model, ids in ((Entity, entity_ids), (Edge, edge_ids)):
        if not ids:
            continue
        for row in (await db.scalars(select(model).where(model.id.in_(ids)))).all():
            scores = [float(ev.confidence) for ev in by_target.get(row.id, [])]
            row.confidence = _dec(confidence.aggregate(scores))
    await db.flush()
    return len(evidence), len(entity_ids), len(edge_ids)


async def rescore_around(
    db: AsyncSession, entity_ids: Iterable[uuid.UUID], *, include_supporters: bool = False
) -> None:
    """Rescore entities whose goal impact may have changed, and their outgoing edges.

    ``include_supporters`` also takes the entities that support these (a goal that was
    confirmed or rejected changes the goal impact of everything supporting it).
    """
    ids = set(entity_ids)
    if include_supporters and ids:
        rows = await db.scalars(
            select(Edge.src_id).where(Edge.dst_id.in_(ids), Edge.type == "supports")
        )
        ids |= set(rows.all())
    if not ids:
        return
    edge_ids = (await db.scalars(select(Edge.id).where(Edge.src_id.in_(ids)))).all()
    await rescore_targets(db, entity_ids=ids, edge_ids=edge_ids)


async def rescore_all(db: AsyncSession, now: datetime | None = None) -> tuple[int, int, int]:
    entity_ids = (await db.scalars(select(Entity.id))).all()
    edge_ids = (await db.scalars(select(Edge.id))).all()
    return await rescore_targets(db, entity_ids=entity_ids, edge_ids=edge_ids, now=now)
