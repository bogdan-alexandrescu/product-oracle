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
    also: Select | None = None,
) -> Select:
    """Ids of the versions a read sees: current ones, or the pinned ones at ``as_of``
    (and, given the pin's ``txn_snapshot``, committed when it was taken). ``also``:
    SQL of (item_id, version_id), items a run reads at that version only (S6, freeze at
    sharing): other users' items it may read too, and its user's own items a finding
    shared in full released, whatever ``as_of`` says."""
    owned = SourceItem.source_id.in_(select(Source.id).where(Source.owner_user_id == user_id))
    released = also.subquery() if also is not None else None
    if released is not None:
        owned = and_(owned, SourceItem.id.not_in(select(released.c.item_id)))
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
) -> list[ItemRow]:
    """The user's items as they were at ``as_of`` (one row per item, its pinned version)."""
    pinned = version_ids(user_id, as_of, txn_snapshot).subquery()
    stmt = (
        select(SourceItem, SourceItemVersion, Source.kind)
        .join(SourceItemVersion, SourceItemVersion.item_id == SourceItem.id)
        .join(Source, Source.id == SourceItem.source_id)
        .where(SourceItemVersion.id.in_(select(pinned.c.id)))
        .order_by(SourceItem.created_at, SourceItem.id)
    )
    if source_id is not None:
        stmt = stmt.where(SourceItem.source_id == source_id)
    rows = await session.execute(stmt)
    return [ItemRow(item, version, kind) for item, version, kind in rows.all()]


async def source_items(
    session: AsyncSession,
    source: Source,
    *,
    include_deleted: bool = False,
    ids: list[uuid.UUID] | None = None,
    limit: int = 100,
    offset: int = 0,
    exclude: set[uuid.UUID] | None = None,
) -> list[ItemRow]:
    """A source's items (or those of ``ids``) with their current versions, newest first.
    ``exclude``: items the caller may not read (left out before paging)."""
    stmt = (
        select(SourceItem, SourceItemVersion)
        .outerjoin(SourceItemVersion, SourceItemVersion.id == SourceItem.current_version_id)
        .where(SourceItem.source_id == source.id)
        .order_by(
            func.coalesce(
                SourceItem.source_updated_at, SourceItem.occurred_at, SourceItem.created_at
            ).desc(),
            SourceItem.id,
        )
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
    row: ItemRow, settings: dict[str, Any] | None, now: datetime | None = None
) -> confidence.Score:
    item = row.item
    stamps = [t for t in (item.source_updated_at, item.occurred_at) if t is not None]
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


def item_out(
    row: ItemRow, settings: dict[str, Any] | None, now: datetime | None = None
) -> dict[str, Any]:
    item, version = row.item, row.version
    return {
        "id": item.id,
        "source_id": item.source_id,
        "source_kind": row.source_kind,
        "external_id": item.external_id,
        "kind": item.kind,
        # A pinned read shows the title as it was then.
        "title": version.title if version is not None else item.title,
        "url": item.url,
        "author": item.author,
        "acl": item.acl or {},
        "occurred_at": item.occurred_at,
        "source_updated_at": item.source_updated_at,
        "deleted_at": item.deleted_at,
        "version_id": version.id if version is not None else None,
        "fetched_at": version.fetched_at if version is not None else None,
        "confidence": confidence_out(item_confidence(row, settings, now), settings),
    }
