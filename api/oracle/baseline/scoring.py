"""Confidence of the baseline's evidence, entities and edges (oracle.confidence).

Each evidence row is scored from oracle.confidence.Factors:

- source and item kind from its source item; public-link evidence counts as its
  ``kind`` (``notion``, ``google_docs`` or ``web``); "manual" for free-standing evidence;
- latest timestamp: the item's updated / occurred time, else its newest version's
  fetch time, else the evidence's retrieved_at; for a public link, the page's stated
  last change, else when it was last fetched. People read this live score, which
  decays as the source ages and follows it as it changes; a run reads freshness frozen
  and scored as of its pinned snapshot instead (``as_of_pin``, S6, owner 2026-10-20);
- mentions: distinct sources (source items and public links) behind the same entity
  or edge;
- goal contribution: the highest ``supports`` contribution from the entity (for an
  edge, its source entity) to a confirmed goal; a goal itself counts 3;
- planning document: the item's acl (or acl.attrs) ``doc_type`` is ``planning``.

The row keeps the confidence, the inputs, each factor's value and weight, when it was
scored and, for a source item, the item's time as it was when the evidence was taken
(``taken_latest_at``, recorded once: what a run reads). An entity's or edge's
confidence is ``confidence.aggregate`` of its evidence (None without evidence).
Weights come from the ``confidence_weights`` company setting.
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
from oracle.baseline.models import Edge, Entity, Evidence, EvidenceLinkSnapshot
from oracle.sources.models import Snapshot, Source, SourceItem, SourceItemVersion
from oracle.tenant_settings import TenantSetting

SETTINGS_KEY = "confidence_weights"
FREE_STANDING_KIND = "manual"
# confidence_factors key: a source item's freshness timestamp as it was when the
# evidence was taken, recorded by the first scoring and kept (what a run reads).
TAKEN_KEY = "taken_latest_at"


async def company_weights(db: AsyncSession) -> dict[str, Any]:
    value = await db.scalar(select(TenantSetting.value).where(TenantSetting.key == SETTINGS_KEY))
    return value if isinstance(value, dict) else {}


def _planning(acl: dict[str, Any] | None) -> bool:
    acl = acl or {}
    attrs = acl.get("attrs") if isinstance(acl.get("attrs"), dict) else {}
    return acl.get("doc_type") == "planning" or attrs.get("doc_type") == "planning"


def source_kind_of(
    source: Source | None, item: SourceItem | None, link_kind: str | None = None
) -> str:
    """ "github:issue" style kind of a piece of evidence; the link kind for a public
    link; "manual" when free-standing."""
    if link_kind:
        return link_kind
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


async def latest_snapshots(
    db: AsyncSession, evidence_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, EvidenceLinkSnapshot]:
    """The newest snapshot of each public-link evidence row."""
    ids = list(set(evidence_ids))
    if not ids:
        return {}
    rows = await db.scalars(
        select(EvidenceLinkSnapshot)
        .where(EvidenceLinkSnapshot.evidence_id.in_(ids))
        .order_by(EvidenceLinkSnapshot.fetched_at, EvidenceLinkSnapshot.created_at)
    )
    # A link keeps a snapshot only when its page changed, so there are few per row.
    return {s.evidence_id: s for s in rows.all()}


def link_latest(
    snapshot: EvidenceLinkSnapshot | None, fallback: datetime | None
) -> datetime | None:
    """A public link's freshness timestamp: its stated last change, else its fetch."""
    if snapshot is None:
        return fallback
    return snapshot.last_modified or snapshot.fetched_at


def _source_key(ev: Evidence) -> str | None:
    """What makes two pieces of evidence the same source: the item, or the link."""
    if ev.source_item_id:
        return f"item:{ev.source_item_id}"
    if ev.kind and ev.url:
        return f"link:{ev.url}"
    return None


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
    snapshots = await latest_snapshots(db, (e.id for e in evidence if e.kind))

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
        mentions = max(1, len({k for r in rows if (k := _source_key(r))}))
        entity_id = target if target in entity_ids else edges[target].src_id
        for ev in rows:
            item, source, fetched = items.get(ev.source_item_id, (None, None, None))
            if ev.kind:
                latest = link_latest(snapshots.get(ev.id), ev.retrieved_at)
            elif item is not None:
                stamps = [t for t in (item.source_updated_at, item.occurred_at) if t]
                latest = max(stamps) if stamps else (fetched or ev.retrieved_at)
            else:
                latest = ev.retrieved_at
            factors = confidence.Factors(
                source_kind=ev.kind or (source.kind if source else FREE_STANDING_KIND),
                item_kind=item.kind if item and not ev.kind else None,
                latest_at=latest,
                mentions=mentions,
                goal_contribution=contributions.get(entity_id),
                planning_doc=_planning(item.acl if item else None),
            )
            result = confidence.score(factors, settings, now=now)
            inputs = asdict(factors)
            inputs["latest_at"] = latest.isoformat() if latest else None
            ev.confidence = _dec(result.confidence)
            factors_out: dict[str, Any] = {
                "inputs": inputs,
                "breakdown": result.breakdown,
                "weights": {k: v["weight"] for k, v in result.breakdown.items()},
            }
            if item is not None and not ev.kind:
                # What a run reads, recorded once (as_of_pin).
                taken = _taken_latest(ev, item)
                factors_out[TAKEN_KEY] = taken.isoformat() if taken else None
            ev.confidence_factors = factors_out
            ev.scored_at = now

    for model, ids in ((Entity, entity_ids), (Edge, edge_ids)):
        if not ids:
            continue
        for row in (await db.scalars(select(model).where(model.id.in_(ids)))).all():
            scores = [float(ev.confidence) for ev in by_target.get(row.id, [])]
            row.confidence = _dec(confidence.aggregate(scores))
    await db.flush()
    return len(evidence), len(entity_ids), len(edge_ids)


