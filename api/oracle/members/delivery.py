"""An invite reaches the person (#242): its IAP access and its email, and what happened
to each, recorded on the invite for the Members page and in the audit log.

Access: creating an invite grants the invitee IAP's accessor role on Oracle's backend
services (:mod:`oracle.members.iap_access`) after the invite commits, so a failed grant
never loses it: the invite stays ``pending`` with the reason, and Retry
(``POST /v1/invites/{id}/access``) grants again. Revoking an open invite, or removing a
member, takes the binding away unless the person is still an active member or has
another open invite; restoring a member grants it again. A revoke, or a restore's grant,
that fails is owed as a follow-up the tick retries. Changes for one address are
serialised (:func:`lock_address`).

Email: queued with the invite (or Resend) and sent in the background
(:func:`schedule`), never on the request; one retry, then ``failed``. A send a dead
process left queued is picked up by the tick (:func:`send_queued`). With no sender
configured, nothing is sent: ``not_sent``.

Every function here commits: each runs after the request's own change committed.
"""

import asyncio
import hashlib
import logging
import math
import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import ApiToken, User
from oracle.config import get_settings
from oracle.members import iap_access, mailer
from oracle.members.models import Invite, MemberFollowUp
from oracle.models import Tenant
from oracle.tenancy import tenant_session

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

log = logging.getLogger(__name__)

# A queued send older than this was lost with its process: the tick sends it.
STALE_QUEUED = timedelta(minutes=5)
# Resend waits this long after the invite's last send.
RESEND_COOLDOWN = timedelta(seconds=60)
MAX_ERROR_CHARS = 500


def sign_in_url() -> str:
    """Where the invitee signs in: ORACLE_APP_URL, else ORACLE_PUBLIC_URL, plus ``/``."""
    from oracle.swarm.settings import get_runtime_settings

    base = get_settings().app_url or get_runtime_settings().public_url
    return base.rstrip("/") + "/"


def _open(invite: Invite) -> bool:
    return invite.accepted_at is None and invite.revoked_at is None


# --- IAP access ----------------------------------------------------------------------------
#
# Every change to one address's access, and the check of whether the person still needs
# it, runs under a transaction-scoped Postgres advisory lock on that address
# (:func:`lock_address`), held across the check and the IAP calls: a revoke never runs
# during a grant for the same person, nor a grant during a revoke. A change that fails
# is owed as a ``MemberFollowUp`` (``iap_revoke``, ``iap_grant``) the tick retries,
# re-checking first (:func:`follow_up_access`).


def _lock_key(address: str) -> int:
    digest = hashlib.sha256(f"iap-access:{address.strip().lower()}".encode()).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


async def lock_address(session: AsyncSession, address: str) -> None:
    """Serialise IAP access changes for ``address`` until the transaction ends (the IAP
    policies are Oracle-wide, so the lock is not per company)."""
    await session.execute(select(func.pg_advisory_xact_lock(_lock_key(address))))


async def _still_needed(session: AsyncSession, address: str) -> str | None:
    """Why ``address`` keeps its access: an active member, or an open invite; or None."""
    member = await session.scalar(
        select(User.id).where(User.email == address, User.disabled_at.is_(None))
    )
    if member is not None:
        return "an active member"
    invited = await session.scalar(
        select(Invite.id).where(
            Invite.email == address, Invite.accepted_at.is_(None), Invite.revoked_at.is_(None)
        )
    )
    return "another open invite" if invited is not None else None


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


async def _revoke(email: str) -> tuple[str, str | None]:
    """Take ``email``'s access away: (``removed`` | ``failed``, the error)."""
    client = iap_access.get_client()
    if client is None:
        return "failed", "ORACLE_GCP_PROJECT is not set"
    try:
        await iap_access.revoke(client, get_settings().iap_backends, email)
    except iap_access.IapError as exc:
        log.warning("IAP access for %s not removed: %s", email, exc)
        return "failed", str(exc)[:MAX_ERROR_CHARS]
    return "removed", None


def _owe(session: AsyncSession, kind: str, target_id: uuid.UUID, address: str, error) -> None:
    """A failed access change, owed: the tick retries it after the first backoff."""
    from oracle.members.service import follow_up_backoff

    session.add(
        MemberFollowUp(
            member_id=target_id,
            kind=kind,
            target_id=target_id,
            email=address,
            status="pending",
            attempts=1,
            outcome="failed",
            last_error=error,
            next_attempt_at=datetime.now(UTC) + follow_up_backoff(1),
        )
    )


async def _reread(session: AsyncSession, invite_id: uuid.UUID) -> Invite | None:
    return await session.scalar(
        select(Invite).where(Invite.id == invite_id).execution_options(populate_existing=True)
    )


async def grant_invite_access(
    session: AsyncSession, principal: "Principal", invite: Invite
) -> Invite:
    """Grant the invitee IAP access and record the outcome on the invite (commits).
    Under the address's lock; an invite closed meanwhile is left alone, and one closed
    while the grant was under way has the binding taken away again (audited)."""
    invite_id, address = invite.id, invite.email
    await session.rollback()  # no row lock held across the IAP calls
    await lock_address(session, address)
    current = await _reread(session, invite_id)
    if current is None or not _open(current):
        await session.rollback()
        return invite
    outcome, error = await _grant(address)
    current = await _reread(session, invite_id)
    if current is not None and _open(current):
        current.access = outcome
        current.access_error = error
        current.access_at = datetime.now(UTC)
    await audit.record(
        session,
        principal,
        "invite_access.grant",
        "invite",
        invite_id,
        {
            "email": address,
            "outcome": "failed" if outcome == "pending" else outcome,
            "backends": list(get_settings().iap_backends),
            **({"error": error} if error else {}),
        },
    )
    if outcome == "granted" and (current is None or not _open(current)):
        # Closed while Google was granting it: take it away again, unless still needed.
        await _release_one(session, principal, address, invite_id, "invite_access.remove")
    await session.commit()
    return current or invite


