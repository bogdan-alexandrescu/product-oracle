"""Evidence on entities and edges, and who may see the source item behind it.

Source items are private to their owner (S3, revised 2026-10-17). Evidence copies the
excerpt, url and ref out of the item, so everyone can read the claim's support; the
item itself (its id, title, source) is shown only to its owner. Everyone else gets
``source_item_private``.

Public-link evidence (the owner, 2026-10-17) is different: a commenter or anyone above
cites a public page by its URL, Oracle fetches it without any credential
(``oracle.baseline.public_links``) and keeps a snapshot of it. The page is public, so
everyone sees the snapshot too. Refreshing fetches it again and rescores.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.baseline import public_links, scoring, service
from oracle.baseline.models import Edge, Entity, Evidence, EvidenceLinkSnapshot
from oracle.baseline.schemas import (
    EvidenceCreate,
    EvidenceLinkCreate,
    EvidenceOut,
    LinkPreviewOut,
    LinkSnapshotOut,
    LinkTarget,
    SourceItemRef,
)
from oracle.baseline.service import ConflictError, ForbiddenError, InvalidError, NotFoundError
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
        added_by=principal.id,
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


async def _approver_now(db: AsyncSession, principal: Principal) -> bool:
    """The caller is an approver now, read under the review gate (C2: a disable or a
    demotion that commits first wins)."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    await publish.gate_lock(db, shared=True)
    return await caller_refusal(db, principal, "approver") is None


async def detach(db: AsyncSession, principal: Principal, evidence_id: uuid.UUID) -> None:
    ev = await db.get(Evidence, evidence_id)
    if ev is None:
        raise NotFoundError("Evidence not found")
    # Approvers remove any evidence; a commenter removes only link evidence they added (C2c).
    if not (ev.kind is not None and ev.added_by == principal.id):
        if not has_role(principal.role, "approver") or not await _approver_now(db, principal):
            raise ForbiddenError(
                "Only approvers, or the person who added this link, can remove it."
            )
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


# --- public links ---------------------------------------------------------------------------


