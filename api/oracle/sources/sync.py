"""The sync engine: runs a source's connector and stores what it yields.

Upserts and deletes are committed together with the cursor of each
:class:`~oracle.sources.base.CursorCheckpoint`, so an interrupted sync resumes from
the last checkpoint. Changes after the last checkpoint are committed only when the
connector finishes; on any failure they are rolled back and re-read next time.

A sync runs what the database holds when it starts (config, connection, the account that
connection signs in to, cursor and status, read in one select), not the caller's copy of
the row. Every write it makes on the source (each cursor save, the end, an error, a rate
limit, needing attention) is one conditional UPDATE: it matches only while the source
still has the config, connection and account the sync started with. A source edited
while its sync runs (a channel removed, a new connection) keeps none of what that sync
read after the edit: the write matches no row, the transaction is rolled back and the
sync ends ``superseded``.

The saved cursor carries a fingerprint of the selection (normalised config, connection,
account) under :data:`~oracle.sources.base.SCOPE_KEY`. When it is missing or differs, the
selection changed since the last sync: the items now outside it are deleted (soft) and
the cursor is rescoped (``rescope_cursor``), committed at once, before the connector
runs, so a rate limit or failure later in the sync cannot roll the sweep back.

A forbidden request (:class:`~oracle.sources.base.ConnectorForbidden`) fails the source
and leaves the connection active; only a rejected credential (a 401, a revoked key)
marks the connection the sync used expired.

Credentials are passed to the connector and nowhere else: never stored on the
source, logged, or echoed in ``last_error`` (connector messages are redacted).
"""

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import case, cast, func, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.connections.models import Connection
from oracle.sources import base, service, store
from oracle.sources.models import Source, SourceItem

log = logging.getLogger(__name__)

Outcome = Literal["completed", "rate_limited", "error", "superseded", "needs_attention"]


@dataclass
class SyncStats:
    outcome: Outcome = "completed"
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


