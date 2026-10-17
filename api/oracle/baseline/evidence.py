"""Evidence on entities and edges, and who may see the source item behind it.

Source items are private to their owner (S3, revised 2026-10-17). Evidence copies the
excerpt, url and ref out of the item, so everyone can read the claim's support; the
item itself (its id, title, source) is shown only to its owner. Everyone else gets
``source_item_private``.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.baseline import scoring
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.baseline.schemas import EvidenceCreate, EvidenceOut, SourceItemRef
from oracle.baseline.service import InvalidError, NotFoundError
from oracle.sources.models import Source, SourceItem, SourceItemVersion

EXCERPT_CHARS = 500


async def _own_item(
    db: AsyncSession, principal: Principal, item_id: uuid.UUID
) -> tuple[SourceItem, Source, SourceItemVersion | None]:
    """The item if the principal's user owns it; someone else's item reads as missing."""
    row = (
        await db.execute(
            select(SourceItem, Source)
            .join(Source, Source.id == SourceItem.source_id)
            .where(SourceItem.id == item_id)
        )
    ).first()
    if row is None or principal.user_id is None or row[1].owner_user_id != principal.user_id:
        raise NotFoundError("Source item not found among your sources")
    item, source = row
    version = (
        await db.get(SourceItemVersion, item.current_version_id)
        if item.current_version_id
        else None
    )
    return item, source, version


async def attach(
    db: AsyncSession,
    principal: Principal,
    data: EvidenceCreate,
    *,
    entity: Entity | None = None,
    edge: Edge | None = None,
) -> Evidence:
    ev = Evidence(
        entity_id=entity.id if entity else None,
        edge_id=edge.id if edge else None,
        url=data.url,
        excerpt=data.excerpt,
        ref=data.ref,
        retrieved_at=data.retrieved_at,
    )
    if data.source_item_id:
        item, source, version = await _own_item(db, principal, data.source_item_id)
        ev.source_item_id = item.id
        ev.url = data.url or item.url
        ev.ref = data.ref or item.title or item.external_id
        if not data.excerpt and version is not None:
            ev.excerpt = version.content[:EXCERPT_CHARS]
        ev.retrieved_at = data.retrieved_at or (version.fetched_at if version else None)
    elif not (data.url or data.excerpt or data.ref):
        raise InvalidError("evidence needs a source item, or a url, ref or excerpt")
    ev.retrieved_at = ev.retrieved_at or datetime.now(UTC)
    db.add(ev)
    await db.flush()
    await audit.record(
        db,
        principal,
        "baseline.evidence.added",
        "evidence",
        ev.id,
        {
            "entity_id": str(ev.entity_id) if ev.entity_id else None,
            "edge_id": str(ev.edge_id) if ev.edge_id else None,
        },
    )
    await rescore_target(db, ev.entity_id, ev.edge_id)
    return ev


async def rescore_target(
    db: AsyncSession, entity_id: uuid.UUID | None, edge_id: uuid.UUID | None
) -> None:
    await scoring.rescore_targets(
        db, entity_ids=[entity_id] if entity_id else [], edge_ids=[edge_id] if edge_id else []
    )


async def detach(db: AsyncSession, principal: Principal, evidence_id: uuid.UUID) -> None:
    ev = await db.get(Evidence, evidence_id)
    if ev is None:
        raise NotFoundError("Evidence not found")
    entity_id, edge_id = ev.entity_id, ev.edge_id
    await audit.record(
        db,
        principal,
        "baseline.evidence.removed",
        "evidence",
        ev.id,
        {"url": ev.url, "ref": ev.ref, "excerpt": ev.excerpt},
    )
    await db.delete(ev)
    await db.flush()
    await rescore_target(db, entity_id, edge_id)


async def list_for(
    db: AsyncSession, *, entity_id: uuid.UUID | None = None, edge_id: uuid.UUID | None = None
) -> list[Evidence]:
    stmt = select(Evidence).order_by(Evidence.confidence.desc().nulls_last(), Evidence.created_at)
    if entity_id:
        stmt = stmt.where(Evidence.entity_id == entity_id)
    if edge_id:
        stmt = stmt.where(Evidence.edge_id == edge_id)
    return list((await db.scalars(stmt)).all())


async def present(
    db: AsyncSession, principal: Principal, rows: list[Evidence]
) -> list[EvidenceOut]:
    """Evidence as the principal may see it: the item only for its owner."""
    item_ids = {r.source_item_id for r in rows if r.source_item_id}
    items: dict[uuid.UUID, tuple[SourceItem, Source]] = {}
    if item_ids:
        res = await db.execute(
            select(SourceItem, Source)
            .join(Source, Source.id == SourceItem.source_id)
            .where(SourceItem.id.in_(item_ids))
        )
        items = {item.id: (item, source) for item, source in res.all()}
    out = []
    for r in rows:
        item, source = items.get(r.source_item_id, (None, None))
        mine = source is not None and principal.user_id == source.owner_user_id
        out.append(
            EvidenceOut(
                id=r.id,
                entity_id=r.entity_id,
                edge_id=r.edge_id,
                url=r.url,
                excerpt=r.excerpt,
                ref=r.ref,
                retrieved_at=r.retrieved_at,
                source_kind=scoring.source_kind_of(source, item),
                source_item=SourceItemRef(
                    id=item.id,
                    source_id=source.id,
                    source_kind=source.kind,
                    kind=item.kind,
                    title=item.title,
                    url=item.url,
                )
                if mine
                else None,
                source_item_private=item is not None and not mine,
                confidence=float(r.confidence) if r.confidence is not None else None,
                confidence_factors=r.confidence_factors or {},
                scored_at=r.scored_at,
                created_at=r.created_at,
            )
        )
    return out
