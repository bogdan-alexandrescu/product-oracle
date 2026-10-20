"""Reading a user's items: current or pinned to a point in time, with confidence.

    rows = await items_as_of(session, user_id, snapshot.as_of)

A pinned read selects, per item, the newest version with ``fetched_at <= as_of``;
items deleted at or before ``as_of`` are left out, items deleted later are kept.
Confidence is computed on read (oracle.confidence), never stored on items.

Pin stability: a version is stamped when it is written, not when its transaction
commits. Given the snapshot's ``txn_snapshot``, a pinned read also leaves out every
version (and every deletion) whose transaction had not committed when the pin was
taken, so the pinned set never grows after the fact (``pinned_at``).
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    ColumnElement,
    Select,
    Text,
    and_,
    case,
    cast,
    func,
    literal,
    or_,
    select,
    true,
)
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import UserDefinedType

from oracle import confidence
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.tenant_settings import TenantSetting

CONFIDENCE_SETTING = "confidence_weights"


@dataclass(frozen=True)
class RunReads:
    """What a run reads of source items beyond its user's own current ones (S6, freeze
    at sharing). ``released``: SQL of (item_id, version_id), items it reads at that
    version only, whoever owns them and whatever ``as_of`` says. ``frozen``: SQL of
    item ids, every item a finding shared in full ever froze (deleted or withheld since
    included): never read as its user's own item, only through ``released``."""

    released: Select
    frozen: Select


@dataclass(frozen=True)
class ItemRow:
    item: SourceItem
    version: SourceItemVersion | None
    source_kind: str


class _Xid8(UserDefinedType):
    cache_ok = True

    def get_col_spec(self, **kw: Any) -> str:
        return "xid8"


class _PgSnapshot(UserDefinedType):
    cache_ok = True

    def get_col_spec(self, **kw: Any) -> str:
        return "pg_snapshot"


def current_xid() -> ColumnElement[int]:
    """The writing transaction's id, as stored in ``*_xid`` columns."""
    return cast(cast(func.pg_current_xact_id(), Text), BigInteger)


def committed_at_pin(xid: Any, txn_snapshot: str | None) -> ColumnElement[bool]:
    """True when the transaction ``xid`` had committed when the pin was taken.

    NULL xids (rows older than pin stability) count as committed; without a recorded
    transaction snapshot, only ``as_of`` decides."""
    if not txn_snapshot:
        return true()
    return or_(
        xid.is_(None),
        func.pg_visible_in_snapshot(
            cast(cast(xid, Text), _Xid8()), cast(literal(txn_snapshot, Text), _PgSnapshot())
        ),
    )


def version_at_pin(as_of: datetime, txn_snapshot: str | None = None) -> ColumnElement[bool]:
    """The version had been written and committed when the pin was taken."""
    return and_(
        SourceItemVersion.fetched_at <= as_of,
        committed_at_pin(SourceItemVersion.xid, txn_snapshot),
    )


def deleted_at_pin(as_of: datetime, txn_snapshot: str | None = None) -> ColumnElement[bool]:
    """The item's deletion had been committed when the pin was taken."""
    return and_(
        SourceItem.deleted_at.is_not(None),
        SourceItem.deleted_at <= as_of,
        committed_at_pin(SourceItem.deleted_xid, txn_snapshot),
    )


def version_ids(
    user_id: uuid.UUID,
    as_of: datetime | None = None,
    txn_snapshot: str | None = None,
    also: RunReads | None = None,
) -> Select:
    """Ids of the versions a read sees: current ones, or the pinned ones at ``as_of``
    (and, given the pin's ``txn_snapshot``, committed when it was taken). ``also``: a
    run's reads (S6): its user's own items ever frozen by sharing are read only at the
    version released (none, once deleted or withheld), other users' released items at
    that version too, and nothing deleted upstream, whatever ``as_of`` says."""
    owned = SourceItem.source_id.in_(select(Source.id).where(Source.owner_user_id == user_id))
    released = also.released.subquery() if also is not None else None
    if also is not None:
        owned = and_(owned, SourceItem.id.not_in(also.frozen), SourceItem.deleted_at.is_(None))
    if as_of is None:
        mine = select(SourceItem.current_version_id.label("id")).where(
            owned,
            SourceItem.deleted_at.is_(None),
            SourceItem.current_version_id.is_not(None),
        )
    else:
        mine = (
            select(SourceItemVersion.id)
            .join(SourceItem, SourceItem.id == SourceItemVersion.item_id)
            .where(
                owned,
                version_at_pin(as_of, txn_snapshot),
                ~deleted_at_pin(as_of, txn_snapshot),
            )
            .ext(distinct_on(SourceItemVersion.item_id))
            .order_by(SourceItemVersion.item_id, SourceItemVersion.fetched_at.desc())
        )
    if released is None:
        return mine
    pinned = mine.subquery()
    return select(pinned.c.id).union(select(released.c.version_id.label("id")))


