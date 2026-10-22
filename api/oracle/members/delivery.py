"""An invite reaches the person (#242): its IAP access and its email, and what happened
to each, recorded on the invite for the Members page and in the audit log.

Access: creating an invite grants the invitee IAP's accessor role on Oracle's backend
services (:mod:`oracle.members.iap_access`) after the invite commits, so a failed grant
never loses it: the invite stays ``pending`` with the reason, and Retry
(``POST /v1/invites/{id}/access``) grants again. Revoking an open invite, or removing a
member, takes the binding away unless the person is still an active member or has
another open invite; restoring a member grants it again.

Email: queued with the invite (or Resend) and sent in the background
(:func:`schedule`), never on the request; one retry, then ``failed``. A send a dead
process left queued is picked up by the tick (:func:`send_queued`). With no sender
configured, nothing is sent: ``not_sent``.

Every function here commits: each runs after the request's own change committed.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import ApiToken, User
from oracle.config import get_settings
from oracle.members import iap_access, mailer
from oracle.members.models import Invite
from oracle.models import Tenant
from oracle.tenancy import tenant_session

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

log = logging.getLogger(__name__)

# A queued send older than this was lost with its process: the tick sends it.
STALE_QUEUED = timedelta(minutes=5)
MAX_ERROR_CHARS = 500


def sign_in_url() -> str:
    """Where the invitee signs in: ORACLE_APP_URL, else ORACLE_PUBLIC_URL, plus ``/``."""
    from oracle.swarm.settings import get_runtime_settings

    base = get_settings().app_url or get_runtime_settings().public_url
    return base.rstrip("/") + "/"


def _open(invite: Invite) -> bool:
    return invite.accepted_at is None and invite.revoked_at is None


# --- IAP access ----------------------------------------------------------------------------


async def _grant(email: str) -> tuple[str, str | None]:
    """Grant ``email`` access: (``granted`` | ``pending`` | ``skipped``, the error)."""
    backends = get_settings().iap_backends
    if not backends:
        return "skipped", None
    client = iap_access.get_client()
    if client is None:
        return "pending", "ORACLE_GCP_PROJECT is not set"
    try:
        await iap_access.grant(client, backends, email)
    except iap_access.IapError as exc:
        log.warning("IAP access for %s not granted: %s", email, exc)
        return "pending", str(exc)[:MAX_ERROR_CHARS]
    return "granted", None


async def grant_invite_access(
    session: AsyncSession, principal: "Principal", invite: Invite
) -> Invite:
    """Grant the invitee IAP access and record the outcome on the invite (commits)."""
    address = invite.email
    await session.rollback()  # no transaction held open across the IAP calls
    outcome, error = await _grant(address)
    await session.refresh(invite)
    if not _open(invite):
        return invite
    invite.access = outcome
    invite.access_error = error
    invite.access_at = datetime.now(UTC)
    await audit.record(
        session,
        principal,
        "invite_access.grant",
        "invite",
        invite.id,
        {
            "email": address,
            "outcome": "failed" if outcome == "pending" else outcome,
            "backends": list(get_settings().iap_backends),
            **({"error": error} if error else {}),
        },
    )
    await session.commit()
    return invite


async def grant_member_access(session: AsyncSession, principal: "Principal", user: User) -> None:
    """A restored member gets their IAP access back (commits). A failure is logged and
    audited; the owner sees it in the audit log."""
    address, user_id = user.email, user.id
    await session.rollback()
    outcome, error = await _grant(address)
    await audit.record(
        session,
        principal,
        "member_access.grant",
        "user",
        user_id,
        {
            "email": address,
            "outcome": "failed" if outcome == "pending" else outcome,
            **({"error": error} if error else {}),
        },
    )
    await session.commit()


async def release_access(
    session: AsyncSession, principal: "Principal", emails: list[str], action: str
) -> None:
    """Take IAP access away from each of ``emails``, unless the person is still an active
    member or has another open invite (commits). Audited as ``action``; a failure is
    logged and audited, never raised: the change that called it has committed."""
    backends = get_settings().iap_backends
    if not backends:
        return
    for address in sorted(set(emails)):
        member = await session.scalar(
            select(User.id).where(User.email == address, User.disabled_at.is_(None))
        )
        invited = await session.scalar(
            select(Invite.id).where(
                Invite.email == address, Invite.accepted_at.is_(None), Invite.revoked_at.is_(None)
            )
        )
        data: dict = {"email": address, "backends": list(backends)}
        if member is not None or invited is not None:
            data["outcome"] = "kept"
            data["reason"] = "an active member" if member is not None else "another open invite"
        else:
            await session.rollback()
            client = iap_access.get_client()
            try:
                if client is None:
                    raise iap_access.IapError("ORACLE_GCP_PROJECT is not set")
                await iap_access.revoke(client, backends, address)
                data["outcome"] = "removed"
            except iap_access.IapError as exc:
                log.warning("IAP access for %s not removed: %s", address, exc)
                data["outcome"] = "failed"
                data["error"] = str(exc)[:MAX_ERROR_CHARS]
        entity = "invite" if action.startswith("invite") else "user"
        await audit.record(session, principal, action, entity, None, data)
        await session.commit()


async def release_disabled(session: AsyncSession, principal: "Principal", user: User) -> None:
    """After a disable commits: the member's access, and that of the open invites the
    disable revoked with it (theirs, and the ones they created)."""
    emails = [user.email]
    if user.disabled_at is not None:
        emails += list(
            await session.scalars(select(Invite.email).where(Invite.revoked_at == user.disabled_at))
        )
    await release_access(session, principal, emails, "member_access.remove")


# --- The invite email ----------------------------------------------------------------------


def queue_email(invite: Invite) -> bool:
    """Owe the invite its email (the caller commits, then :func:`schedule` s it): True;
    or record that nothing is sent, with no sender configured: False."""
    invite.email_error = None
    invite.email_at = datetime.now(UTC)
    if mailer.get_mailer() is None:
        invite.email_status = "not_sent"
        return False
    invite.email_status = "queued"
    return True


_tasks: set[asyncio.Task] = set()


def schedule(tenant_id: uuid.UUID, invite_id: uuid.UUID) -> None:
    """Send the invite's email in the background, after the response."""
    task = asyncio.get_running_loop().create_task(_deliver_logged(tenant_id, invite_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def drain() -> None:
    """Wait for the background sends under way (tests; shutdown)."""
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)


async def _deliver_logged(tenant_id: uuid.UUID, invite_id: uuid.UUID) -> None:
    try:
        await deliver(tenant_id, invite_id)
    except Exception:
        # Still queued: the tick sends it once it is stale.
        log.exception("sending the email of invite %s failed", invite_id)


async def _claim(
    s: AsyncSession, invite_id: uuid.UUID, stale_before: datetime | None
) -> Invite | None:
    """Take the queued send of an open invite, so no one else sends it: its ``email_at``
    moves to now (the tick only takes stale ones)."""
    stmt = select(Invite).where(
        Invite.id == invite_id,
        Invite.email_status == "queued",
        Invite.accepted_at.is_(None),
        Invite.revoked_at.is_(None),
    )
    if stale_before is not None:
        stmt = stmt.where(Invite.email_at < stale_before)
    invite = await s.scalar(stmt.with_for_update(skip_locked=True))
    if invite is not None:
        invite.email_at = datetime.now(UTC)
        await s.commit()
    return invite


async def _inviter(s: AsyncSession, invited_by: uuid.UUID | None) -> str:
    if invited_by is not None:
        user = await s.get(User, invited_by)
        if user is None:
            token = await s.get(ApiToken, invited_by)
            user = await s.get(User, token.user_id) if token and token.user_id else None
        if user is not None:
            return user.email
    return "An owner"


async def deliver(
    tenant_id: uuid.UUID, invite_id: uuid.UUID, *, stale_before: datetime | None = None
) -> bool:
    """Send the invite's queued email, retrying once; record ``sent`` or ``failed``.
    False when there was nothing to send (not queued, closed, or another sender has it)."""
    async with tenant_session(tenant_id) as s:
        invite = await _claim(s, invite_id, stale_before)
        if invite is None:
            return False
        sender = mailer.get_mailer()
        if sender is None:
            invite.email_status = "not_sent"
            await s.commit()
            return True
        tenant = await s.get(Tenant, tenant_id)
        address, role = invite.email, invite.role
        message = mailer.invite_email(
            to=address,
            company=tenant.name if tenant else "Your company",
            role=role,
            inviter=await _inviter(s, invite.invited_by),
            link=sign_in_url(),
        )
        await s.commit()  # nothing held across the sends

        status, error = "failed", None
        async with httpx.AsyncClient() as http:
            for attempt in (1, 2):
                try:
                    await sender.send(http, message)
                    status, error = "sent", None
                except Exception as exc:
                    error = str(exc)[:MAX_ERROR_CHARS] or type(exc).__name__
                    log.warning("invite email to %s failed (try %d): %s", address, attempt, error)
                await audit.record(
                    s,
                    audit.ORACLE,
                    "invite_email.send",
                    "invite",
                    invite_id,
                    {
                        "email": address,
                        "outcome": status,
                        "attempt": attempt,
                        **({"error": error} if error else {}),
                    },
                )
                await s.commit()
                if status == "sent":
                    break
                if attempt == 1:
                    await asyncio.sleep(get_settings().mail_retry_seconds)

        invite = await s.get(Invite, invite_id, with_for_update=True)
        if invite is not None and invite.email_status == "queued":
            invite.email_status = status
            invite.email_error = error
            invite.email_at = datetime.now(UTC)
        await s.commit()
        return True


async def send_queued(session: AsyncSession, tenant_id: uuid.UUID) -> int:
    """The tick: send the emails a lost process left queued. How many were taken."""
    cutoff = datetime.now(UTC) - STALE_QUEUED
    ids = list(
        await session.scalars(
            select(Invite.id).where(
                Invite.email_status == "queued",
                Invite.email_at < cutoff,
                Invite.accepted_at.is_(None),
                Invite.revoked_at.is_(None),
            )
        )
    )
    await session.rollback()
    taken = 0
    for invite_id in ids:
        if await deliver(tenant_id, invite_id, stale_before=cutoff):
            taken += 1
    return taken
