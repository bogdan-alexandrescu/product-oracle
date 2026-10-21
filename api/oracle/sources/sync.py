"""The sync engine: runs a source's connector and stores what it yields.

Upserts and deletes are committed together with the cursor of each
:class:`~oracle.sources.base.CursorCheckpoint`, so an interrupted sync resumes from
the last checkpoint. Changes after the last checkpoint are committed only when the
connector finishes; on any failure they are rolled back and re-read next time.

Credentials are passed to the connector and nowhere else: never stored on the
source, logged, or echoed in ``last_error`` (connector messages are redacted).

A sync works for the source's config and connection as they were when it started (for
Google Docs, also the company's email domains and shared drives). Every save (a
checkpoint's cursor, the final status and unavailable items) first locks the source's
row and checks they are unchanged; when an edit changed them meanwhile, the sync rolls
back what it has not saved and stops (outcome ``superseded``), so it never writes a
cursor, report or docs made for the old settings over the edit.

Google Docs: saving a narrower allowlist, or narrower company Drive settings, deletes
what falls outside in that request, with no provider call (S5, narrowing takes effect on
save; owner 2026-10-20; :func:`oracle.sources.service.update_source`). That save skips
item rows a running sync has written and not committed, so a superseded Google Docs sync
deletes, once rolled back, whatever now falls outside
(:func:`oracle.sources.service.tidy_drive_source`). Before the connector runs, every live
item of the source is added to the cursor's ``files`` (with no time, so it is read again)
when missing; the connector deletes what it knows and no longer finds under the
allowlist, which also cleans sources narrowed before narrowing took effect on save.
"""

import logging
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

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
    # Items the connector could not read (base.ItemUnavailable), in the order reported.
    unavailable: list[dict[str, str]] = field(default_factory=list)


class SyncRefused(Exception):
    """The source cannot sync now (paused, an upload source)."""


class _Superseded(Exception):
    """The source's config or connection changed while it synced. ``company_narrowed``:
    the company's email domains or shared drives were narrowed (only then does tidy
    delete items whose drive and owner are not known; a person's own edit hides only
    what they removed)."""

    def __init__(self, company_narrowed: bool = False) -> None:
        super().__init__()
        self.company_narrowed = company_narrowed


@dataclass(frozen=True)
class _Started:
    """What a sync works for: the source's config and connection when it started, and
    for Google Docs the company's email domains and shared drives it judged docs by."""

    source_id: Any
    config: dict[str, Any]
    connection_id: Any
    kind: str = ""
    tenant_id: Any = None
    company: tuple[tuple[str, ...], tuple[str, ...]] | None = None


async def _company(db: AsyncSession, tenant_id: Any) -> tuple[tuple[str, ...], tuple[str, ...]]:
    domains, drives = await service.company_scope(db, tenant_id)
    return tuple(domains), tuple(drives)


async def _hold(db: AsyncSession, started: _Started) -> None:
    """Lock the source's row until the next commit; raise :class:`_Superseded` when its
    config or connection, or the company's Drive settings, are no longer the ones the
    sync started with. An owner's change of those settings locks every Google Docs
    source row before it commits, so this sees it.

    FOR NO KEY UPDATE, not FOR UPDATE: writing a source's items takes KEY SHARE on the
    source row (their foreign key), which FOR UPDATE waits on, so two syncs of one
    source could each hold the other's lock. Edits of the row still wait."""
    row = (
        await db.execute(
            select(Source.config, Source.connection_id)
            .where(Source.id == started.source_id)
            .with_for_update(key_share=True)
        )
    ).one_or_none()
    narrowed = False
    changed = False
    if started.company is not None:
        now = await _company(db, started.tenant_id)
        if now != started.company:
            changed = True
            narrowed = not set(started.company[0]) <= set(now[0]) or not set(
                started.company[1]
            ) <= set(now[1])
    if row is None or row.config != started.config or row.connection_id != started.connection_id:
        raise _Superseded(narrowed)
    if changed:
        raise _Superseded(narrowed)


async def _superseded(
    db: AsyncSession, stats: SyncStats, started: _Started, company_narrowed: bool = False
) -> SyncStats:
    await db.rollback()
    stats.outcome = "superseded"
    stats.unavailable = []
    if started.kind == "google_docs":
        # What the edit's save skipped because this sync held the rows (now rolled back).
        await service.tidy_drive_source(db, started.source_id, unknown_outside=company_narrowed)
    return stats


