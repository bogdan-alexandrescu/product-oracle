"""Coverage of sources (A2): what Oracle read from each source, what it left out and
why, how fresh it is, and where it is used.

A person reads the coverage of their own sources only (S5: sources are their owner's).
Owners also read the Company tab (owner 2026-10-21, "Coverage"): per active member and
source kind, the number of sources, live items, freshness and the newest sync, and
nothing else: no source name, id, item or not-read entry leaves this module through
``company_coverage``.

Every number comes from tables that already exist; the list and the Company tab are a
fixed number of statements whatever the number of sources or members.
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import (
    DateTime,
    Integer,
    Text,
    Uuid,
    and_,
    cast,
    column,
    distinct,
    func,
    literal,
    null,
    select,
    union_all,
    values,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from oracle import confidence
from oracle.auth.models import User
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.docs.models import Citation, Document, DocumentVersion, Section
from oracle.sources.items import confidence_settings
from oracle.sources.models import ITEM_KINDS, SOURCE_KINDS, Source, SourceItem, SourceItemVersion
from oracle.sources.schemas import (
    CompanyCoverage,
    CompanyKindCoverage,
    CompanyMember,
    CompanyMemberCoverage,
    CoverageList,
    FreshnessCounts,
    KindCoverage,
    NotReadCounts,
    SourceCoverage,
    SourceCoverageDetail,
    UnavailableItem,
    UsedCounts,
    UsedDocument,
    UsedEntity,
    UsedIn,
    UsedItem,
)
from oracle.v2.models import DocumentSectionLink

NOT_READ_STATUSES = ("skipped", "unavailable", "flagged", "limited")
DEFAULT_HALF_LIFE = 90


def half_life_days(settings: dict[str, Any] | None, source_kind: str, item_kind: str) -> float:
    """Freshness halves every this many days for items of ``item_kind`` in a source of
    ``source_kind``: the most specific key of ``half_life_days`` wins, with the company's
    ``confidence_weights`` applied (as ``confidence.score`` reads it)."""
    table = confidence.merged(settings)["half_life_days"]
    return float(confidence._lookup(table, source_kind, item_kind, DEFAULT_HALF_LIFE))


def item_time():
    """An item's time: the latest of its own timestamps, else its current version's
    fetch, the same "latest" as ``confidence.Factors.latest_at``. Null with neither."""
    return func.coalesce(
        func.greatest(SourceItem.source_updated_at, SourceItem.occurred_at),
        SourceItemVersion.fetched_at,
    )


def _half_life_table(settings: dict[str, Any] | None, now: datetime):
    """A VALUES table of every (source kind, item kind) with the times an item must be
    newer than to be fresh (one half-life) and aging (two)."""
    rows = []
    for sk in SOURCE_KINDS:
        for ik in ITEM_KINDS:
            days = half_life_days(settings, sk, ik)
            rows.append((sk, ik, now - timedelta(days=days), now - timedelta(days=2 * days)))
    return values(
        column("source_kind", Text),
        column("item_kind", Text),
        column("fresh_after", DateTime(timezone=True)),
        column("aging_after", DateTime(timezone=True)),
        name="hl",
    ).data(rows)


def _item_stats(group: list, where, settings: dict[str, Any] | None, now: datetime):
    """One statement: per ``group`` columns and item kind, the live items (``items``),
    the soft-deleted ones (``removed``), the newest and oldest live item, and the live
    items that are ``fresh`` (age up to one half-life, freshness 0.5 or more) and
    ``aging`` (more than one and up to two). Stale is the rest of the live items, an item
    with no time at all included."""
    hl = _half_life_table(settings, now)
    ts = item_time()
    live = SourceItem.deleted_at.is_(None)
    return (
        select(
            *group,
            SourceItem.kind.label("item_kind"),
            func.count().filter(live).label("items"),
            func.count().filter(SourceItem.deleted_at.is_not(None)).label("removed"),
            func.max(ts).filter(live).label("newest_at"),
            func.min(ts).filter(live).label("oldest_at"),
            func.count().filter(and_(live, ts >= hl.c.fresh_after)).label("fresh"),
            func.count()
            .filter(and_(live, ts < hl.c.fresh_after, ts >= hl.c.aging_after))
            .label("aging"),
        )
        .select_from(SourceItem)
        .join(Source, Source.id == SourceItem.source_id)
        .outerjoin(SourceItemVersion, SourceItemVersion.id == SourceItem.current_version_id)
        .join(hl, and_(hl.c.source_kind == Source.kind, hl.c.item_kind == SourceItem.kind))
        .where(where)
        .group_by(*group, SourceItem.kind)
    )


def _uses():
    """Every use of a source item, one row each: (kind, item_id, document_id)."""
    return union_all(
        select(
            literal("evidence").label("kind"),
            Evidence.source_item_id.label("item_id"),
            cast(null(), Uuid).label("document_id"),
        ).where(Evidence.source_item_id.is_not(None)),
        select(literal("citation"), Citation.item_id, DocumentVersion.document_id)
        .join(DocumentVersion, DocumentVersion.id == Citation.version_id)
        .where(Citation.item_id.is_not(None)),
        select(
            literal("section_link"),
            DocumentSectionLink.source_item_id,
            DocumentSectionLink.document_id,
        ).where(DocumentSectionLink.source_item_id.is_not(None)),
    ).subquery("u")


def not_read(entries: list[dict[str, Any]] | None) -> NotReadCounts:
    """``sources.unavailable_items`` counted by status; a missing (or unknown) status
    counts as unavailable, as the web reads it."""
    counts = dict.fromkeys(NOT_READ_STATUSES, 0)
    for entry in entries or []:
        status = entry.get("status") if isinstance(entry, dict) else None
        counts[status if status in counts else "unavailable"] += 1
    return NotReadCounts(**counts)


def not_read_items(entries: list[dict[str, Any]] | None) -> list[UnavailableItem]:
    out = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        status = entry.get("status")
        out.append(
            UnavailableItem(
                external_id=str(entry.get("external_id", "")),
                reason=str(entry.get("reason", "")),
                name=entry.get("name"),
                status=status if status in NOT_READ_STATUSES else "unavailable",
            )
        )
    return out


@dataclass
class _Tally:
    items: int = 0
    removed: int = 0
    fresh: int = 0
    aging: int = 0
    newest_at: datetime | None = None
    oldest_at: datetime | None = None
    kinds: list[KindCoverage] = field(default_factory=list)

    def add(self, row: Any, half_life: float) -> None:
        self.items += row.items
        self.removed += row.removed
        self.fresh += row.fresh
        self.aging += row.aging
        if row.newest_at is not None:
            self.newest_at = max(filter(None, (self.newest_at, row.newest_at)))
        if row.oldest_at is not None:
            self.oldest_at = min(filter(None, (self.oldest_at, row.oldest_at)))
        if row.items:
            self.kinds.append(
                KindCoverage(
                    kind=row.item_kind,
                    items=row.items,
                    newest_at=row.newest_at,
                    half_life_days=half_life,
                )
            )

    @property
    def freshness(self) -> FreshnessCounts:
        return FreshnessCounts(
            fresh=self.fresh, aging=self.aging, stale=self.items - self.fresh - self.aging
        )


def _now() -> datetime:
    return datetime.now(UTC)


async def _coverage(
    db: AsyncSession, sources: list[Source], now: datetime
) -> tuple[list[SourceCoverage], dict[uuid.UUID, _Tally]]:
    """Statements 2-4 of the list: the settings, the items and the uses."""
    settings = await confidence_settings(db)
    if not sources:
        return [], {}
    ids = [s.id for s in sources]
    kind_of = {s.id: s.kind for s in sources}
    tallies: dict[uuid.UUID, _Tally] = defaultdict(_Tally)
    rows = await db.execute(
        _item_stats([SourceItem.source_id], SourceItem.source_id.in_(ids), settings, now)
    )
    for row in rows.all():
        hl = half_life_days(settings, kind_of[row.source_id], row.item_kind)
        tallies[row.source_id].add(row, hl)

    u = _uses()
    used_rows = await db.execute(
        select(
            SourceItem.source_id,
            func.count().filter(u.c.kind == "evidence").label("evidence"),
            func.count().filter(u.c.kind == "citation").label("citations"),
            func.count().filter(u.c.kind == "section_link").label("section_links"),
            func.count(distinct(u.c.document_id)).label("documents"),
        )
        .select_from(u)
        .join(SourceItem, SourceItem.id == u.c.item_id)
        .where(SourceItem.source_id.in_(ids))
        .group_by(SourceItem.source_id)
    )
    used = {
        r.source_id: UsedCounts(
            evidence=r.evidence,
            citations=r.citations,
            section_links=r.section_links,
            documents=r.documents,
        )
        for r in used_rows.all()
    }
    out = []
    for s in sources:
        t = tallies[s.id]
        out.append(
            SourceCoverage(
                source_id=s.id,
                name=s.name,
                kind=s.kind,  # type: ignore[arg-type]
                status=s.status,  # type: ignore[arg-type]
                last_synced_at=s.last_synced_at,
                items=t.items,
                removed=t.removed,
                not_read=not_read(s.unavailable_items),
                newest_at=t.newest_at,
                oldest_at=t.oldest_at,
                freshness=t.freshness,
                used=used.get(s.id, UsedCounts()),
            )
        )
    return out, tallies


async def list_coverage(db: AsyncSession, user_id: uuid.UUID) -> CoverageList:
    """The coverage of every source of ``user_id``, by name: 4 statements (the sources,
    the confidence settings, the items, the uses) whatever the number of sources."""
    now = _now()
    sources = list(
        await db.scalars(
            select(Source).where(Source.owner_user_id == user_id).order_by(Source.name)
        )
    )
    out, _ = await _coverage(db, sources, now)
    return CoverageList(as_of=now, sources=out)


async def _used_in(db: AsyncSession, source_id: uuid.UUID, limit: int, offset: int) -> list[UsedIn]:
    """One page of the source's uses, newest first (by when the use was made)."""
    no_uuid, no_int, no_text = cast(null(), Uuid), cast(null(), Integer), cast(null(), Text)
    link_version = aliased(DocumentVersion, name="link_version")
    u = union_all(
        select(
            literal("evidence").label("kind"),
            Evidence.id.label("id"),
            Evidence.created_at.label("at"),
            Evidence.source_item_id.label("item_id"),
            func.coalesce(Evidence.entity_id, Edge.src_id).label("entity_id"),
            no_uuid.label("document_id"),
            no_uuid.label("version_id"),
            no_int.label("version"),
            no_text.label("cite_key"),
            no_text.label("section_key"),
        )
        .outerjoin(Edge, Edge.id == Evidence.edge_id)
        .where(Evidence.source_item_id.is_not(None)),
        select(
            literal("citation"),
            Citation.id,
            Citation.created_at,
            Citation.item_id,
            no_uuid,
            DocumentVersion.document_id,
            DocumentVersion.id,
            DocumentVersion.number,
            Citation.cite_key,
            no_text,
        )
        .join(DocumentVersion, DocumentVersion.id == Citation.version_id)
        .where(Citation.item_id.is_not(None)),
        select(
            literal("section_link"),
            DocumentSectionLink.id,
            DocumentSectionLink.created_at,
            DocumentSectionLink.source_item_id,
            no_uuid,
            DocumentSectionLink.document_id,
            DocumentSectionLink.version_id,
            link_version.number,
            no_text,
            DocumentSectionLink.section_key,
        )
        .outerjoin(link_version, link_version.id == DocumentSectionLink.version_id)
        .where(DocumentSectionLink.source_item_id.is_not(None)),
    ).subquery("u")
    rows = (
        await db.execute(
            select(u, SourceItem.title.label("item_title"))
            .join(SourceItem, SourceItem.id == u.c.item_id)
            .where(SourceItem.source_id == source_id)
            .order_by(u.c.at.desc(), u.c.id.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()
    entity_ids = {r.entity_id for r in rows if r.entity_id is not None}
    document_ids = {r.document_id for r in rows if r.document_id is not None}
    entities = (
        {e.id: e for e in await db.scalars(select(Entity).where(Entity.id.in_(entity_ids)))}
        if entity_ids
        else {}
    )
    documents = (
        {d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(document_ids)))}
        if document_ids
        else {}
    )
    linked = {(r.version_id, r.section_key) for r in rows if r.kind == "section_link"}
    headings: dict[tuple[uuid.UUID, str], str] = {}
    if any(v is not None for v, _ in linked):
        found = await db.execute(
            select(Section.version_id, Section.section_key, Section.heading).where(
                Section.version_id.in_({v for v, _ in linked if v is not None}),
                Section.section_key.in_({k for _, k in linked}),
            )
        )
        headings = {(r.version_id, r.section_key): r.heading for r in found.all()}

    out = []
    for r in rows:
        entity = entities.get(r.entity_id) if r.entity_id else None
        doc = documents.get(r.document_id) if r.document_id else None
        out.append(
            UsedIn(
                kind=r.kind,
                at=r.at,
                item=UsedItem(id=r.item_id, title=r.item_title),
                entity=UsedEntity(
                    id=entity.id,
                    type=entity.type,
                    key=entity.key,
                    title=entity.title,
                    status=entity.status,
                )
                if entity
                else None,
                document=UsedDocument(slug=doc.slug, title=doc.title, kind=doc.kind)
                if doc
                else None,
                version=r.version,
                cite_key=r.cite_key,
                section_key=r.section_key,
                section_title=headings.get((r.version_id, r.section_key))
                if r.kind == "section_link"
                else None,
            )
        )
    return out


async def source_coverage(
    db: AsyncSession, source: Source, *, limit: int = 50, offset: int = 0
) -> SourceCoverageDetail:
    """One source's coverage with its item kinds, every not-read entry and one page of
    its uses. ``source`` is one the caller owns (the router checks)."""
    now = _now()
    [summary], tallies = await _coverage(db, [source], now)
    used = summary.used
    return SourceCoverageDetail(
        **summary.model_dump(),
        by_kind=sorted(tallies[source.id].kinds, key=lambda k: (-k.items, k.kind)),
        not_read_items=not_read_items(source.unavailable_items),
        used_in=await _used_in(db, source.id, limit, offset),
        used_in_total=used.evidence + used.citations + used.section_links,
    )


async def company_coverage(db: AsyncSession) -> CompanyCoverage:
    """Owners' Company tab: per active member and source kind, counts only. 4 statements
    (the members, the sources per owner and kind, the confidence settings, the items per
    owner and kind) whatever the number of members and sources. No source id leaves the
    database layer: everything is grouped by owner and kind there."""
    now = _now()
    members = (
        await db.execute(
            select(User.id, User.email, User.role)
            .where(User.disabled_at.is_(None))
            .order_by(User.created_at, User.email)
        )
    ).all()
    per_kind = (
        await db.execute(
            select(
                Source.owner_user_id,
                Source.kind,
                func.count().label("sources"),
                func.max(Source.last_synced_at).label("last_synced_at"),
            ).group_by(Source.owner_user_id, Source.kind)
        )
    ).all()
    settings = await confidence_settings(db)
    active = {m.id for m in members}
    tallies: dict[tuple[uuid.UUID, str], _Tally] = defaultdict(_Tally)
    if per_kind:
        rows = await db.execute(
            _item_stats(
                [Source.owner_user_id, Source.kind.label("source_kind")],
                Source.owner_user_id.in_(active),
                settings,
                now,
            )
        )
        for row in rows.all():
            hl = half_life_days(settings, row.source_kind, row.item_kind)
            tallies[(row.owner_user_id, row.source_kind)].add(row, hl)

    kinds: dict[uuid.UUID, list[CompanyKindCoverage]] = defaultdict(list)
    for row in sorted(per_kind, key=lambda r: SOURCE_KINDS.index(r.kind)):
        if row.owner_user_id not in active:
            continue
        t = tallies[(row.owner_user_id, row.kind)]
        kinds[row.owner_user_id].append(
            CompanyKindCoverage(
                kind=row.kind,
                sources=row.sources,
                items=t.items,
                fresh_share=round(t.fresh / t.items, 3) if t.items else None,
                freshness=t.freshness,
                last_synced_at=row.last_synced_at,
            )
        )

    def order(m) -> tuple:
        mine = kinds.get(m.id, [])
        items = sum(k.items for k in mine)
        share = sum(k.freshness.fresh for k in mine) / items if items else -1.0
        # Setup first (no source), then the lowest fresh share.
        return (bool(mine), share, m.email)

    out = [
        CompanyMemberCoverage(
            member=CompanyMember(id=m.id, email=m.email, name=None, role=m.role),
            kinds=kinds.get(m.id, []),
        )
        for m in sorted(members, key=order)
    ]
    return CompanyCoverage(
        as_of=now,
        members_total=len(members),
        members_with_sources=sum(1 for m in members if kinds.get(m.id)),
        members=out,
    )
