"""Writing items and their versions: shared by the sync engine and uploads."""

import hashlib
import uuid
from collections.abc import Callable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.sources.base import ItemDelete, ItemUpsert, StoredItem
from oracle.sources.models import Source, SourceItem, SourceItemVersion


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


async def _item(db: AsyncSession, source: Source, external_id: str) -> SourceItem | None:
    return await db.scalar(
        select(SourceItem).where(
            SourceItem.source_id == source.id, SourceItem.external_id == external_id
        )
    )


async def upsert_item(
    db: AsyncSession, source: Source, event: ItemUpsert
) -> tuple[SourceItem, bool]:
    """Create or update an item; returns it and whether a new version was written.

    A version is written only when the content hash differs from the current one; it
    copies the item's title at that moment.
    """
    item = await _item(db, source, event.external_id)
    if item is None:
        item = SourceItem(id=uuid.uuid4(), source_id=source.id, external_id=event.external_id)
        db.add(item)
    item.kind = event.kind
    item.title = event.title
    item.url = event.url
    item.author = event.author
    item.acl = dict(event.acl)
    item.occurred_at = event.occurred_at
    item.source_updated_at = event.source_updated_at
    item.deleted_at = None
    # The item row must exist before a version can point at it.
    await db.flush()

    digest = content_hash(event.content)
    if item.current_version_id is not None:
        current = await db.scalar(
            select(SourceItemVersion.content_hash).where(
                SourceItemVersion.id == item.current_version_id
            )
        )
        if current == digest:
            return item, False

    version = SourceItemVersion(
        id=uuid.uuid4(),
        item_id=item.id,
        title=event.title,
        content=event.content,
        content_hash=digest,
        # Wall-clock time, not the transaction start: a long sync commits in steps and
        # pinned reads compare versions against snapshot times.
        fetched_at=func.clock_timestamp(),
    )
    db.add(version)
    await db.flush()
    item.current_version_id = version.id
    await db.flush()
    return item, True


async def delete_item(db: AsyncSession, source: Source, event: ItemDelete) -> bool:
    """Mark an item deleted (its versions stay for pinned reads). False if unknown."""
    item = await _item(db, source, event.external_id)
    if item is None or item.deleted_at is not None:
        return False
    item.deleted_at = func.clock_timestamp()
    await db.flush()
    return True


async def delete_out_of_scope(
    db: AsyncSession, source: Source, in_scope: Callable[[StoredItem], bool]
) -> int:
    """Mark deleted every live item ``in_scope`` rejects; returns how many."""
    rows = await db.scalars(
        select(SourceItem).where(SourceItem.source_id == source.id, SourceItem.deleted_at.is_(None))
    )
    gone = 0
    for item in rows.all():
        stored = StoredItem(
            external_id=item.external_id,
            kind=item.kind,
            occurred_at=item.occurred_at,
            acl=dict(item.acl or {}),
        )
        if not in_scope(stored):
            item.deleted_at = func.clock_timestamp()
            gone += 1
    await db.flush()
    return gone
