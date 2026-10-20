"""The sync engine: runs a source's connector and stores what it yields.

Upserts and deletes are committed together with the cursor of each
:class:`~oracle.sources.base.CursorCheckpoint`, so an interrupted sync resumes from
the last checkpoint. Changes after the last checkpoint are committed only when the
connector finishes; on any failure they are rolled back and re-read next time.

A cursor belongs to the config and connection the sync started with. Changing either
resets the cursor (oracle.sources.service.update_source) while a sync may still be
running; that sync then saves nothing more: each checkpoint, and the end, first compare
the source's (config, connection) fingerprint, read with the row locked, to the one it
started with. The next sync starts over (a full pass) under the new selection.

Credentials are passed to the connector and nowhere else: never stored on the
source, logged, or echoed in ``last_error`` (connector messages are redacted).
"""

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.connections.models import Connection
from oracle.sources import base, service, store
from oracle.sources.models import Source, SourceItem

log = logging.getLogger(__name__)


@dataclass
class SyncStats:
    outcome: str = "completed"
    upserted: int = 0
    versions_written: int = 0
    deleted: int = 0
    checkpoints: int = 0
    retry_after: float | None = None
    error: str | None = None


class SyncRefused(Exception):
    """The source cannot sync now (paused, an upload source)."""


async def scope_fingerprint(
    db: AsyncSession, source_id: uuid.UUID, *, lock: bool = False
) -> str | None:
    """What a source's cursor depends on: its config and its connection (the row and the
    account it signs in to). None when the source is gone. ``lock`` holds the source row
    until the transaction ends, so the config cannot change before the cursor is saved."""
    query = (
        select(Source.config, Source.connection_id, Connection.account_id)
        .outerjoin(Connection, Connection.id == Source.connection_id)
        .where(Source.id == source_id)
    )
    if lock:
        query = query.with_for_update(of=Source)
    row = (await db.execute(query)).one_or_none()
    if row is None:
        return None
    config, connection_id, account_id = row
    scope = [config, str(connection_id) if connection_id else None, account_id]
    return hashlib.sha256(json.dumps(scope, sort_keys=True).encode()).hexdigest()


async def _superseded(db: AsyncSession, source_id: uuid.UUID, started: str | None) -> bool:
    """Whether the source's config or connection changed since the sync started; when
    it did not, the source row stays locked until the caller commits."""
    return await scope_fingerprint(db, source_id, lock=True) != started


async def _drop(db: AsyncSession, stats: SyncStats) -> SyncStats:
    """The source changed under the sync: keep nothing since its last checkpoint."""
    await db.rollback()
    stats.outcome = "superseded"
    return stats


async def _fail(db: AsyncSession, source: Source, stats: SyncStats, message: str) -> SyncStats:
    await db.rollback()
    source.status = "error"
    source.last_error = message
    await db.commit()
    stats.outcome = "error"
    stats.error = message
    return stats


async def sync_source(db: AsyncSession, source: Source) -> SyncStats:
    """Sync one source the caller has already checked the user owns."""
    stats = await _sync(db, source)
    # A rollback expires the source; load it again for the caller.
    await db.refresh(source)
    return stats


async def _sync(db: AsyncSession, source: Source) -> SyncStats:
    kind = source.kind
    if source.kind == "upload":
        raise SyncRefused("Upload sources have nothing to sync: upload files instead")
    if source.status == "paused":
        raise SyncRefused("This source is paused: resume it first")
    connector = service.connector_for(source.kind)
    if connector is None:
        raise service.InvalidError(service.CONNECTOR_UNAVAILABLE)

    stats = SyncStats()
    try:
        credential, _ = await service.credential_for(db, source)
    except service.InvalidError as e:
        return await _fail(db, source, stats, str(e))
    except service.NotFoundError:
        return await _fail(db, source, stats, "The connection was removed: pick another one")

    source_id = source.id
    started = await scope_fingerprint(db, source_id)
    cursor = dict(source.cursor) if source.cursor else None
    extra: dict[str, Any] = {}
    if getattr(connector, "prunes", False):

        async def known() -> set[str]:
            rows = await db.scalars(
                select(SourceItem.external_id).where(
                    SourceItem.source_id == source.id, SourceItem.deleted_at.is_(None)
                )
            )
            return set(rows)

        extra["known"] = known
    try:
        async for event in connector.sync(dict(source.config), credential, cursor, **extra):
            if isinstance(event, base.ItemUpsert):
                _, written = await store.upsert_item(db, source, event)
                stats.upserted += 1
                stats.versions_written += int(written)
            elif isinstance(event, base.ItemDelete):
                stats.deleted += int(await store.delete_item(db, source, event))
            elif isinstance(event, base.CursorCheckpoint):
                if await _superseded(db, source_id, started):
                    return await _drop(db, stats)
                source.cursor = dict(event.cursor)
                await db.commit()
                stats.checkpoints += 1
            else:
                raise TypeError(f"unexpected sync event {type(event).__name__}")
    except base.ConnectorRateLimited as e:
        # Stop cleanly: keep everything up to the last checkpoint and its cursor.
        await db.rollback()
        stats.outcome = "rate_limited"
        stats.retry_after = e.retry_after
        wait = f" (retry after {e.retry_after:g}s)" if e.retry_after is not None else ""
        source.last_error = f"Rate limited by {kind}; the next sync resumes{wait}"
        await db.commit()
        return stats
    except base.ConnectorAuthError as e:
        detail = service.redact(str(e), credential) or "credential rejected"
        stats = await _fail(db, source, stats, f"The connection was rejected: {detail}")
        await service.mark_connection_rejected(db, source, f"Rejected during a sync: {detail}")
        return stats
    except base.ConnectorError as e:
        return await _fail(db, source, stats, service.redact(str(e), credential))
    except Exception as e:  # noqa: BLE001 - recorded on the source, never re-raised
        # The type only: a message could carry provider responses or secrets.
        log.error("sync of a %s source failed: %s", kind, type(e).__name__)
        return await _fail(db, source, stats, f"Sync failed unexpectedly ({type(e).__name__})")

    if await _superseded(db, source_id, started):
        return await _drop(db, stats)
    source.status = "active"
    source.last_error = None
    source.last_synced_at = func.now()
    await db.commit()
    return stats
