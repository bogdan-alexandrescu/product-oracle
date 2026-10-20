"""The sync engine: runs a source's connector and stores what it yields.

Upserts and deletes are committed together with the cursor of each
:class:`~oracle.sources.base.CursorCheckpoint`, so an interrupted sync resumes from
the last checkpoint. Changes after the last checkpoint are committed only when the
connector finishes; on any failure they are rolled back and re-read next time.

Credentials are passed to the connector and nowhere else: never stored on the
source, logged, or echoed in ``last_error`` (connector messages are redacted).
"""

import logging
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.sources import base, service, store
from oracle.sources.models import Source

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
    # Items the connector could not read (base.ItemUnavailable), in the order reported.
    unavailable: list[dict[str, str]] = field(default_factory=list)


class SyncRefused(Exception):
    """The source cannot sync now (paused, an upload source)."""


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
        credential, conn = await service.credential_for(db, source)
    except service.InvalidError as e:
        return await _fail(db, source, stats, str(e))
    except service.NotFoundError:
        return await _fail(db, source, stats, "The connection was removed: pick another one")
    problem = service.scope_problem(source.kind, dict(source.config), conn)
    if problem:
        return await _fail(db, source, stats, problem)

    cursor = dict(source.cursor) if source.cursor else None
    try:
        async for event in connector.sync(dict(source.config), credential, cursor):
            if isinstance(event, base.ItemUpsert):
                _, written = await store.upsert_item(db, source, event)
                stats.upserted += 1
                stats.versions_written += int(written)
            elif isinstance(event, base.ItemDelete):
                stats.deleted += int(await store.delete_item(db, source, event))
            elif isinstance(event, base.ItemUnavailable):
                stats.unavailable.append(
                    {"external_id": event.external_id, "reason": event.reason[:300]}
                )
            elif isinstance(event, base.CursorCheckpoint):
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

    source.status = "active"
    source.last_error = None
    source.unavailable_items = list(stats.unavailable)
    source.last_synced_at = func.now()
    await db.commit()
    return stats
