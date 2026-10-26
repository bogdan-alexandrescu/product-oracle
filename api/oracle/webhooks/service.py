"""Webhooks: capture, secrets, management and the C2 member hooks (I1 lane 1).

:func:`capture` adds one ``webhook_events`` row in the caller's session, beside the change's
own audit event, so the event commits or rolls back with the change. It does no network
I/O, and writes nothing when no active webhook of the company wants the type. Each point
calls it deliberately: audit actions are named for the audit trail, not for a public
contract.

A signing secret is ``whsec_`` and 32 random bytes in base64, made by Oracle only. It is
encrypted with :mod:`oracle.crypto` (Oracle signs with it, so it cannot be a hash) and
returned only by create's and rotate's own answer: never by a read, an audit row, a log
line or an error. Any write credential may receive it (owner, Q4 as changed 2026-10-25);
run tokens never reach these routes (``not_for_runs``). Every create and rotate is audited
with the credential used.
"""

import base64
import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, crypto
from oracle.auth.models import ApiToken, User
from oracle.members.names import display_name
from oracle.webhooks import events
from oracle.webhooks.models import Webhook, WebhookDelivery, WebhookEvent
from oracle.webhooks.schemas import (
    API_VERSION,
    LastDelivery,
    PersonName,
    WebhookIn,
    WebhookOut,
    WebhookPatch,
)

SECRET_PREFIX = "whsec_"
MAX_PER_COMPANY = 10
ROTATION_OVERLAP = timedelta(hours=24)
if TYPE_CHECKING:
    from oracle.auth.deps import Principal

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


class WebhookError(Exception):
    """A refused change: ``code`` is ``invalid`` (422), ``not_found`` (404), ``forbidden``
    (403) or ``conflict`` (409)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _now() -> datetime:
    return datetime.now(UTC)


# --- capture ----------------------------------------------------------------------------


def new_public_id() -> str:
    """``evt_`` and a ULID (48-bit milliseconds, 80 random bits, Crockford base32)."""
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    chars = []
    for _ in range(26):
        chars.append(_CROCKFORD[value & 31])
        value >>= 5
    return "evt_" + "".join(reversed(chars))


def _actor(actor: Any) -> str:
    """Who caused the event, as an audit actor string: a run's call is Oracle's work."""
    if actor is None:
        return "system"
    if isinstance(actor, str):
        return actor
    if getattr(actor, "run_id", None) is not None:
        return audit.ORACLE
    if isinstance(actor, User):
        return f"user:{actor.id}"
    return actor.actor


async def capture(
    db: AsyncSession, event_type: str, actor: Any, **subject: Any
) -> WebhookEvent | None:
    """Add one event to ``db`` (the caller commits), or nothing when no active webhook of
    the company is subscribed to ``event_type``. ``subject``: ids and codes only (run_id,
    checkpoint_id, document_id, version, outcome, origin, reason, error_kind)."""
    if event_type not in events.EVENT_TYPES:
        raise ValueError(f"unknown webhook event type {event_type!r}")
    wanted = await db.scalar(
        select(Webhook.id)
        .where(Webhook.status == "active", Webhook.event_types.any(event_type))
        .limit(1)
    )
    if wanted is None:
        return None
    clean = {k: str(v) for k, v in subject.items() if v is not None}
    clean["actor"] = _actor(actor)
    row = WebhookEvent(
        public_id=new_public_id(),
        type=event_type,
        subject=clean,
        approvers_only=await events.approvers_only(db, event_type, clean),
    )
    db.add(row)
    return row


# --- secrets ----------------------------------------------------------------------------


def new_secret() -> str:
    return SECRET_PREFIX + base64.b64encode(secrets.token_bytes(32)).decode()


def _set_secret(hook: Webhook, secret: str) -> None:
    hook.ciphertext = crypto.encrypt(secret.encode())
    hook.key_version = crypto.KEY_VERSION
    hook.secret_hint = secret[-4:]


def credential(principal: "Principal") -> dict[str, str]:
    """The credential a create or rotate came through, for its audit row (Q4)."""
    if principal.grant_id is not None:
        return {"kind": "mcp_client", "grant_id": str(principal.grant_id)}
    if principal.token_id is not None:
        return {"kind": "api_token", "token_id": str(principal.token_id)}
    return {"kind": "browser"}


# --- reads ------------------------------------------------------------------------------


async def names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Creators by name: a member's display name, else a user-less API token's name."""
    out: dict[uuid.UUID, str] = {
        u.id: display_name(u.email, u.name)
        for u in await db.scalars(select(User).where(User.id.in_(ids)))
    }
    rest = ids - set(out)
    if rest:
        for tid, name in (
            await db.execute(select(ApiToken.id, ApiToken.name).where(ApiToken.id.in_(rest)))
        ).all():
            out[tid] = name
    return out