async def items_as_of(
    session: AsyncSession,
    user_id: uuid.UUID,
    as_of: datetime,
    *,
    source_id: uuid.UUID | None = None,
    txn_snapshot: str | None = None,
    also: RunReads | None = None,
) -> list[ItemRow]:
    """The user's items as they were at ``as_of`` (one row per item, its pinned version).
    ``also``: a run's reads (``version_ids``): its user's items ever frozen at the
    version released only, and none deleted upstream."""
    pinned = version_ids(user_id, as_of, txn_snapshot, also).subquery()
    stmt = (
        select(SourceItem, SourceItemVersion, Source.kind)
        .join(SourceItemVersion, SourceItemVersion.item_id == SourceItem.id)
        .join(Source, Source.id == SourceItem.source_id)
        .where(SourceItemVersion.id.in_(select(pinned.c.id)))
        .order_by(SourceItem.created_at, SourceItem.id)
    )
    if source_id is not None:
        stmt = stmt.where(SourceItem.source_id == source_id)
    if also is not None:
        # The user's own items only: other users' released items are not theirs to list.
        stmt = stmt.where(Source.owner_user_id == user_id)
    rows = await session.execute(stmt)
    return [ItemRow(item, version, kind) for item, version, kind in rows.all()]


async def as_released(
    session: AsyncSession, rows: list[ItemRow], also: RunReads | None
) -> list[ItemRow]:
    """``rows`` as a run reads them (S6, freeze at sharing; titles, owner 2026-10-19):
    an item ever frozen at the version released (its title and text as shared), or
    left out if none is readable now; nothing deleted upstream. ``also`` None: as is."""
    if also is None or not rows:
        return rows
    ids = [r.item.id for r in rows]
    frozen_col = also.frozen.selected_columns[0]
    frozen = set((await session.scalars(also.frozen.where(frozen_col.in_(ids)))).all())
    released = also.released.subquery()
    pairs = dict(
        (
            await session.execute(
                select(released.c.item_id, released.c.version_id).where(
                    released.c.item_id.in_(frozen)
                )
            )
        ).all()
    )
    versions = {
        v.id: v
        for v in await session.scalars(
            select(SourceItemVersion).where(SourceItemVersion.id.in_(set(pairs.values())))
        )
    }
    out = []
    for row in rows:
        if row.item.deleted_at is not None:
            continue
        if row.item.id in frozen:
            version = versions.get(pairs.get(row.item.id))  # type: ignore[arg-type]
            if version is None:
                continue
            row = ItemRow(row.item, version, row.source_kind)
        out.append(row)
    return out


async def source_items(
    session: AsyncSession,
    source: Source,
    *,
    include_deleted: bool = False,
    ids: list[uuid.UUID] | None = None,
    limit: int = 100,
    offset: int = 0,
    exclude: set[uuid.UUID] | None = None,
    also: RunReads | None = None,
) -> list[ItemRow]:
    """A source's items (or those of ``ids``) with their current versions, newest first.
    ``exclude``: items the caller may not read (left out before paging). ``also``: a
    run's reads (S6, as ``as_released``, before paging): an item ever frozen at the
    version released and ordered by it, or left out if none is readable now; nothing
    deleted upstream."""
    newest = func.coalesce(
        SourceItem.source_updated_at, SourceItem.occurred_at, SourceItem.created_at
    )
    if also is None:
        stmt = select(SourceItem, SourceItemVersion).outerjoin(
            SourceItemVersion, SourceItemVersion.id == SourceItem.current_version_id
        )
    else:
        released = also.released.subquery()
        frozen = SourceItem.id.in_(also.frozen)
        stmt = (
            select(SourceItem, SourceItemVersion)
            .outerjoin(released, released.c.item_id == SourceItem.id)
            .outerjoin(
                SourceItemVersion,
                SourceItemVersion.id
                == case((frozen, released.c.version_id), else_=SourceItem.current_version_id),
            )
            .where(
                or_(~frozen, released.c.version_id.is_not(None)),
                SourceItem.deleted_at.is_(None),
            )
        )
        # A frozen item sorts by the version released, never by a change upstream since.
        newest = case((frozen, SourceItemVersion.fetched_at), else_=newest)
    stmt = (
        stmt.where(SourceItem.source_id == source.id)
        .order_by(newest.desc(), SourceItem.id)
        .limit(limit)
        .offset(offset)
    )
    if not include_deleted:
        stmt = stmt.where(SourceItem.deleted_at.is_(None))
    if ids is not None:
        stmt = stmt.where(SourceItem.id.in_(ids))
    if exclude:
        stmt = stmt.where(SourceItem.id.not_in(exclude))
    rows = await session.execute(stmt)
    return [ItemRow(item, version, source.kind) for item, version in rows.all()]


