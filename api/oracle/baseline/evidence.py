"""Evidence on entities and edges, and who may see the source item behind it.

Source items are private to their owner (S3, revised 2026-10-17). Evidence copies the
excerpt, url and ref out of the item, so everyone can read the claim's support; the
item itself (its id, title, source) is shown only to its owner. Everyone else gets
``source_item_private``. A run token never cites or reads an item its user's intakes
withhold from runs (S6): such an item is missing to it.

Public-link evidence (the owner, 2026-10-17) is different: a commenter or anyone above
cites a public page by its URL, Oracle fetches it without any credential
(``oracle.baseline.public_links``) and keeps a snapshot of it. The page is public, so
everyone sees the snapshot too. Refreshing fetches it again and rescores.
"""

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes, confidence
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
from oracle.sources.models import Snapshot, Source, SourceItem, SourceItemVersion
from oracle.v2 import links

EXCERPT_CHARS = 500


async def withheld_from(db: AsyncSession, principal: Principal) -> set[uuid.UUID]:
    """Items a run token may not read, copy or quote (S6, ``run_withheld``): to it they
    are missing, like another user's."""
    from oracle.intake.evidence import run_withheld

    return await run_withheld(db, principal) or set()


async def run_versions(
    db: AsyncSession, principal: Principal, item_ids: set[uuid.UUID]
) -> dict[uuid.UUID, uuid.UUID | None]:
    """For a run, item id -> the version released of each of ``item_ids`` ever frozen
    by a share (S6, freeze at sharing), None where none is readable now: such an item
    is read at that version only, or not at all, never at its current one (as
    ``/v1/source-items/{id}``). Empty for anyone but a run."""
    from oracle.intake.evidence import run_shared

    shared = run_shared(principal)
    if shared is None or not item_ids:
        return {}
    frozen_col = shared.frozen.selected_columns[0]
    frozen = set((await db.scalars(shared.frozen.where(frozen_col.in_(item_ids)))).all())
    released = shared.released.subquery()
    pairs = dict(
        (
            await db.execute(
                select(released.c.item_id, released.c.version_id).where(
                    released.c.item_id.in_(frozen)
                )
            )
        ).all()
    )
    return {i: pairs.get(i) for i in frozen}


def as_read(principal: Principal, stored: float | None, rows: list[EvidenceOut]) -> float | None:
    """An entity's or edge's confidence as ``present`` gave its evidence: for a run, the
    aggregate of its evidence as of the run's pin; for people, the stored one."""
    if not principal.is_run:
        return stored
    value = confidence.aggregate([r.confidence for r in rows if r.confidence is not None])
    return None if value is None else round(value, 3)


async def run_pin(db: AsyncSession, principal: Principal) -> Snapshot | None:
    """The snapshot the principal's run pinned when it started; None for anyone but a
    run, and for a run that pinned none."""
    if not principal.is_run:
        return None
    from oracle.runs.models import Run

    return await db.scalar(
        select(Snapshot).join(Run, Run.snapshot_id == Snapshot.id).where(Run.id == principal.run_id)
    )


class RunView:
    """What a run reads as the confidence of entities and edges (S6, owner 2026-10-20):
    each evidence row as of the run's pin (``scoring.as_of_pin``, through ``present``),
    aggregated as the detail routes do. One shared helper for every output builder; build
    it with ``run_view`` (None for people, who read the stored live value, and for a run
    that pinned no snapshot, which keeps reading the stored value)."""

    def __init__(
        self,
        rows: dict[tuple[str, uuid.UUID], list[float | None]],
        by_evidence: dict[uuid.UUID, float | None] | None = None,
    ) -> None:
        self.rows = rows
        self.by_evidence = by_evidence or {}

    def scores(self, kind: str, target_id: uuid.UUID) -> list[float | None]:
        return self.rows.get((kind, target_id), [])

    def confidence(self, kind: str, target_id: uuid.UUID) -> float | None:
        value = confidence.aggregate([c for c in self.scores(kind, target_id) if c is not None])
        return None if value is None else round(value, 3)


async def run_view(
    db: AsyncSession,
    principal: Principal | None,
    *,
    entity_ids: Iterable[uuid.UUID] = (),
    edge_ids: Iterable[uuid.UUID] = (),
) -> RunView | None:
    """Batched: one evidence read for all the ids, however many (no N+1 over a graph)."""
    if principal is None or not principal.is_run:
        return None
    entity_ids, edge_ids = list(entity_ids), list(edge_ids)
    if not entity_ids and not edge_ids:
        return RunView({})
    if await run_pin(db, principal) is None:
        return None
    stmt = select(Evidence).where(
        or_(Evidence.entity_id.in_(entity_ids), Evidence.edge_id.in_(edge_ids))
    )
    rows = list((await db.scalars(stmt)).all())
    shown = await present(db, principal, rows)
    by_row = {r.id: r for r in rows}
    grouped: dict[tuple[str, uuid.UUID], list[float | None]] = {}
    for ev in shown:
        row = by_row[ev.id]
        if row.entity_id is not None:
            grouped.setdefault(("entity", row.entity_id), []).append(ev.confidence)
        if row.edge_id is not None:
            grouped.setdefault(("edge", row.edge_id), []).append(ev.confidence)
    return RunView(grouped, {ev.id: ev.confidence for ev in shown})