async def _creator_role(db: AsyncSession, creator: uuid.UUID) -> str | None:
    user = await db.get(User, creator)
    if user is not None:
        return None if user.disabled_at is not None else user.role
    token = await db.get(ApiToken, creator)
    return None if token is None or token.revoked_at is not None else token.role


def visible(principal: "Principal"):
    """The webhooks ``principal`` manages: an owner's are every one, an approver's their own."""
    stmt = select(Webhook)
    if principal.role != "owner":
        stmt = stmt.where(Webhook.created_by == principal.id)
    return stmt


async def get(db: AsyncSession, principal: "Principal", webhook_id: uuid.UUID) -> Webhook:
    hook = await db.scalar(visible(principal).where(Webhook.id == webhook_id))
    if hook is None:
        raise WebhookError("not_found", "Not found")
    return hook


async def outs(db: AsyncSession, principal: "Principal", hooks: list[Webhook]) -> list[WebhookOut]:
    who = await names(db, {h.created_by for h in hooks})
    last: dict[uuid.UUID, WebhookDelivery] = {}
    if hooks:
        ranked = (
            select(
                WebhookDelivery,
                func.row_number()
                .over(
                    partition_by=WebhookDelivery.webhook_id,
                    order_by=WebhookDelivery.created_at.desc(),
                )
                .label("n"),
            )
            .where(WebhookDelivery.webhook_id.in_([h.id for h in hooks]))
            .subquery()
        )
        for d in await db.scalars(
            select(WebhookDelivery)
            .join(ranked, ranked.c.id == WebhookDelivery.id)
            .where(ranked.c.n == 1)
        ):
            last[d.webhook_id] = d
    from oracle.webhooks.outbox import failing_since

    out = []
    for h in hooks:
        d = last.get(h.id)
        failing = None
        if d is not None and d.status in ("failed", "retrying"):
            failing = (await failing_since(db, h.id))[0]
        out.append(
            WebhookOut(
                id=h.id,
                name=h.name,
                url=h.url,
                host=h.host,
                event_types=list(h.event_types),
                api_version=h.api_version,
                include_approvers_content=h.include_approvers_content,
                status=h.status,  # type: ignore[arg-type]
                paused_reason=h.paused_reason,  # type: ignore[arg-type]
                secret_hint=h.secret_hint,
                secret_rotated_at=h.secret_rotated_at,
                created_by=PersonName(name=who.get(h.created_by, "Someone removed")),
                created_at=h.created_at,
                last_delivery=(
                    LastDelivery(status=d.status, at=d.last_at, http_status=d.http_status)
                    if d is not None
                    else None
                ),
                failing_since=failing,
                can_take_over=(
                    principal.role == "owner"
                    and h.status == "paused"
                    and h.created_by != principal.id
                ),
            )
        )
    return out


# --- changes ----------------------------------------------------------------------------


async def _owners(db: AsyncSession) -> list[uuid.UUID]:
    return list(
        await db.scalars(select(User.id).where(User.role == "owner", User.disabled_at.is_(None)))
    )


async def _notify(
    db: AsyncSession,
    principal: Any,
    recipients,
    kind: str,
    title: str,
    hook,
    reason: str | None = None,
):
    """An Inbox row about a webhook; a pause's row names its reason (``paused_reason``)."""
    from oracle.review import collab

    data = {"webhook_id": str(hook.id), "href": "/settings/webhooks"}
    if reason is not None:
        data["reason"] = reason
    await collab.notify(db, recipients, kind=kind, title=title, actor=_actor(principal), data=data)


