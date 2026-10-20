"""The evidence inspector (§7, §16.9): each section's internal claim-to-source links.

A section's links (``document_section_links``) point at baseline evidence, a source
item or a baseline entity (a decision, a requirement), at section, paragraph or claim
precision. The draft's own ``[c:id]`` markers are the other per-claim links. Both are
inspectable here and listed in the Sources and data points appendix of exports
(:func:`appendix_links`); the rendered body never carries them (O1c).

Visibility follows today's rules (AUD-9): baseline evidence and entities are visible to
everyone in the company, a source item only to the user whose source it is. Others see
that a source item backs the claim, and its kind, not what it says. A run (S6) reads a
source item as it reads it everywhere else: one its user's intakes withhold, one
deleted upstream, or one ever frozen by sharing with no release readable now is
restricted; one a share released shows the title and link released, never the item's
current ones.
"""

import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.baseline.evidence import run_versions, withheld_from
from oracle.baseline.models import Entity, Evidence
from oracle.docs.models import Citation, Document, DocumentVersion, Section
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.trace.schemas import (
    EvidenceCitation,
    EvidenceInspector,
    SectionEvidence,
    SectionLinkTarget,
    SectionLinkView,
)
from oracle.v2.models import DocumentSectionLink

SOURCES_KEY = "sources"
# Baseline items that no longer hold: exports do not list them by title.
INACTIVE = ("rejected", "superseded")


def _float(value) -> float | None:
    return None if value is None else float(value)


async def version_links(db: AsyncSession, version: DocumentVersion) -> list[DocumentSectionLink]:
    """Links made on this version, plus document-wide ones (no version)."""
    return list(
        (
            await db.scalars(
                select(DocumentSectionLink)
                .where(
                    DocumentSectionLink.document_id == version.document_id,
                    or_(
                        DocumentSectionLink.version_id == version.id,
                        DocumentSectionLink.version_id.is_(None),
                    ),
                )
                .order_by(DocumentSectionLink.created_at, DocumentSectionLink.id)
            )
        ).all()
    )


async def targets(
    db: AsyncSession, links: list[DocumentSectionLink], principal: Principal | None
) -> dict[uuid.UUID, SectionLinkTarget]:
    """The target of each link: its evidence, else its source item, else its entity.
    ``principal`` None (an export): no source item is readable."""
    ev_ids = {lk.evidence_id for lk in links if lk.evidence_id}
    item_ids = {lk.source_item_id for lk in links if lk.source_item_id}
    ent_ids = {lk.entity_id for lk in links if lk.entity_id}
    evidence = {}
    if ev_ids:
        evidence = {
            e.id: e for e in (await db.scalars(select(Evidence).where(Evidence.id.in_(ev_ids))))
        }
    items: dict[uuid.UUID, tuple[SourceItem, Source]] = {}
    if item_ids:
        rows = await db.execute(
            select(SourceItem, Source)
            .join(Source, Source.id == SourceItem.source_id)
            .where(SourceItem.id.in_(item_ids))
        )
        items = {i.id: (i, s) for i, s in rows.all()}
    entities = {}
    if ent_ids:
        entities = {
            e.id: e for e in (await db.scalars(select(Entity).where(Entity.id.in_(ent_ids))))
        }
    user_id = principal.user_id if principal is not None else None
    # A run reads an item as everywhere else (S6): withheld, deleted or frozen with no
    # release readable now is restricted; a released one is read at that version.
    withheld: set[uuid.UUID] = set()
    released: dict[uuid.UUID, SourceItemVersion] = {}
    frozen: dict[uuid.UUID, uuid.UUID | None] = {}
    if principal is not None and principal.is_run and items:
        withheld = await withheld_from(db, principal)
        frozen = await run_versions(db, principal, set(items))
        if version_ids := {v for v in frozen.values() if v}:
            rows = await db.scalars(
                select(SourceItemVersion).where(SourceItemVersion.id.in_(version_ids))
            )
            released = {v.item_id: v for v in rows}
    out: dict[uuid.UUID, SectionLinkTarget] = {}
    for lk in links:
        if lk.evidence_id in evidence:
            e = evidence[lk.evidence_id]
            out[lk.id] = SectionLinkTarget(
                type="evidence", id=e.id, title=e.ref or e.url, confidence=_float(e.confidence),
                url=e.url, ref=e.ref, excerpt=e.excerpt, source_kind=e.kind,
            )  # fmt: skip
        elif lk.source_item_id in items:
            item, source = items[lk.source_item_id]
            title, url = item.title, item.url
            readable = user_id is not None and source.owner_user_id == user_id
            if principal is not None and principal.is_run:
                if item.id in withheld or item.deleted_at is not None:
                    readable = False
                elif item.id in frozen:
                    version = released.get(item.id)
                    readable = version is not None
                    if version is not None:
                        title, url = version.title, version.url
            out[lk.id] = SectionLinkTarget(
                type="source_item",
                id=item.id,
                title=title if readable else None,
                url=url if readable else None,
                source_kind=source.kind,
                restricted=not readable,
            )
        elif lk.entity_id in entities:
            n = entities[lk.entity_id]
            out[lk.id] = SectionLinkTarget(
                type="entity", id=n.id, title=n.title, entity_type=n.type, status=n.status,
                locked=n.locked, confidence=_float(n.confidence), ref=f"{n.type}:{n.key}",
            )  # fmt: skip
    return out


