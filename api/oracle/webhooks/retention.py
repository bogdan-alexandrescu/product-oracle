"""The delivery log's retention (I1, Q6: 30 days): a daily step of the tick deletes the
company's deliveries and events older than that (a delivery's request body goes with it).
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.webhooks.models import WebhookDelivery, WebhookEvent

RETENTION = timedelta(days=30)
DAILY = timedelta(days=1)

# When each company was last purged by this process; the purge is idempotent, so another
# instance purging again the same day costs one query.
_last: dict[uuid.UUID, datetime] = {}


async def purge(db: AsyncSession, now: datetime | None = None) -> int:
    """Delete the company's deliveries and events older than the retention (the caller
    commits). Returns how many rows went."""
    cutoff = (now or datetime.now(UTC)) - RETENTION
    gone = await db.execute(
        delete(WebhookDelivery).where(
            func.coalesce(WebhookDelivery.last_at, WebhookDelivery.created_at) < cutoff
        )
    )
    events = await db.execute(delete(WebhookEvent).where(WebhookEvent.occurred_at < cutoff))
    return (gone.rowcount or 0) + (events.rowcount or 0)


async def purge_due(db: AsyncSession, tenant_id: uuid.UUID, now: datetime | None = None) -> int:
    """:func:`purge`, once a day per company."""
    now = now or datetime.now(UTC)
    last = _last.get(tenant_id)
    if last is not None and abs(now - last) < DAILY:
        return 0
    _last[tenant_id] = now
    return await purge(db, now)