async def _drive_cursor(
    db: AsyncSession, source: Source, cursor: dict[str, Any] | None
) -> dict[str, Any] | None:
    """The Google Docs cursor with every live item of the source in ``files``."""
    live = await db.scalars(
        select(SourceItem.external_id).where(
            SourceItem.source_id == source.id, SourceItem.deleted_at.is_(None)
        )
    )
    cursor = dict(cursor or {})
    files = {str(k): str(v) for k, v in (cursor.get("files") or {}).items()}
    missing = [i for i in live if i not in files]
    if not missing:
        return cursor or None
    for external_id in missing:
        files[external_id] = ""
    cursor["files"] = files
    return cursor


async def _fail(
    db: AsyncSession,
    source: Source,
    stats: SyncStats,
    message: str,
    started: _Started | None = None,
) -> SyncStats:
    await db.rollback()
    if started is not None:
        try:
            await _hold(db, started)
        except _Superseded as e:
            return await _superseded(db, stats, started, e.company_narrowed)
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

    config = dict(source.config)
    cursor = dict(source.cursor) if source.cursor else None
    company = None
    if source.kind == "google_docs":
        cursor = await _drive_cursor(db, source, cursor)
        company = await _company(db, source.tenant_id)
        config[base.COMPANY_DOMAINS] = list(company[0])
        config[base.COMPANY_SHARED_DRIVES] = list(company[1])
    started = _Started(
        source_id=source.id,
        config=dict(source.config),
        connection_id=source.connection_id,
        kind=source.kind,
        tenant_id=source.tenant_id,
        company=company,
    )
    try:
        async for event in connector.sync(config, credential, cursor):
            if isinstance(event, base.ItemUpsert):
                _, written = await store.upsert_item(db, source, event)
                stats.upserted += 1
                stats.versions_written += int(written)
            elif isinstance(event, base.ItemDelete):
                stats.deleted += int(await store.delete_item(db, source, event))
            elif isinstance(event, base.ItemUnavailable):
                stats.unavailable.append(
                    {
                        "external_id": event.external_id,
                        "reason": event.reason[:300],
                        **({"name": event.name[:300]} if event.name else {}),
                        **({"status": event.status} if event.status != "unavailable" else {}),
                    }
                )
            elif isinstance(event, base.CursorCheckpoint):
                await _hold(db, started)
                source.cursor = dict(event.cursor)
                # The lost-access report so far, so a sync that fails later shows it.
                source.unavailable_items = list(stats.unavailable)
                await db.commit()
                stats.checkpoints += 1
            else:
                raise TypeError(f"unexpected sync event {type(event).__name__}")
    except _Superseded as e:
        return await _superseded(db, stats, started, e.company_narrowed)
    except base.ConnectorRateLimited as e:
        # Stop cleanly: keep everything up to the last checkpoint and its cursor.
        await db.rollback()
        try:
            await _hold(db, started)
        except _Superseded as e:
            return await _superseded(db, stats, started, e.company_narrowed)
        stats.outcome = "rate_limited"
        stats.retry_after = e.retry_after
        wait = f" (retry after {e.retry_after:g}s)" if e.retry_after is not None else ""
        source.last_error = f"Rate limited by {kind}; the next sync resumes{wait}"
        await db.commit()
        return stats
    except base.ConnectorAuthError as e:
        detail = service.redact(str(e), credential) or "credential rejected"
        stats = await _fail(db, source, stats, f"The connection was rejected: {detail}", started)
        await service.mark_connection_rejected(db, source, f"Rejected during a sync: {detail}")
        return stats
    except base.ConnectorError as e:
        return await _fail(db, source, stats, service.redact(str(e), credential), started)
    except Exception as e:  # noqa: BLE001 - recorded on the source, never re-raised
        # The type only: a message could carry provider responses or secrets.
        log.error("sync of a %s source failed: %s", kind, type(e).__name__)
        return await _fail(
            db, source, stats, f"Sync failed unexpectedly ({type(e).__name__})", started
        )

    try:
        await _hold(db, started)
    except _Superseded as e:
        return await _superseded(db, stats, started, e.company_narrowed)
    source.status = "active"
    source.last_error = None
    source.unavailable_items = list(stats.unavailable)
    source.last_synced_at = func.now()
    await db.commit()
    return stats