def section_key_of(link: DocumentSectionLink, keys: set[str] | dict[str, str]) -> str:
    """The section ``link`` belongs to in a version with sections ``keys``. A link made
    on a version names its section exactly. A document-wide link (no version) may name
    it by stable reference (``<slug>#<key>``, ``<slug>@<n>#<key>``, ``#<key>``), in
    another case, or through the module that renders it."""
    key = link.section_key
    if link.version_id is not None or key in keys:
        return key
    tail = key.rsplit("#", 1)[-1].strip()
    for candidate in (tail, tail.lower(), link.module_key):
        if candidate and candidate in keys:
            return candidate
    return key


def _rank_key(view: SectionLinkView):
    c = view.target.confidence
    return (c is None, -(c or 0.0), view.created_at, str(view.id))


async def link_views(
    db: AsyncSession,
    links: list[DocumentSectionLink],
    hashes: dict[str, str],
    principal: Principal | None,
) -> dict[str, list[SectionLinkView]]:
    """Section key -> its links, strongest source first (B3 ranking by confidence)."""
    resolved = await targets(db, links, principal)
    by_section: dict[str, list[SectionLinkView]] = {}
    for lk in links:
        if lk.id not in resolved:
            continue
        key = section_key_of(lk, hashes)
        by_section.setdefault(key, []).append(
            SectionLinkView(
                id=lk.id,
                kind=lk.kind,  # type: ignore[arg-type]
                precision=lk.precision,  # type: ignore[arg-type]
                claim=lk.claim,
                module_key=lk.module_key,
                composition_revision=lk.composition_revision,
                current=lk.section_hash is None or lk.section_hash == hashes.get(key),
                target=resolved[lk.id],
                created_by=lk.created_by,
                created_at=lk.created_at,
            )
        )
    for views in by_section.values():
        views.sort(key=_rank_key)
    return by_section


async def _sections(db: AsyncSession, version: DocumentVersion) -> list[Section]:
    return list(
        (
            await db.scalars(
                select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
            )
        ).all()
    )


async def inspector(
    db: AsyncSession,
    principal: Principal,
    document: Document,
    version: DocumentVersion,
    section: str | None = None,
) -> EvidenceInspector:
    sections = await _sections(db, version)
    if section is not None:
        sections = [s for s in sections if s.section_key == section]
    hashes = {s.section_key: s.content_hash for s in sections}
    views = await link_views(db, await version_links(db, version), hashes, principal)
    citations = {
        c.cite_key: c
        for c in (await db.scalars(select(Citation).where(Citation.version_id == version.id)))
    }
    return EvidenceInspector(
        document_id=document.id,
        document_slug=document.slug,
        version_id=version.id,
        number=version.number,
        approved=version.approved_at is not None,
        snapshot=version.snapshot,
        sections=[
            SectionEvidence(
                section_key=s.section_key,
                heading=s.heading,
                level=s.level,
                layer=s.layer,
                section_hash=s.content_hash,
                links=views.get(s.section_key, []),
                citations=[
                    EvidenceCitation(
                        cite_key=k,
                        source=citations[k].source,
                        ref=citations[k].ref,
                        title=citations[k].title,
                        excerpt=citations[k].excerpt,
                        retrieved_at=citations[k].retrieved_at,
                    )  # fmt: skip
                    for k in s.citation_keys or []
                    if k in citations
                ],
            )
            for s in sections
        ],
    )


def _label(target: SectionLinkTarget) -> str:
    if target.type == "source_item":
        return f"{target.source_kind} source item"
    if target.type == "entity":
        return f"{(target.entity_type or 'item').replace('_', ' ').capitalize()}: {target.title}"
    return target.title or target.excerpt or "evidence"


async def appendix_links(db: AsyncSession, version: DocumentVersion) -> list[dict[str, Any]]:
    """For the Sources and data points appendix: per body section (in order), its links
    as {claim, label, kind, confidence}. Source items show their kind only (an export
    is not addressed to a source's owner); rejected or superseded baseline items are
    left out (their titles no longer hold). Document-wide links go under the section
    they name (:func:`section_key_of`)."""
    links = await version_links(db, version)
    if not links:
        return []
    sections = await _sections(db, version)
    hashes = {s.section_key: s.content_hash for s in sections}
    views = await link_views(db, links, hashes, None)
    out = []
    for s in sections:
        if s.section_key == SOURCES_KEY or s.section_key not in views:
            continue
        listed = [
            {
                "claim": v.claim,
                "label": _label(v.target),
                "kind": v.kind,
                "confidence": v.target.confidence,
            }
            for v in views[s.section_key]
            if not (v.target.type == "entity" and v.target.status in INACTIVE)
        ]
        if listed:
            out.append({"key": s.section_key, "links": listed})
    return out
