"""The sync engine: runs a source's connector and stores what it yields.

Upserts and deletes are committed together with the cursor of each
:class:`~oracle.sources.base.CursorCheckpoint`, so an interrupted sync resumes from
the last checkpoint. Changes after the last checkpoint are committed only when the
connector finishes; on any failure they are rolled back and re-read next time.

A sync runs what the database holds when it starts (config, connection, the account that
connection signs in to, cursor and status, read in one select), not the caller's copy of
the row; for Google Docs, also the company's email domains and shared drives it judges
docs by. Before the first item write of each transaction, and before every write it
makes on the source (each cursor save, the end, an error, a rate limit, needing
attention), it locks the source's row (:func:`_hold`) and checks that the source still
has that config, connection and account and, for Google Docs, that the company's Drive
settings are the same. The write itself is one conditional UPDATE on the same condition.
A source edited while its sync runs (a channel removed, a new connection, a narrower
company domain list) keeps none of what that sync read after the edit: the transaction
is rolled back and the sync ends ``superseded``, so it never writes a cursor, report or
items made for the old settings over the edit.

The saved cursor carries a fingerprint of the selection (normalised config, connection,
account) under :data:`~oracle.sources.base.SCOPE_KEY`. When it is missing or differs, the
selection changed since the last sync: the items now outside it are deleted (soft) and
the cursor is rescoped (``rescope_cursor``), committed at once, before the connector
runs, so a rate limit or failure later in the sync cannot roll the sweep back.

Google Docs: saving a narrower allowlist, or narrower company Drive settings, deletes
what falls outside in that request, with no provider call (S5, narrowing takes effect on
save; owner 2026-10-20; :func:`oracle.sources.service.update_source`). The save locks the
source row before it touches items, as this engine does before it writes them, so it
waits for a running sync's next commit and the sync then finds the source changed. A
superseded Google Docs sync still deletes, once rolled back, whatever now falls outside
(:func:`oracle.sources.service.tidy_drive_source`; items whose drive and owner are not
known only after a company narrowing). Before the connector runs, every live item of the
source is added to the cursor's ``files`` (with no time, so it is read again) when
missing; the connector deletes what it knows and no longer finds under the allowlist,
which also cleans sources narrowed before narrowing took effect on save. Items it cannot
read (:class:`~oracle.sources.base.ItemUnavailable`) are saved on the source with each
checkpoint, so a sync that fails later still shows them.

A forbidden request (:class:`~oracle.sources.base.ConnectorForbidden`) fails the source
and leaves the connection active; only a rejected credential (a 401, a revoked key)
marks the connection the sync used expired.

Credentials are passed to the connector and nowhere else: never stored on the
source, logged, or echoed in ``last_error`` (connector messages are redacted).
"""

import dataclasses
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import case, cast, func, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.connections.models import Connection
from oracle.engineering import codemaps
from oracle.sources import base, service, store
from oracle.sources.connectors import github
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
    # Items the connector could not read (base.ItemUnavailable), in the order reported.
    unavailable: list[dict[str, str]] = field(default_factory=list)


class SyncRefused(Exception):
    """The source cannot sync now (paused, an upload source)."""


class _Superseded(Exception):
    """The source was edited while it synced: its config, connection or the connection's
    account changed, or (Google Docs) the company's email domains or shared drives did.
    ``company_narrowed``: those company settings were narrowed (only then does tidy
    delete items whose drive and owner are not known; a person's own edit hides only
    what they removed)."""

    def __init__(self, company_narrowed: bool = False) -> None:
        super().__init__()
        self.company_narrowed = company_narrowed


