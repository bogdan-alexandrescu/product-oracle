"""S4 Freshness (A2 §8): the run ticker syncs each source about hourly.

Until now a source synced only on Sync now (``POST /v1/sources/{id}/sync``) or ``oracle
sync``, so freshness decayed, and a merge only made a code map stale (F5-2,
``codemaps.note_merge``) once someone pressed it. Each tick of a company now runs the same
sync engine (:func:`oracle.sources.sync.sync_source`) on the sources that are due:

- **Due**: last synced at least :data:`INTERVAL` ago, or never, and not held back by
  ``next_sync_at``.
- **Left alone**: paused sources, uploads (nothing to sync), and sources whose connection
  is gone or not active (expired, revoked, rejected): the owner reconnects first.
- **Bounded**: at most :data:`SOURCES_PER_TICK` a tick, the stalest first, and at most one
  per connection, since each provider's limits are per connection (the Slack or GitHub
  token, the Fireflies key). No sync starts once the tick's budget is spent.
- **Backing off**: a sync that fails waits ``2^failures`` hours, up to
  :data:`MAX_BACKOFF`; a rate limit waits for the provider's retry time, at least
  :data:`MIN_RATE_LIMIT_WAIT`, and does not count as a failure (the next sync resumes from
  the saved cursor). A sync that completes clears both (the engine does, on Sync now too).
"""

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.connections.models import Connection
from oracle.sources import service
from oracle.sources import sync as sync_engine
from oracle.sources.models import Source

log = logging.getLogger(__name__)

INTERVAL = timedelta(hours=1)
SOURCES_PER_TICK = 3
MAX_BACKOFF = timedelta(hours=24)
MIN_RATE_LIMIT_WAIT = timedelta(minutes=15)
# Due sources read per tick to choose from (one per connection among them).
CANDIDATES = 200


@dataclass
class Synced:
    """What one company's tick did: syncs that completed, failed or were rate limited."""

    synced: int = 0
    failed: int = 0
    rate_limited: int = 0


def backoff(failures: int) -> timedelta:
    """How long a source waits after ``failures`` failed syncs in a row (1: 2 h, 2: 4 h…)."""
    return min(INTERVAL * 2 ** min(failures, 10), MAX_BACKOFF)


async def due(db: AsyncSession, now: datetime) -> list[Source]:
    """The sources to sync this tick, stalest first, at most one per connection."""
    stmt = (
        select(Source)
        .join(Connection, Connection.id == Source.connection_id)
        .where(
            Source.status != "paused",
            Source.kind != "upload",
            Connection.status == "active",
            (Source.last_synced_at.is_(None)) | (Source.last_synced_at <= now - INTERVAL),
            (Source.next_sync_at.is_(None)) | (Source.next_sync_at <= now),
        )
        .order_by(Source.last_synced_at.asc().nulls_first(), Source.created_at, Source.id)
        .limit(CANDIDATES)
    )
    chosen: list[Source] = []
    connections: set = set()
    for source in (await db.scalars(stmt)).all():
        if source.connection_id in connections:
            continue
        connections.add(source.connection_id)
        chosen.append(source)
        if len(chosen) == SOURCES_PER_TICK:
            break
    return chosen


async def sync_due(db: AsyncSession, now: datetime, deadline: float | None = None) -> Synced:
    """Sync the company's due sources (``deadline``: ``time.monotonic()`` after which no new
    sync starts). Each sync commits on its own; one that raises is counted as failed."""
    out = Synced()
    # A sync that fails rolls the session back, which expires every source loaded in it:
    # each is read again by its id just before its own sync.
    for source_id in [source.id for source in await due(db, now)]:
        if deadline is not None and time.monotonic() >= deadline:
            break
        source = await db.get(Source, source_id, populate_existing=True)
        if source is None or source.status == "paused":
            continue  # removed or paused since it was picked
        before, failures = source.last_synced_at, source.sync_failures
        error = None
        try:
            stats = await sync_engine.sync_source(db, source)
            outcome, retry_after = stats.outcome, stats.retry_after
            finished = source.last_synced_at is not None and source.last_synced_at != before
        except sync_engine.SyncRefused:
            await db.rollback()  # paused (or made unsyncable) since it was picked
            continue
        except Exception as e:  # noqa: BLE001 - one source must not stop the others
            await db.rollback()
            log.error("background sync of a source failed: %s", type(e).__name__)
            # Raised before the sync started, so the engine wrote no error on the source.
            if isinstance(e, service.InvalidError | service.NotFoundError):
                error = str(e)
            else:
                error = f"Sync failed unexpectedly ({type(e).__name__})"
            outcome, retry_after, finished = "error", None, False
        values: dict = {}
        if outcome == "rate_limited":
            wait = max(timedelta(seconds=retry_after or 0), MIN_RATE_LIMIT_WAIT)
            values = {"next_sync_at": now + wait}
            out.rate_limited += 1
        elif outcome in ("error", "needs_attention") and not finished:
            values = {"sync_failures": failures + 1, "next_sync_at": now + backoff(failures + 1)}
            if error is not None:
                values |= {"status": sync_engine._status("error"), "last_error": error}
            out.failed += 1
        elif outcome != "superseded":
            out.synced += 1
        if values:
            await db.execute(
                update(Source)
                .where(Source.id == source_id)
                .values(**values)
                .execution_options(synchronize_session=False)
            )
            await db.commit()
    return out