async def owned_item(
    session: AsyncSession, user_id: uuid.UUID, item_id: uuid.UUID
) -> ItemRow | None:
    row = (
        await session.execute(
            select(SourceItem, SourceItemVersion, Source.kind)
            .join(Source, and_(Source.id == SourceItem.source_id, Source.owner_user_id == user_id))
            .outerjoin(SourceItemVersion, SourceItemVersion.id == SourceItem.current_version_id)
            .where(SourceItem.id == item_id)
        )
    ).first()
    return ItemRow(row[0], row[1], row[2]) if row else None


async def item_row(
    session: AsyncSession, item_id: uuid.UUID, version_id: uuid.UUID | None = None
) -> ItemRow | None:
    """An item with its current version (or ``version_id``), whoever owns it: only for
    a read already allowed (a run reading an item a finding shared in full released, at
    the version released, S6). An item deleted upstream is gone."""
    version = SourceItemVersion.id == (
        version_id if version_id is not None else SourceItem.current_version_id
    )
    row = (
        await session.execute(
            select(SourceItem, SourceItemVersion, Source.kind)
            .join(Source, Source.id == SourceItem.source_id)
            .outerjoin(SourceItemVersion, and_(version, SourceItemVersion.item_id == SourceItem.id))
            .where(SourceItem.id == item_id, SourceItem.deleted_at.is_(None))
        )
    ).first()
    return ItemRow(row[0], row[1], row[2]) if row else None


async def confidence_settings(session: AsyncSession) -> dict[str, Any] | None:
    """The company's ``confidence_weights`` overrides, if any."""
    value = await session.scalar(
        select(TenantSetting.value).where(TenantSetting.key == CONFIDENCE_SETTING)
    )
    return value if isinstance(value, dict) else None


def is_planning_doc(item: SourceItem) -> bool:
    acl = item.acl or {}
    attrs = acl.get("attrs") if isinstance(acl.get("attrs"), dict) else {}
    return "planning" in (acl.get("doc_type"), attrs.get("doc_type"))


def item_confidence(
    row: ItemRow,
    settings: dict[str, Any] | None,
    now: datetime | None = None,
    *,
    released: bool = False,
) -> confidence.Score:
    """``released``: another user's item read at the version a share released (S6):
    fresh as that version, never as the item changed upstream since."""
    item = row.item
    stamps = [t for t in (item.source_updated_at, item.occurred_at) if t is not None]
    if released and row.version is not None:
        stamps = [row.version.fetched_at]
    if not stamps and row.version is not None:
        stamps = [row.version.fetched_at]
    factors = confidence.Factors(
        source_kind=row.source_kind,
        item_kind=item.kind,
        latest_at=max(stamps) if stamps else None,
        planning_doc=is_planning_doc(item),
    )
    return confidence.score(factors, settings, now=now)


def confidence_out(score: confidence.Score, settings: dict[str, Any] | None) -> dict[str, Any]:
    low = float(confidence.merged(settings)["low"])
    return {"value": score.confidence, "breakdown": score.breakdown, "low": score.confidence < low}


# The acl fields another user's released item keeps: none names who is on it or what
# the channel, repository or page is called now (names change after sharing, S6).
FOREIGN_ACL = ("visibility", "is_private", "doc_type")


def _scalar_acl(acl: dict[str, Any]) -> dict[str, Any]:
    """The acl without who is on it or current names: only ``FOREIGN_ACL`` scalars."""
    return {
        k: v for k, v in acl.items() if k in FOREIGN_ACL and isinstance(v, str | bool | int | float)
    }


def item_out(
    row: ItemRow,
    settings: dict[str, Any] | None,
    now: datetime | None = None,
    *,
    foreign: bool = False,
) -> dict[str, Any]:
    """``foreign``: another user's item a finding shared in full released to the caller
    (a run, S6): who wrote it, who it is shared with and when it changed upstream are
    left out (the title, link and text it reads are the ones released, S6)."""
    item, version = row.item, row.version
    out = {
        "id": item.id,
        "source_id": item.source_id,
        "source_kind": row.source_kind,
        "external_id": item.external_id,
        "kind": item.kind,
        # A pinned read shows the title as it was then.
        "title": version.title if version is not None else item.title,
        # The link as it was then too (S6, links): a Notion link carries the title.
        "url": version.url if version is not None else item.url,
        "author": item.author,
        "acl": item.acl or {},
        "occurred_at": item.occurred_at,
        "source_updated_at": item.source_updated_at,
        "deleted_at": item.deleted_at,
        "version_id": version.id if version is not None else None,
        "fetched_at": version.fetched_at if version is not None else None,
        "confidence": confidence_out(
            item_confidence(row, settings, now, released=foreign), settings
        ),
    }
    if foreign:
        out.update(author=None, acl=_scalar_acl(item.acl or {}), source_updated_at=None)
    return out