def fingerprint(
    config: dict[str, Any], connection_id: uuid.UUID | None, account_id: str | None = None
) -> str:
    """What identifies a selection: the config (its ``labels`` aside: they only name
    things, base.selection), the connection it is read through and the account that
    connection signs in to."""
    raw = json.dumps(
        {
            "config": base.selection(config),
            "connection": str(connection_id) if connection_id else None,
            "account": account_id,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode()).hexdigest()


Company = tuple[tuple[str, ...], tuple[str, ...]]


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
    kind: str = ""
    tenant_id: uuid.UUID | None = None
    # Google Docs: the company's email domains and shared drives the sync judges docs by.
    company: Company | None = None


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
                Source.kind,
                Source.tenant_id,
            )
            .outerjoin(Connection, Connection.id == Source.connection_id)
            .where(Source.id == source_id)
        )
    ).one_or_none()
    if row is None:
        return None
    config, connection_id, account_id, cursor, status, kind, tenant_id = row
    return _Start(
        source_id,
        dict(config or {}),
        connection_id,
        account_id,
        dict(cursor) if cursor else None,
        status,
        kind,
        tenant_id,
    )


async def _company(db: AsyncSession, tenant_id: uuid.UUID | None) -> Company:
    domains, drives = await service.company_scope(db, tenant_id)  # type: ignore[arg-type]
    return tuple(domains), tuple(drives)


async def _hold(db: AsyncSession, start: _Start) -> None:
    """Lock the source's row until the transaction's next commit, and raise
    :class:`_Superseded` when the source no longer has the selection (the config, its
    ``labels`` aside: base.selection), connection and
    connection account the sync started with or, for Google Docs, the company's Drive
    settings changed. An owner's narrowing of those settings locks every Google Docs
    source row before it deletes anything (oracle.sources.service.hide_outside_company),
    so it waits for this transaction's commit and the next hold sees it.

    Taken before the transaction's first item write, and before every write on the
    source. A save that edits the source locks the row and then sweeps items; the sync
    locks the row here and then writes items and its checkpoint. Taking the row first
    gives both the same order, so neither waits on the other's rows (a deadlock): a save
    waits for this transaction's next commit, and the hold after it finds the source
    changed.

    FOR NO KEY UPDATE, not FOR UPDATE: writing a source's items takes KEY SHARE on the
    source row (their foreign key), which FOR UPDATE waits on, so two syncs of one source
    could each hold the other's lock. Edits of the row still wait."""
    account = (
        select(Connection.account_id).where(Connection.id == Source.connection_id).scalar_subquery()
    )
    row = (
        await db.execute(
            select(Source.config, Source.connection_id, account.label("account_id"))
            .where(Source.id == start.source_id)
            .with_for_update(key_share=True, of=Source)
        )
    ).one_or_none()
    narrowed = changed = False
    if start.company is not None:
        now = await _company(db, start.tenant_id)
        if now != start.company:
            changed = True
            (domains, drives), (now_domains, now_drives) = start.company, now
            narrowed = not set(domains) <= set(now_domains) or not set(drives) <= set(now_drives)
    if (
        row is None
        or base.selection(dict(row.config or {})) != base.selection(start.config)
        or row.connection_id != start.connection_id
        or row.account_id != start.account_id
        or changed
    ):
        raise _Superseded(narrowed)