def excerpt_of(text: str, limit: int = EXCERPT_CHARS) -> str:
    """The start of a page's text, cut at a word."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0] or text[:limit]
    return cut.rstrip(" ,.;:") + "…"


async def _link_target(db: AsyncSession, data: LinkTarget) -> tuple[Entity | None, Edge | None]:
    if (data.entity_id is None) == (data.edge_id is None):
        raise InvalidError("pass exactly one of entity_id or edge_id")
    if data.entity_id:
        return await service.get_entity(db, data.entity_id), None
    return None, await service.get_edge(db, data.edge_id)


async def _cited(
    db: AsyncSession, url: str, entity: Entity | None, edge: Edge | None
) -> Evidence | None:
    cond = Evidence.entity_id == entity.id if entity else Evidence.edge_id == edge.id
    return await db.scalar(
        select(Evidence).where(cond, Evidence.kind.is_not(None), Evidence.url == url).limit(1)
    )


def _snapshot(ev: Evidence, page: public_links.Page, principal: Principal) -> EvidenceLinkSnapshot:
    return EvidenceLinkSnapshot(
        evidence_id=ev.id,
        final_url=page.final_url,
        title=page.title,
        text=page.text,
        content_hash=page.content_hash,
        content_type=page.content_type,
        fetched_at=page.fetched_at,
        last_modified=page.last_modified,
        fetched_by=principal.id,
    )


async def preview_link(
    db: AsyncSession, data: LinkTarget, fetcher: public_links.LinkFetcher
) -> LinkPreviewOut:
    """Fetch the link and say how it would score here, without saving anything."""
    entity, edge = await _link_target(db, data)
    target = public_links.classify(data.url)
    page = await fetcher.fetch(target.url)
    result = await scoring.preview_link(
        db,
        kind=page.kind,
        url=page.url,
        latest_at=page.last_modified or page.fetched_at,
        entity_id=entity.id if entity else None,
        edge_id=edge.id if edge else None,
    )
    return LinkPreviewOut(
        url=page.url,
        kind=page.kind,
        final_url=page.final_url,
        title=page.title,
        excerpt=excerpt_of(page.text),
        fetched_at=page.fetched_at,
        last_modified=page.last_modified,
        confidence=result.confidence,
        confidence_factors={
            "breakdown": result.breakdown,
            "weights": {k: v["weight"] for k, v in result.breakdown.items()},
        },
        already_cited=await _cited(db, page.url, entity, edge) is not None,
    )


async def add_link(
    db: AsyncSession,
    principal: Principal,
    data: EvidenceLinkCreate,
    fetcher: public_links.LinkFetcher,
) -> Evidence:
    entity, edge = await _link_target(db, data)
    target = public_links.classify(data.url)
    if await _cited(db, target.url, entity, edge):
        raise ConflictError("This link is already cited here; refresh it instead.")
    page = await fetcher.fetch(target.url)
    ev = Evidence(
        entity_id=entity.id if entity else None,
        edge_id=edge.id if edge else None,
        kind=page.kind,
        url=page.url,
        excerpt=excerpt_of(page.text),
        ref=page.title or page.url,
        note=(data.note or "").strip() or None,
        retrieved_at=page.fetched_at,
        added_by=principal.id,
    )
    db.add(ev)
    await db.flush()
    db.add(_snapshot(ev, page, principal))
    await db.flush()
    await audit.record(
        db,
        principal,
        "baseline.evidence.link_added",
        "evidence",
        ev.id,
        {
            "entity_id": str(ev.entity_id) if ev.entity_id else None,
            "edge_id": str(ev.edge_id) if ev.edge_id else None,
            "url": ev.url,
            "kind": ev.kind,
        },
    )
    await rescore_target(db, ev.entity_id, ev.edge_id)
    return ev


async def refresh_link(
    db: AsyncSession,
    principal: Principal,
    evidence_id: uuid.UUID,
    fetcher: public_links.LinkFetcher,
) -> Evidence:
    """Fetch a public link again, keep the new snapshot and rescore."""
    ev = await db.get(Evidence, evidence_id)
    if ev is None:
        raise NotFoundError("Evidence not found")
    if not ev.kind or not ev.url:
        raise InvalidError("Only evidence added from a public link can be refreshed")
    page = await fetcher.fetch(ev.url)
    current = (await scoring.latest_snapshots(db, [ev.id])).get(ev.id)
    changed = current is None or current.content_hash != page.content_hash
    if changed:
        db.add(_snapshot(ev, page, principal))
    else:
        current.fetched_at = page.fetched_at
        current.final_url = page.final_url
        current.last_modified = page.last_modified or current.last_modified
        current.fetched_by = principal.id
    ev.kind = page.kind
    ev.excerpt = excerpt_of(page.text)
    ev.ref = page.title or page.url
    ev.retrieved_at = page.fetched_at
    await db.flush()
    await audit.record(
        db,
        principal,
        "baseline.evidence.link_refreshed",
        "evidence",
        ev.id,
        {"url": ev.url, "changed": changed},
    )
    await rescore_target(db, ev.entity_id, ev.edge_id)
    return ev


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
    # Public links were fetched anonymously: their snapshot is shown to everyone.
    snapshots = await scoring.latest_snapshots(db, [r.id for r in rows if r.kind])
    out = []
    for r in rows:
        item, source = items.get(r.source_item_id, (None, None))
        mine = source is not None and principal.user_id == source.owner_user_id
        snap = snapshots.get(r.id)
        out.append(
            EvidenceOut(
                id=r.id,
                entity_id=r.entity_id,
                edge_id=r.edge_id,
                url=r.url,
                excerpt=r.excerpt,
                ref=r.ref,
                retrieved_at=r.retrieved_at,
                source_kind=scoring.source_kind_of(source, item, r.kind),
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
                kind=r.kind,
                note=r.note,
                link=LinkSnapshotOut(
                    kind=r.kind,
                    final_url=snap.final_url,
                    title=snap.title,
                    fetched_at=snap.fetched_at,
                    last_modified=snap.last_modified,
                    text_chars=len(snap.text),
                )
                if snap is not None and r.kind
                else None,
            )
        )
    return out
