"""Fan-out (I1 "Delivery"): each new ``webhook_events`` row becomes one ``pending``
delivery per active webhook subscribed to its type, on the tick.

The owners-and-approvers rule (Q2), first of its two checks: an event captured as
``approvers_only`` goes only to webhooks with ``include_approvers_content`` on. Every other
webhook gets no delivery and no placeholder: from outside, the event didn't happen. The
second check runs at send (:func:`oracle.webhooks.outbox.withheld`).
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.webhooks.models import Webhook, WebhookDelivery, WebhookEvent

# Events fanned out per company per tick; the rest wait for the next one.
EVENTS_PER_TICK = 200


async def fan_out(db: AsyncSession, now: datetime) -> int:
    """Fan out the company's new events, oldest first (the caller commits). Returns how
    many deliveries were queued."""
    new = list(
        await db.scalars(
            select(WebhookEvent)
            .where(WebhookEvent.fanned_out_at.is_(None))
            .order_by(WebhookEvent.occurred_at, WebhookEvent.id)
            .limit(EVENTS_PER_TICK)
            .with_for_update(skip_locked=True)
        )
    )
    if not new:
        return 0
    hooks = list(await db.scalars(select(Webhook).where(Webhook.status == "active")))
    queued = 0
    for event in new:
        for hook in hooks:
            if event.type not in hook.event_types:
                continue
            if event.approvers_only and not hook.include_approvers_content:
                continue
            db.add(
                WebhookDelivery(
                    webhook_id=hook.id,
                    event_id=event.id,
                    status="pending",
                    next_at=now,
                    # The tick's clock: the 24-hour give-up counts from here.
                    created_at=now,
                )
            )
            queued += 1
        event.fanned_out_at = now
    await db.flush()
    return queued