async def _approvers_content(
    db: AsyncSession, principal: "Principal", hook: Webhook, on: bool, reason: str | None
) -> None:
    """Turn owners-and-approvers content on or off (Q2): an owner, with a reason, and on
    only while the webhook's creator is an owner."""
    if principal.role != "owner":
        raise WebhookError("invalid", "Only an owner can include owners-and-approvers content")
    if not (reason or "").strip():
        raise WebhookError("invalid", "Say why owners-and-approvers content changes")
    if on and await _creator_role(db, hook.created_by) != "owner":
        raise WebhookError(
            "invalid", "Owners-and-approvers content goes only to a webhook an owner created"
        )
    hook.include_approvers_content = on
    action = "webhook.approvers_content_on" if on else "webhook.approvers_content_off"
    await audit.record(
        db, principal, action, "webhook", hook.id, {"reason": reason.strip(), "name": hook.name}
    )


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


async def create(db: AsyncSession, principal: "Principal", body: WebhookIn) -> tuple[Webhook, str]:
    count = await db.scalar(select(func.count(Webhook.id)))
    if count >= MAX_PER_COMPANY:
        raise WebhookError("invalid", f"A company has at most {MAX_PER_COMPANY} webhooks")
    if body.include_approvers_content and principal.role != "owner":
        raise WebhookError("invalid", "Only an owner can include owners-and-approvers content")
    secret = new_secret()
    hook = Webhook(
        id=uuid.uuid4(),
        name=body.name,
        url=body.url,
        host=_host(body.url),
        event_types=body.event_types,
        api_version=API_VERSION,
        include_approvers_content=False,
        status="active",
        created_by=principal.id,
        secret_rotated_at=_now(),
    )
    _set_secret(hook, secret)
    db.add(hook)
    await db.flush()
    await audit.record(
        db,
        principal,
        "webhook.create",
        "webhook",
        hook.id,
        {
            "name": hook.name,
            "host": hook.host,
            "event_types": hook.event_types,
            "credential": credential(principal),
        },
    )
    if body.include_approvers_content:
        await _approvers_content(db, principal, hook, True, body.reason)
    await db.flush()
    await db.refresh(hook)
    return hook, secret


async def update(
    db: AsyncSession, principal: "Principal", hook: Webhook, body: WebhookPatch
) -> Webhook:
    flag = body.include_approvers_content
    if flag is not None and flag != hook.include_approvers_content:
        await _approvers_content(db, principal, hook, flag, body.reason)
    changed: dict[str, Any] = {}
    if body.name is not None and body.name.strip() != hook.name:
        if not body.name.strip():
            raise WebhookError("invalid", "A name is required")
        changed["name"] = {"before": hook.name, "after": body.name.strip()}
        hook.name = body.name.strip()
    old_host = hook.host
    if body.url is not None and body.url != hook.url:
        hook.url = body.url
        hook.host = _host(body.url)
        changed["host"] = {"before": old_host, "after": hook.host}
    if body.event_types is not None and body.event_types != list(hook.event_types):
        changed["event_types"] = {"before": list(hook.event_types), "after": body.event_types}
        hook.event_types = body.event_types
    if changed:
        await audit.record(db, principal, "webhook.update", "webhook", hook.id, changed)
    if "host" in changed and principal.role != "owner":
        who = (await names(db, {principal.id})).get(principal.id, "Someone")
        await _notify(
            db,
            principal,
            await _owners(db),
            "webhook_url_changed",
            f"{who} changed where webhook {hook.name} sends",
            hook,
        )
    if body.status is not None and body.status != hook.status:
        hook.status = body.status
        hook.paused_reason = "manual" if body.status == "paused" else None
        if body.status == "active":
            hook.resumed_at = _now()
        action = "webhook.pause" if body.status == "paused" else "webhook.resume"
        await audit.record(db, principal, action, "webhook", hook.id, {"name": hook.name})
        if body.status == "paused" and hook.created_by != principal.id:
            who = (await names(db, {principal.id})).get(principal.id, "An owner")
            await _notify(
                db,
                principal,
                [hook.created_by],
                "webhook_paused",
                f"{who} paused your webhook {hook.name}",
                hook,
                reason="manual",
            )
    hook.updated_at = _now()
    await db.flush()
    await db.refresh(hook)
    return hook