async def grant_member_access(session: AsyncSession, principal: "Principal", user: User) -> None:
    """A restored member gets their IAP access back (commits), under the address's lock;
    a failure is audited and owed as an ``iap_grant`` follow-up the tick retries."""
    address, user_id = user.email, user.id
    await session.rollback()
    await lock_address(session, address)
    active = await session.scalar(
        select(User.id).where(User.id == user_id, User.disabled_at.is_(None))
    )
    if active is None:  # removed again meanwhile: that removal took the access
        await session.rollback()
        return
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
    if outcome == "pending":
        _owe(session, "iap_grant", user_id, address, error)
    await session.commit()


async def _release_one(
    session: AsyncSession,
    principal: "Principal | None",
    address: str,
    target_id: uuid.UUID,
    action: str,
) -> None:
    """Under the address's lock (the caller's transaction): take its access away unless
    still needed; audited as ``action``; a failure owed as an ``iap_revoke``."""
    data: dict = {"email": address, "backends": list(get_settings().iap_backends)}
    reason = await _still_needed(session, address)
    if reason is not None:
        data["outcome"], data["reason"] = "kept", reason
    else:
        data["outcome"], error = await _revoke(address)
        if error:
            data["error"] = error
            _owe(session, "iap_revoke", target_id, address, error)
    entity = "invite" if action.startswith("invite") else "user"
    await audit.record(session, principal, action, entity, target_id, data)


async def release_access(
    session: AsyncSession,
    principal: "Principal",
    targets: dict[str, uuid.UUID],
    action: str,
) -> None:
    """Take IAP access away from each address of ``targets`` (address: the invite or the
    member it is for), unless the person is still an active member or has another open
    invite (commits each). Audited as ``action``; a failure is owed as a follow-up the
    tick retries, never raised: the change that called it has committed."""
    if not get_settings().iap_backends:
        return
    for address in sorted(targets):
        await session.rollback()
        await lock_address(session, address)
        await _release_one(session, principal, address, targets[address], action)
        await session.commit()


async def release_disabled(session: AsyncSession, principal: "Principal", user: User) -> None:
    """After a disable commits: the member's access, and that of the open invites the
    disable revoked with it (theirs, and the ones they created)."""
    targets: dict[str, uuid.UUID] = {}
    if user.disabled_at is not None:
        revoked = await session.execute(
            select(Invite.email, Invite.id).where(Invite.revoked_at == user.disabled_at)
        )
        targets.update({address: invite_id for address, invite_id in revoked})
    targets[user.email] = user.id
    await release_access(session, principal, targets, "member_access.remove")


async def follow_up_access(
    session: AsyncSession, row: MemberFollowUp, timed
) -> tuple[bool, str, str | None]:
    """The tick's retry of an owed access change (``oracle.members.service._follow_up``),
    in its transaction, under the address's lock, re-checked first: a revoke of someone
    who needs the access again is ``kept``; a grant for someone removed again is
    ``not_needed``. ``timed()``: the call's deadline. (succeeded, outcome, error)."""
    address = row.email or ""
    if not get_settings().iap_backends:
        return True, "skipped", None
    await lock_address(session, address)
    try:
        if row.kind == "iap_revoke":
            if await _still_needed(session, address) is not None:
                return True, "kept", None
            async with timed():
                outcome, error = await _revoke(address)
            return outcome == "removed", outcome, error
        active = await session.scalar(
            select(User.id).where(User.email == address, User.disabled_at.is_(None))
        )
        if active is None:
            return True, "not_needed", None
        async with timed():
            outcome, error = await _grant(address)
        return outcome == "granted", "granted" if outcome == "granted" else "failed", error
    except TimeoutError:
        return False, "failed", "Google did not answer in time"


async def follow_up_audit(session: AsyncSession, row: MemberFollowUp) -> tuple[str, str]:
    """The audit action and entity of an access follow-up: a member's, or an invite's."""
    verb = "remove" if row.kind == "iap_revoke" else "grant"
    if row.kind == "iap_grant" or await session.get(User, row.member_id) is not None:
        return f"member_access.{verb}", "user"
    return f"invite_access.{verb}", "invite"


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


def resend_wait(invite: Invite) -> int:
    """How many seconds Resend still waits: the invite's email went out (``email_at``)
    under :data:`RESEND_COOLDOWN` ago; 0 when it may send now (a failed send may be
    resent at once: nothing reached the person)."""
    if invite.email_at is None or invite.email_status != "sent":
        return 0
    left = RESEND_COOLDOWN - (datetime.now(UTC) - invite.email_at)
    return max(0, math.ceil(left.total_seconds()))


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
                    # Only Oracle's own short reason, never a body from Google.
                    error = (
                        str(exc)[:MAX_ERROR_CHARS] if isinstance(exc, mailer.MailError) else ""
                    ) or type(exc).__name__
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