async def _write(db: AsyncSession, start: _Start, **values: Any) -> None:
    """Write ``values`` on the source (with what was stored since the last write) only if
    it still has what the sync started with (:func:`_hold`, which also locks the row, so
    a status it reads, a pause, is the one it writes over); otherwise raise
    :class:`_Superseded`. The UPDATE repeats the row's condition."""
    await _hold(db, start)
    account = (
        select(Connection.account_id).where(Connection.id == Source.connection_id).scalar_subquery()
    )
    result = await db.execute(
        update(Source)
        .where(
            Source.id == start.source_id,
            # New names alone (labels) are not a new selection.
            Source.config.op("-", return_type=JSONB)("labels")
            == cast(base.selection(start.config), JSONB),
            Source.connection_id.is_not_distinct_from(start.connection_id),
            account.is_not_distinct_from(start.account_id),
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        raise _Superseded


async def _superseded(
    db: AsyncSession, stats: SyncStats, start: _Start, company_narrowed: bool = False
) -> SyncStats:
    """The source changed while it synced: keep nothing since the last checkpoint."""
    await db.rollback()
    stats.outcome = "superseded"
    stats.unavailable = []
    if start.kind == "google_docs":
        # Whatever now falls outside: what the edit's save could not judge (rows this
        # sync held, now rolled back).
        await service.tidy_drive_source(db, start.source_id, unknown_outside=company_narrowed)
    return stats


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
    except _Superseded as e:
        return await _superseded(db, stats, start, e.company_narrowed)
    await db.commit()
    stats.outcome = "error" if status == "error" else "needs_attention"
    stats.error = message
    return stats


async def _drive_cursor(
    db: AsyncSession, source_id: uuid.UUID, cursor: dict[str, Any] | None
) -> dict[str, Any] | None:
    """The Google Docs cursor with every live item of the source in ``files``."""
    live = await db.scalars(
        select(SourceItem.external_id).where(
            SourceItem.source_id == source_id, SourceItem.deleted_at.is_(None)
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
    if (
        base.selection(start.config) != base.selection(dict(source.config or {}))
        or start.connection_id != source.connection_id
    ):
        await db.rollback()
        stats.outcome = "superseded"
        return stats
    config = start.config
    if kind == "google_docs":
        start = dataclasses.replace(start, company=await _company(db, start.tenant_id))

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
    problem = service.scope_problem(kind, config, used)
    if problem:
        return await _failed(db, start, stats, problem)

    scope_fp = fingerprint(
        service.normalize_config(kind, config), start.connection_id, start.account_id
    )
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

    # What the connector reads: Google Docs also gets the company's domains and drives.
    run_config = dict(config)
    if start.company is not None:
        run_config[base.COMPANY_DOMAINS] = list(start.company[0])
        run_config[base.COMPANY_SHARED_DRIVES] = list(start.company[1])

    attentions: list[str] = []
    held = False  # this transaction holds the source row (see _hold)
    try:
        if saved.get(base.SCOPE_KEY) != scope_fp:
            # The selection changed since the last sync (or was never fingerprinted):
            # drop what it no longer covers and rescope the cursor, committed now.
            scope = getattr(connector, "scope", None)
            if scope is not None:
                await _hold(db, start)
                stats.deleted += await store.delete_out_of_scope(db, source, scope(config))
            rescope = getattr(connector, "rescope_cursor", None)
            cursor = rescope(cursor or None, config) if rescope is not None else None
            await _write(db, start, cursor=stamped(cursor))
            await db.commit()
        if kind == "google_docs":
            cursor = await _drive_cursor(db, source_id, cursor)
        async for event in connector.sync(run_config, credential, cursor or None, **extra):
            if isinstance(event, base.ItemUpsert | base.ItemDelete) and not held:
                await _hold(db, start)
                held = True
            if isinstance(event, base.ItemUpsert):
                _, written = await store.upsert_item(db, source, event)
                stats.upserted += 1
                stats.versions_written += int(written)
                merged = github.merged_pull(event) if written and kind == "github" else None
                if merged is not None:
                    # F5-2: a merge after the repo's code map was built makes it stale
                    # (written with the item, so a rolled-back sync notices it again).
                    await codemaps.note_merge(db, source_id, *merged)
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
                cursor = dict(event.cursor)
                # The lost-access report so far too, so a sync that fails later shows it.
                await _write(
                    db, start, cursor=stamped(cursor), unavailable_items=list(stats.unavailable)
                )
                await db.commit()
                held = False
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
            unavailable_items=list(stats.unavailable),
            last_synced_at=func.now(),
        )
    except _Superseded as e:
        return await _superseded(db, stats, start, e.company_narrowed)
    except base.ConnectorRateLimited as e:
        # Stop cleanly: keep everything up to the last checkpoint and its cursor.
        await db.rollback()
        wait = f" (retry after {e.retry_after:g}s)" if e.retry_after is not None else ""
        try:
            await _write(
                db, start, last_error=f"Rate limited by {kind}; the next sync resumes{wait}"
            )
        except _Superseded as superseded:
            return await _superseded(db, stats, start, superseded.company_narrowed)
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