async def delete(db: AsyncSession, principal: "Principal", hook: Webhook) -> None:
    await audit.record(
        db, principal, "webhook.delete", "webhook", hook.id, {"name": hook.name, "host": hook.host}
    )
    await db.delete(hook)
    await db.flush()


async def rotate(
    db: AsyncSession, principal: "Principal", hook: Webhook, end_old_now: bool
) -> tuple[Webhook, str]:
    """A new secret, returned once. The old one keeps signing for 24 hours (both signatures
    are sent), unless ``end_old_now``."""
    at = _now()
    if end_old_now:
        hook.previous_ciphertext = None
        hook.previous_expires_at = None
    else:
        hook.previous_ciphertext = hook.ciphertext
        hook.previous_expires_at = at + ROTATION_OVERLAP
    secret = new_secret()
    _set_secret(hook, secret)
    hook.secret_rotated_at = at
    hook.updated_at = at
    await audit.record(
        db,
        principal,
        "webhook.rotate_secret",
        "webhook",
        hook.id,
        {"end_old_now": end_old_now, "credential": credential(principal)},
    )
    await db.flush()
    await db.refresh(hook)
    return hook, secret


async def take_over(db: AsyncSession, principal: "Principal", hook: Webhook) -> Webhook:
    """An owner makes a paused webhook of someone else's their own (audited). Its
    owners-and-approvers content goes off: the new creator turns it on again, with a
    reason, if it should be."""
    if principal.role != "owner":
        raise WebhookError("forbidden", "Only an owner can take over a webhook")
    if hook.status != "paused" or hook.created_by == principal.id:
        raise WebhookError("conflict", "Only a paused webhook of someone else can be taken over")
    before = hook.created_by
    hook.created_by = principal.id
    hook.include_approvers_content = False
    hook.updated_at = _now()
    await audit.record(
        db, principal, "webhook.take_over", "webhook", hook.id, {"from": str(before)}
    )
    await db.flush()
    await db.refresh(hook)
    return hook


# --- C2: member changes -----------------------------------------------------------------


async def _pause_creators(
    db: AsyncSession, principal: Any, creators: set[uuid.UUID], reason: str
) -> None:
    for hook in await db.scalars(
        select(Webhook).where(Webhook.created_by.in_(creators), Webhook.status == "active")
    ):
        hook.status = "paused"
        hook.paused_reason = reason
        await audit.record(
            db,
            principal,
            "webhook.pause",
            "webhook",
            hook.id,
            {"name": hook.name, "reason": reason},
        )


async def _content_off(
    db: AsyncSession, principal: Any, creators: set[uuid.UUID], reason: str
) -> None:
    for hook in await db.scalars(
        select(Webhook).where(
            Webhook.created_by.in_(creators), Webhook.include_approvers_content.is_(True)
        )
    ):
        hook.include_approvers_content = False
        await audit.record(
            db,
            principal,
            "webhook.approvers_content_off",
            "webhook",
            hook.id,
            {"name": hook.name, "reason": reason},
        )


async def creator_disabled(db: AsyncSession, principal: Any, user_id: uuid.UUID) -> None:
    """A disabled member's webhooks pause (``creator_disabled``); a restore does not resume
    them: the creator or an owner resumes each one."""
    await _content_off(db, principal, {user_id}, "creator_disabled")
    await _pause_creators(db, principal, {user_id}, "creator_disabled")


async def creator_role_changed(
    db: AsyncSession, principal: Any, user_id: uuid.UUID, role: str
) -> None:
    """A creator demoted below approver: their webhooks pause (``creator_demoted``); a
    promotion does not resume them. Below owner: owners-and-approvers content goes off."""
    if role != "owner":
        await _content_off(db, principal, {user_id}, "creator_demoted")
    from oracle.authz import has_role

    if not has_role(role, "approver"):
        await _pause_creators(db, principal, {user_id}, "creator_demoted")