def _taken_latest(ev: Evidence, item: SourceItem | None) -> datetime | None:
    """A source item's freshness timestamp as it was when the evidence was taken: the
    item's update or occurrence time no later than the evidence's ``retrieved_at`` (the
    version it quotes), else that ``retrieved_at``. The first scoring records it
    (``taken_latest_at``) and every later one keeps it, so an upstream change since
    never moves it: what a run reads (``as_of_pin``)."""
    recorded = (ev.confidence_factors or {}).get(TAKEN_KEY)
    if isinstance(recorded, str):
        try:
            return datetime.fromisoformat(recorded)
        except ValueError:
            pass
    taken = ev.retrieved_at
    if item is None:
        return taken
    stamps = [
        t
        for t in (item.source_updated_at, item.occurred_at)
        if t is not None and (taken is None or t <= taken)
    ]
    return max(stamps) if stamps else taken


async def as_of_pin(
    db: AsyncSession, rows: list[Evidence], pin: Snapshot
) -> dict[uuid.UUID, tuple[float, dict[str, Any]]]:
    """Evidence id -> (confidence, factors) as a run reads them (S6, owner 2026-10-20):
    freshness frozen and scored as of the run's pinned snapshot, so a run's score stays
    as it was when it started however its sources age or change since (people read the
    live score). A source item counts its time as it was when the evidence was taken
    (``_taken_latest``, never the item's times as it changed upstream since); a public
    link the newest page snapshot fetched by the pin; free-standing evidence its
    ``retrieved_at``. The other factors are the stored ones; rows never scored are left
    out."""
    scored = [r for r in rows if (r.confidence_factors or {}).get("inputs")]
    if not scored:
        return {}
    as_of = pin.as_of
    settings = await company_weights(db)
    unrecorded = {
        r.source_item_id
        for r in scored
        if r.source_item_id and not r.kind and TAKEN_KEY not in r.confidence_factors
    }
    items = await _items(db, unrecorded)
    links: dict[uuid.UUID, EvidenceLinkSnapshot] = {}
    if link_ids := [r.id for r in scored if r.kind]:
        snaps = await db.scalars(
            select(EvidenceLinkSnapshot)
            .where(
                EvidenceLinkSnapshot.evidence_id.in_(link_ids),
                EvidenceLinkSnapshot.fetched_at <= as_of,
            )
            .order_by(EvidenceLinkSnapshot.fetched_at, EvidenceLinkSnapshot.created_at)
        )
        links = {s.evidence_id: s for s in snaps.all()}
    out: dict[uuid.UUID, tuple[float, dict[str, Any]]] = {}
    for ev in scored:
        inputs = dict(ev.confidence_factors["inputs"])
        if ev.kind:
            latest = link_latest(links.get(ev.id), ev.retrieved_at)
        elif ev.source_item_id:
            latest = _taken_latest(ev, items.get(ev.source_item_id, (None,))[0])
        else:
            latest = ev.retrieved_at
        factors = confidence.Factors(
            source_kind=inputs.get("source_kind") or FREE_STANDING_KIND,
            item_kind=inputs.get("item_kind"),
            latest_at=latest,
            mentions=int(inputs.get("mentions") or 1),
            goal_contribution=inputs.get("goal_contribution"),
            planning_doc=bool(inputs.get("planning_doc")),
        )
        result = confidence.score(factors, settings, now=as_of)
        inputs["latest_at"] = latest.isoformat() if latest else None
        out[ev.id] = (
            round(result.confidence, 3),
            {
                "inputs": inputs,
                "breakdown": result.breakdown,
                "weights": {k: v["weight"] for k, v in result.breakdown.items()},
                "as_of": as_of.isoformat(),
            },
        )
    return out


async def preview_link(
    db: AsyncSession,
    *,
    kind: str,
    url: str,
    latest_at: datetime | None,
    entity_id: uuid.UUID | None = None,
    edge_id: uuid.UUID | None = None,
    now: datetime | None = None,
) -> confidence.Score:
    """How a public link would score on this entity or edge, without saving it."""
    settings = await company_weights(db)
    cond = Evidence.entity_id == entity_id if entity_id else Evidence.edge_id == edge_id
    rows = list((await db.scalars(select(Evidence).where(cond))).all())
    keys = {k for r in rows if (k := _source_key(r))} | {f"link:{url}"}
    if entity_id is None:
        edge = await db.get(Edge, edge_id)
        entity_id = edge.src_id if edge else None
    contributions = await goal_contributions(db, [entity_id] if entity_id else [])
    factors = confidence.Factors(
        source_kind=kind,
        latest_at=latest_at,
        mentions=len(keys),
        goal_contribution=contributions.get(entity_id) if entity_id else None,
    )
    return confidence.score(factors, settings, now=now)


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