def fingerprint(
    config: dict[str, Any], connection_id: uuid.UUID | None, account_id: str | None = None
) -> str:
    """What identifies a selection: the config, the connection it is read through and
    the account that connection signs in to."""
    raw = json.dumps(
        {
            "config": config,
            "connection": str(connection_id) if connection_id else None,
            "account": account_id,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode()).hexdigest()


@dataclass(frozen=True)
class _Start:
    """The source as the sync runs it, read from the database when it starts (not the
    caller's copy of the row, which may predate an edit: sessions do not expire objects
    on commit)."""

    source_id: uuid.UUID
    config: dict[str, Any]
    connection_id: uuid.UUID | None
    account_id: str | None
    cursor: dict[str, Any] | None
    status: str


async def _start(db: AsyncSession, source_id: uuid.UUID) -> _Start | None:
    """One select of what the sync uses: config, connection, its account, cursor, status."""
    row = (
        await db.execute(
            select(
                Source.config,
                Source.connection_id,
                Connection.account_id,
                Source.cursor,
                Source.status,
            )
            .outerjoin(Connection, Connection.id == Source.connection_id)
            .where(Source.id == source_id)
        )
    ).one_or_none()
    if row is None:
        return None
    config, connection_id, account_id, cursor, status = row
    return _Start(
        source_id,
        dict(config or {}),
        connection_id,
        account_id,
        dict(cursor) if cursor else None,
        status,
    )


async def _write(db: AsyncSession, start: _Start, **values: Any) -> None:
    """Write ``values`` on the source (with what was stored since the last write) only if
    it still has the config, connection and account the sync started with; otherwise
    roll back and raise :class:`_Superseded`. The UPDATE locks the row, so a status it
    reads (a pause) is the one it writes over."""
    account = (
        select(Connection.account_id)
        .where(Connection.id == Source.connection_id)
        .scalar_subquery()
    )
    result = await db.execute(
        update(Source)
        .where(
            Source.id == start.source_id,
            Source.config == cast(start.config, JSONB),
            Source.connection_id.is_not_distinct_from(start.connection_id),
            account.is_not_distinct_from(start.account_id),
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await db.rollback()
        raise _Superseded


def _status(status: str) -> Any:
    """``status``, unless the source was paused meanwhile: a pause stays."""
    return case((Source.status == "paused", "paused"), else_=status)


async def _failed(
    db: AsyncSession, start: _Start, stats: SyncStats, message: str, status: str = "error"
) -> SyncStats:
    """A sync that failed: nothing since the last checkpoint is kept, and the error goes on
    the source unless the source changed meanwhile (it is then another selection's)."""
    await db.rollback()
    try:
        await _write(db, start, status=_status(status), last_error=message)
    except _Superseded:
        stats.outcome = "superseded"
        return stats
    await db.commit()
    stats.outcome = "error" if status == "error" else "needs_attention"
    stats.error = message
    return stats


async def sync_source(db: AsyncSession, source: Source) -> SyncStats:
    """Sync one source the caller has already checked the user owns."""
    stats = await _sync(db, source)
    # A rollback expires the source, and the engine writes with UPDATEs: load it again.
    await db.refresh(source)
    return stats


async def _sync(db: AsyncSession, source: Source) -> SyncStats:
    kind = source.kind
    source_id = source.id
    owner_id = source.owner_user_id
    if source.kind == "upload":
        raise SyncRefused("Upload sources have nothing to sync: upload files instead")
    connector = service.connector_for(source.kind)
    if connector is None:
        raise service.InvalidError(service.CONNECTOR_UNAVAILABLE)

    stats = SyncStats()
    start = await _start(db, source_id)
    if start is None:
        raise service.NotFoundError("Source not found")
    if start.status == "paused":
        raise SyncRefused("This source is paused: resume it first")
    # The caller loaded the source before another request changed its config or
    # connection: the sync it asked for is of a selection that no longer exists. Nothing
    # runs; the next sync reads the new one.
    if start.config != dict(source.config or {}) or start.connection_id != source.connection_id:
        await db.rollback()
        stats.outcome = "superseded"
        return stats
    config = start.config

    attention = _needs_attention(connector, config)
    if attention is not None:
        # Saved before a rule it now breaks: wait for the owner to edit it, without
        # calling the provider (and without failing every sync as an error).
        return await _failed(db, start, stats, attention, "needs_attention")
    try:
        credential, used = await service.credential_for(db, source, start.connection_id)
    except service.InvalidError as e:
        return await _failed(db, start, stats, str(e))
    except service.NotFoundError:
        return await _failed(db, start, stats, "The connection was removed: pick another one")
    # The connection the credential is of: an auth error marks this one, whatever the
    # source points at by then.
    used_id = used.id if used is not None else None

    scope_fp = fingerprint(service.normalize_config(kind, config), start.connection_id, start.account_id)
    saved = start.cursor or {}
    cursor: dict[str, Any] | None = {k: v for k, v in saved.items() if k != base.SCOPE_KEY}

    def stamped(position: dict[str, Any] | None) -> dict[str, Any]:
        return {**(position or {}), base.SCOPE_KEY: scope_fp}

    extra: dict[str, Any] = {}
    if getattr(connector, "prunes", False):

        async def known() -> set[str]:
            rows = await db.scalars(
                select(SourceItem.external_id).where(
                    SourceItem.source_id == source_id, SourceItem.deleted_at.is_(None)
                )
            )
            return set(rows)

        extra["known"] = known

    attentions: list[str] = []
    try:
        if saved.get(base.SCOPE_KEY) != scope_fp:
            # The selection changed since the last sync (or was never fingerprinted):
            # drop what it no longer covers and rescope the cursor, committed now.
            scope = getattr(connector, "scope", None)
            if scope is not None:
                stats.deleted += await store.delete_out_of_scope(db, source, scope(config))
            rescope = getattr(connector, "rescope_cursor", None)
            cursor = rescope(cursor or None, config) if rescope is not None else None
            await _write(db, start, cursor=stamped(cursor))
            await db.commit()
        async for event in connector.sync(dict(config), credential, cursor or None, **extra):
            if isinstance(event, base.ItemUpsert):
                _, written = await store.upsert_item(db, source, event)
                stats.upserted += 1
                stats.versions_written += int(written)
            elif isinstance(event, base.ItemDelete):
                stats.deleted += int(await store.delete_item(db, source, event))
            elif isinstance(event, base.CursorCheckpoint):
                cursor = dict(event.cursor)
                await _write(db, start, cursor=stamped(cursor))
                await db.commit()
                stats.checkpoints += 1
            elif isinstance(event, base.Attention):
                attentions.append(event.message)
            else:
                raise TypeError(f"unexpected sync event {type(event).__name__}")
        # The end: what came after the last checkpoint, under the same condition.
        message = " ".join(attentions) or None
        await _write(
            db,
            start,
            cursor=stamped(cursor),
            status=_status("needs_attention" if message else "active"),
            last_error=message,
            last_synced_at=func.now(),
        )
    except _Superseded:
        stats.outcome = "superseded"
        return stats
    except base.ConnectorRateLimited as e:
        # Stop cleanly: keep everything up to the last checkpoint and its cursor.
        await db.rollback()
        wait = f" (retry after {e.retry_after:g}s)" if e.retry_after is not None else ""
        try:
            await _write(db, start, last_error=f"Rate limited by {kind}; the next sync resumes{wait}")
        except _Superseded:
            stats.outcome = "superseded"
            return stats
        await db.commit()
        stats.outcome = "rate_limited"
        stats.retry_after = e.retry_after
        return stats
    except base.ConnectorNeedsAttention as e:
        message = service.redact(str(e), credential)
        return await _failed(db, start, stats, message, "needs_attention")
    except base.ConnectorForbidden as e:
        # One request refused (a transcript the key may not read, a channel): the source
        # fails, the connection itself is not marked expired.
        detail = service.redact(str(e), credential) or "forbidden"
        return await _failed(db, start, stats, f"Access refused: {detail}")
    except base.ConnectorAuthError as e:
        detail = service.redact(str(e), credential) or "credential rejected"
        await db.rollback()
        # The credential was rejected whatever became of the source since.
        await service.mark_connection_rejected(
            db, used_id, owner_id, f"Rejected during a sync: {detail}"
        )
        return await _failed(db, start, stats, f"The connection was rejected: {detail}")
    except base.ConnectorError as e:
        return await _failed(db, start, stats, service.redact(str(e), credential))
    except Exception as e:  # noqa: BLE001 - recorded on the source, never re-raised
        # The type only: a message could carry provider responses or secrets.
        log.error("sync of a %s source failed: %s", kind, type(e).__name__)
        return await _failed(db, start, stats, f"Sync failed unexpectedly ({type(e).__name__})")

    await db.commit()
    if attentions:
        stats.outcome = "needs_attention"
        stats.error = message
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
