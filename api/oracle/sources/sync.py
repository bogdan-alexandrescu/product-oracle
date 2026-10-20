"""The sync engine: runs a source's connector and stores what it yields.

Upserts and deletes are committed together with the cursor of each
:class:`~oracle.sources.base.CursorCheckpoint`, so an interrupted sync resumes from
the last checkpoint. Changes after the last checkpoint are committed only when the
connector finishes; on any failure they are rolled back and re-read next time.

Every cursor save is conditional on the source still having the config and connection
the sync started with. A source edited while its sync runs (a channel removed, say)
keeps none of what that sync read after the edit: the save matches no row, the
transaction is rolled back and the sync ends ``superseded``.

The saved cursor carries a fingerprint of the selection (config and connection) under
:data:`~oracle.sources.base.SCOPE_KEY`. When it is missing or differs, the selection
changed since the last sync: the items now outside it are deleted (soft) and the cursor
is rescoped (``rescope_cursor``), committed at once, before the connector runs, so a
rate limit or failure later in the sync cannot roll the sweep back.

Credentials are passed to the connector and nowhere else: never stored on the
source, logged, or echoed in ``last_error`` (connector messages are redacted).
"""

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import cast, func, update
from sqlalchemy.dialects.postgresql import JSONB
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


class SyncRefused(Exception):
    """The source cannot sync now (paused, an upload source)."""


class _Superseded(Exception):
    """The source was edited while it synced: its config or connection changed."""


def fingerprint(config: dict[str, Any], connection_id: uuid.UUID | None) -> str:
    """What identifies a selection: the config and the connection it is read through."""
    raw = json.dumps(
        {"config": config, "connection": str(connection_id) if connection_id else None},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode()).hexdigest()


async def _save_cursor(
    db: AsyncSession,
    source: Source,
    cursor: dict[str, Any],
    config: dict[str, Any],
    connection_id: uuid.UUID | None,
) -> None:
    """Save ``cursor`` (with what was stored since the last save) only if the source
    still has the config and connection the sync started with; otherwise roll back."""
    result = await db.execute(
        update(Source)
        .where(
            Source.id == source.id,
            Source.config == cast(config, JSONB),
            Source.connection_id.is_not_distinct_from(connection_id),
        )
        .values(cursor=cursor)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await db.rollback()
        raise _Superseded


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
    attention = _needs_attention(connector, dict(source.config))
    if attention is not None:
        # Saved before a rule it now breaks: wait for the owner to edit it, without
        # calling the provider (and without failing every sync as an error).
        source.status = "needs_attention"
        source.last_error = attention
        await db.commit()
        stats.outcome = "needs_attention"
        stats.error = attention
        return stats
    try:
        credential, _ = await service.credential_for(db, source)
    except service.InvalidError as e:
        return await _fail(db, source, stats, str(e))
    except service.NotFoundError:
        return await _fail(db, source, stats, "The connection was removed: pick another one")

    config = dict(source.config)
    connection_id = source.connection_id
    scope_fp = fingerprint(config, connection_id)
    saved = dict(source.cursor) if source.cursor else {}
    cursor: dict[str, Any] | None = {k: v for k, v in saved.items() if k != base.SCOPE_KEY}

    def stamped(position: dict[str, Any] | None) -> dict[str, Any]:
        return {**(position or {}), base.SCOPE_KEY: scope_fp}

    try:
        if saved.get(base.SCOPE_KEY) != scope_fp:
            # The selection changed since the last sync (or was never fingerprinted):
            # drop what it no longer covers and rescope the cursor, committed now.
            scope = getattr(connector, "scope", None)
            if scope is not None:
                stats.deleted += await store.delete_out_of_scope(db, source, scope(config))
            rescope = getattr(connector, "rescope_cursor", None)
            cursor = rescope(cursor or None, config) if rescope is not None else None
            await _save_cursor(db, source, stamped(cursor), config, connection_id)
            await db.commit()
        async for event in connector.sync(config, credential, cursor or None):
            if isinstance(event, base.ItemUpsert):
                _, written = await store.upsert_item(db, source, event)
                stats.upserted += 1
                stats.versions_written += int(written)
            elif isinstance(event, base.ItemDelete):
                stats.deleted += int(await store.delete_item(db, source, event))
            elif isinstance(event, base.CursorCheckpoint):
                cursor = dict(event.cursor)
                await _save_cursor(db, source, stamped(cursor), config, connection_id)
                await db.commit()
                stats.checkpoints += 1
            else:
                raise TypeError(f"unexpected sync event {type(event).__name__}")
        # The end: what came after the last checkpoint, under the same condition.
        await _save_cursor(db, source, stamped(cursor), config, connection_id)
    except _Superseded:
        stats.outcome = "superseded"
        return stats
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
    source.last_synced_at = func.now()
    await db.commit()
    return stats


def _needs_attention(connector: base.Connector, config: dict[str, Any]) -> str | None:
    """Why a saved config can no longer be synced as it is, or ``None``."""
    check = getattr(connector, "check_config", None)
    if check is None:
        return None
    try:
        check(config)
    except base.ConnectorConfigError as e:
        message = str(e)
        return f"{message[:1].upper()}{message[1:]}: edit this source to sync it again"
    return None
