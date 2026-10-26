"""Settings › Webhooks (I1): owners and approvers (Q1); approvers manage their own,
owners every one.

Every route is absent (404) below approver, as H8's owners-and-approvers areas are, and
refused (403) to a run's token (``not_for_runs``) before the role is read. Writes re-check
the caller under the review gate (C2). Create and rotate return the signing secret once,
to any write credential (Q4 as changed 2026-10-25); a read-only credential is refused
every write by oracle.auth.deps. Sending a test event and redelivering belong to the
delivery lane (lane 2).
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import has_role, recheck_caller
from oracle.webhooks import service
from oracle.webhooks.events import EVENT_TYPES
from oracle.webhooks.models import Webhook, WebhookDelivery, WebhookEvent
from oracle.webhooks.schemas import (
    DeliveryOut,
    DeliveryPage,
    EventTypeOut,
    RotateIn,
    WebhookCreated,
    WebhookIn,
    WebhookOut,
    WebhookPatch,
)

router = APIRouter(prefix="/v1", tags=["webhooks"])

_STATUS = {"invalid": 422, "not_found": 404, "forbidden": 403, "conflict": 409}
PAGE = 50


async def approver_or_absent(principal: CurrentPrincipal) -> Principal:
    """403 for a run's token, then 404 below approver."""
    if principal.run_id is not None or principal.run_token_id is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "A run's agents cannot manage webhooks")
    if not has_role(principal.role, "approver"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return principal


# Read by oracle.capabilities (#370): the Settings tab shows only for approvers and owners.
approver_or_absent.min_role = "approver"  # type: ignore[attr-defined]
Approver = Annotated[Principal, Depends(approver_or_absent)]


async def owner_after_absent(principal: Approver) -> Principal:
    """:func:`approver_or_absent`, then 403 for an approver (taking over is an owner's)."""
    if principal.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an owner can take over a webhook")
    return principal


owner_after_absent.min_role = "owner"  # type: ignore[attr-defined]
Owner = Annotated[Principal, Depends(owner_after_absent)]


def _refused(e: service.WebhookError) -> HTTPException:
    return HTTPException(_STATUS[e.code], str(e))


async def _write(db, principal: Principal) -> None:
    await recheck_caller(db, principal, "approver")


async def _load(db, principal: Principal, webhook_id: uuid.UUID) -> Webhook:
    try:
        return await service.get(db, principal, webhook_id)
    except service.WebhookError as e:
        raise _refused(e) from None


async def _out(db, principal: Principal, hook: Webhook) -> WebhookOut:
    return (await service.outs(db, principal, [hook]))[0]


@router.get(
    "/webhook-event-types",
    response_model=list[EventTypeOut],
)
async def list_webhook_event_types(principal: Approver) -> list[EventTypeOut]:
    """The events a webhook may subscribe to, in the registry's order."""
    return [
        EventTypeOut(
            type=et.type,
            group=et.group,  # type: ignore[arg-type]
            label=et.label,
            can_be_approvers_only=et.can_be_approvers_only,
        )
        for et in EVENT_TYPES.values()
    ]


@router.get("/webhooks", response_model=list[WebhookOut])
async def list_webhooks(principal: Approver, db: TenantDB) -> list[WebhookOut]:
    """An approver's own webhooks; every webhook for an owner. Never the secret."""
    hooks = list(await db.scalars(service.visible(principal).order_by(Webhook.created_at)))
    return await service.outs(db, principal, hooks)


@router.post(
    "/webhooks",
    response_model=WebhookCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_webhook(body: WebhookIn, principal: Approver, db: TenantDB) -> WebhookCreated:
    """Create a webhook. The answer holds its signing secret, once: copy it now."""
    await _write(db, principal)
    try:
        hook, secret = await service.create(db, principal, body)
    except service.WebhookError as e:
        raise _refused(e) from None
    out = await _out(db, principal, hook)
    await db.commit()
    return WebhookCreated(webhook=out, secret=secret)


@router.get("/webhooks/{webhook_id}", response_model=WebhookOut)
async def get_webhook(webhook_id: uuid.UUID, principal: Approver, db: TenantDB) -> WebhookOut:
    return await _out(db, principal, await _load(db, principal, webhook_id))


@router.patch("/webhooks/{webhook_id}", response_model=WebhookOut)
async def update_webhook(
    webhook_id: uuid.UUID, body: WebhookPatch, principal: Approver, db: TenantDB
) -> WebhookOut:
    """Rename, re-point, change the events, pause or resume. Owners-and-approvers content
    is an owner's change, with a reason, on an owner's webhook only."""
    await _write(db, principal)
    hook = await _load(db, principal, webhook_id)
    try:
        hook = await service.update(db, principal, hook, body)
    except service.WebhookError as e:
        raise _refused(e) from None
    out = await _out(db, principal, hook)
    await db.commit()
    return out


@router.delete(
    "/webhooks/{webhook_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_webhook(webhook_id: uuid.UUID, principal: Approver, db: TenantDB) -> Response:
    """Delete a webhook, its secret and its delivery log."""
    await _write(db, principal)
    await service.delete(db, principal, await _load(db, principal, webhook_id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/webhooks/{webhook_id}/rotate-secret",
    response_model=WebhookCreated,
)
async def rotate_webhook_secret(
    webhook_id: uuid.UUID, principal: Approver, db: TenantDB, body: RotateIn | None = None
) -> WebhookCreated:
    """A new signing secret, shown once. The old one keeps signing for 24 hours unless
    ``end_old_now``."""
    await _write(db, principal)
    hook = await _load(db, principal, webhook_id)
    hook, secret = await service.rotate(db, principal, hook, (body or RotateIn()).end_old_now)
    out = await _out(db, principal, hook)
    await db.commit()
    return WebhookCreated(webhook=out, secret=secret)


@router.post(
    "/webhooks/{webhook_id}/take-over",
    response_model=WebhookOut,
)
async def take_over_webhook(webhook_id: uuid.UUID, principal: Owner, db: TenantDB) -> WebhookOut:
    """An owner makes a paused webhook of someone else's their own."""
    await _write(db, principal)
    hook = await _load(db, principal, webhook_id)
    try:
        hook = await service.take_over(db, principal, hook)
    except service.WebhookError as e:
        raise _refused(e) from None
    out = await _out(db, principal, hook)
    await db.commit()
    return out


def _delivery_out(d: WebhookDelivery, e: WebhookEvent) -> DeliveryOut:
    return DeliveryOut(
        id=d.id,
        event_id=e.public_id,
        event_type=e.type,
        status=d.status,  # type: ignore[arg-type]
        attempts=d.attempts,
        next_at=d.next_at,
        last_at=d.last_at,
        http_status=d.http_status,
        duration_ms=d.duration_ms,
        error=d.error,
        response_excerpt=d.response_excerpt,
        body=d.body,
        redelivery_of=d.redelivery_of,
        created_at=d.created_at,
    )


def _deliveries(principal: Principal, hook: Webhook):
    stmt = (
        select(WebhookDelivery, WebhookEvent)
        .join(WebhookEvent, WebhookEvent.id == WebhookDelivery.event_id)
        .where(WebhookDelivery.webhook_id == hook.id)
    )
    if principal.role != "owner":
        # A withheld delivery names an owners-and-approvers event: owners only.
        stmt = stmt.where(WebhookDelivery.status != "withheld")
    return stmt


@router.get(
    "/webhooks/{webhook_id}/deliveries",
    response_model=DeliveryPage,
)
async def list_webhook_deliveries(
    webhook_id: uuid.UUID,
    principal: Approver,
    db: TenantDB,
    status_: Annotated[
        Literal["pending", "retrying", "succeeded", "failed", "withheld"] | None,
        Query(alias="status"),
    ] = None,
    type_: Annotated[str | None, Query(alias="type")] = None,
    before: datetime | None = None,
) -> DeliveryPage:
    """The delivery log, newest first, 50 a page."""
    hook = await _load(db, principal, webhook_id)
    stmt = _deliveries(principal, hook)
    if status_ is not None:
        stmt = stmt.where(WebhookDelivery.status == status_)
    if type_ is not None:
        stmt = stmt.where(WebhookEvent.type == type_)
    if before is not None:
        stmt = stmt.where(WebhookDelivery.created_at < before)
    rows = (
        await db.execute(stmt.order_by(WebhookDelivery.created_at.desc()).limit(PAGE + 1))
    ).all()
    items = [_delivery_out(d, e) for d, e in rows[:PAGE]]
    more = len(rows) > PAGE
    return DeliveryPage(items=items, next_before=items[-1].created_at if more else None)


@router.get(
    "/webhooks/{webhook_id}/deliveries/{delivery_id}",
    response_model=DeliveryOut,
)
async def get_webhook_delivery(
    webhook_id: uuid.UUID, delivery_id: uuid.UUID, principal: Approver, db: TenantDB
) -> DeliveryOut:
    hook = await _load(db, principal, webhook_id)
    row = (
        await db.execute(_deliveries(principal, hook).where(WebhookDelivery.id == delivery_id))
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return _delivery_out(*row)