async def _own_item(
    db: AsyncSession, principal: Principal, item_id: uuid.UUID
) -> tuple[SourceItem, Source, SourceItemVersion | None]:
    """The item if the principal's user owns it; someone else's item reads as missing.
    A run reads an item a finding shared in full released at the version released only
    (S6, freeze at sharing), an item ever frozen with no release readable now and an
    item deleted upstream as missing."""
    row = (
        await db.execute(
            select(SourceItem, Source)
            .join(Source, Source.id == SourceItem.source_id)
            .where(SourceItem.id == item_id)
        )
    ).first()
    if (
        row is None
        or principal.user_id is None
        or row[1].owner_user_id != principal.user_id
        or item_id in await withheld_from(db, principal)
    ):
        raise NotFoundError("Source item not found among your sources")
    item, source = row
    version_id = item.current_version_id
    if principal.is_run:
        if item.deleted_at is not None:
            raise NotFoundError("Source item not found among your sources")
        frozen = await run_versions(db, principal, {item_id})
        if item_id in frozen:
            version_id = frozen[item_id]
            if version_id is None:
                raise NotFoundError("Source item not found among your sources")
    version = await db.get(SourceItemVersion, version_id) if version_id else None
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
        # The link as read too (S6, links): a Notion link carries the page title.
        ev.url = data.url or (version.url if version is not None else item.url)
        # The title as read (a run: as shared, S6), never the item's current one: a
        # rename upstream never reaches evidence people read.
        ev.ref = data.ref or (version.title if version is not None else None) or item.external_id
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


def evidence_snapshot(ev: Evidence) -> dict[str, Any]:
    """What removed evidence was, for the change that records its removal. The source
    item stays out: it is private to its owner."""
    return {
        "id": str(ev.id),
        "entity_id": str(ev.entity_id) if ev.entity_id else None,
        "edge_id": str(ev.edge_id) if ev.edge_id else None,
        "kind": ev.kind,
        "url": ev.url,
        "ref": ev.ref,
        "excerpt": (ev.excerpt or "")[:EXCERPT_CHARS] or None,
        "from_source_item": ev.source_item_id is not None,
    }


async def detach(db: AsyncSession, principal: Principal, evidence_id: uuid.UUID) -> None:
    ev = await db.get(Evidence, evidence_id)
    if ev is None:
        raise NotFoundError("Evidence not found")
    # Approvers remove any evidence; a commenter removes only link evidence they added (C2c).
    if not has_role(principal.role, "approver") and not (
        ev.kind is not None and ev.added_by == principal.id
    ):
        raise ForbiddenError("Only approvers, or the person who added this link, can remove it.")
    entity_id, edge_id = ev.entity_id, ev.edge_id
    await audit.record(
        db,
        principal,
        "baseline.evidence.removed",
        "evidence",
        ev.id,
        {"url": ev.url, "ref": ev.ref, "excerpt": ev.excerpt},
    )
    # v2 hook, before the delete: what rests on it, and the section links citing it, are
    # found while it exists (oracle.trace). Then a link citing it keeps its other target
    # (an entity or a source item) and only drops the evidence; one left with none goes.
    await changes.record_change(
        db,
        "source_permission",
        cause="evidence_deleted",
        actor=principal,
        subject_id=ev.id,
        subject_ref=ev.ref or ev.url,
        data={"evidence": [evidence_snapshot(ev)]},
    )
    await links.release(db, evidence_ids={ev.id})
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
    """Evidence as the principal may see it: the item only for its owner. People read
    the live confidence; a run reads it as of its pinned snapshot (S6, owner
    2026-10-20, ``scoring.as_of_pin``)."""
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
    withheld = await withheld_from(db, principal) if item_ids else set()
    # A run sees an item ever frozen at the version released (S6, links), or not at all.
    frozen = await run_versions(db, principal, set(items))
    versions: dict[uuid.UUID, SourceItemVersion] = {}
    if released := {v for v in frozen.values() if v}:
        res = await db.scalars(select(SourceItemVersion).where(SourceItemVersion.id.in_(released)))
        versions = {v.item_id: v for v in res.all()}

    def mine(item: SourceItem | None, source: Source | None) -> bool:
        return (
            item is not None
            and source is not None
            and principal.user_id == source.owner_user_id
            and item.id not in withheld
            and not (item.id in frozen and frozen[item.id] is None)
            # A run never reads an item deleted upstream, frozen or not (S6).
            and not (principal.is_run and item.deleted_at is not None)
        )

    pin = await run_pin(db, principal)
    pinned = await scoring.as_of_pin(db, rows, pin) if pin is not None else {}
    out = []
    for r in rows:
        item, source = items.get(r.source_item_id, (None, None))
        shown = mine(item, source)
        score, factors = pinned.get(r.id) or (
            float(r.confidence) if r.confidence is not None else None,
            r.confidence_factors or {},
        )
        version = versions.get(item.id) if item is not None else None
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
                    # The stored ref (the title as attached), never the item's current
                    # title (S6, titles).
                    title=r.ref,
                    # An item a run reads as released: the link released (S6,
                    # links). Otherwise the link as it is now (a rename writes no
                    # version; owners are never frozen).
                    url=version.url if version is not None else item.url,
                )
                if shown
                else None,
                source_item_private=item is not None and not shown,
                source_removed=item is not None and item.deleted_at is not None,
                confidence=score,
                confidence_factors=factors,
                scored_at=pin.as_of if pin is not None and r.id in pinned else r.scored_at,
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
