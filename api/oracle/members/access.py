"""Who becomes a member through Google sign-in, and access requests (A5).

An uninvited person from the company's email domains (:func:`sign_in_domains`) who signs
in with Google is let in, asked to wait or refused by the company's
``sign_in_without_invite`` rule: ``request`` (an owner, or an approver for viewers and
commenters, approves first: an :class:`AccessRequest` row), ``join`` (at once, with the
default role; the default until the /access page exists) or ``refuse`` (invite only).
Functions flush, never commit, except :func:`touch_request`, which the sign-in path calls
in its own session.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes
from oracle.auth.models import ROLES, Role, User
from oracle.config import get_settings
from oracle.members.models import INVITE_TTL, AccessRequest, Invite

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

SIGN_IN_RULE_KEY = "sign_in_without_invite"
SIGN_IN_RULES = ("request", "join", "refuse")
SignInRule = Literal["request", "join", "refuse"]
# The default role of an approved request and of anyone who joins at once.
DEFAULT_ROLE_CHOICES: tuple[Role, ...] = ("viewer", "commenter")
APPROVER_INVITE_ROLES: tuple[Role, ...] = ("viewer", "commenter")
# A refused sign-in touches its pending request at most this often.
SEEN_RESOLUTION = timedelta(minutes=10)

AccessState = Literal[
    "member",
    "pending",
    "approved",
    "declined",
    "invite_expired",
    "invite_only",
    "outside_domains",
    "removed",
    "no_google_sign_in",
]


@dataclass(frozen=True)
class Refused:
    """Why a verified Google sign-in did not sign anyone in (``GET /v1/auth/access``)."""

    state: AccessState


class AccessError(Exception):
    def __init__(self, kind: str, message: str):
        self.kind = kind  # "not_found" | "conflict" | "forbidden"
        self.message = message
        super().__init__(message)


def invite_roles(principal: "Principal") -> tuple[Role, ...]:
    """The roles ``principal`` may invite people with and approve access requests as:
    owners any, approvers viewer and commenter, others none (A5 "Who invites")."""
    return () if principal.is_run else roles_for(principal.role)


async def preset_role(session: AsyncSession, principal: "Principal") -> Role | None:
    """The role an approve control starts on: the company's stored default role when the
    caller may approve as it, else the least they may (None: they approve nothing)."""
    from oracle.members.service import iap_default_role

    roles = invite_roles(principal)
    if not roles:
        return None
    default = await iap_default_role(session)
    return default if default in roles else roles[0]


def least_inviter(role: Role, engineering_lead: bool = False) -> Role:
    """The least role that may invite with ``role`` (and name an engineering lead): what the
    caller is re-read against under the gate, so one demoted while waiting is refused."""
    return "approver" if role in APPROVER_INVITE_ROLES and not engineering_lead else "owner"


def roles_for(role: str) -> tuple[Role, ...]:
    if role == "owner":
        return ROLES  # type: ignore[return-value]
    if role == "approver":
        return APPROVER_INVITE_ROLES
    return ()


async def sign_in_rule(session: AsyncSession) -> SignInRule:
    from oracle.tenant_settings_api import get_setting

    value = await get_setting(session, SIGN_IN_RULE_KEY)
    return value if value in SIGN_IN_RULES else "join"


async def domain_sources(session: AsyncSession) -> list[tuple[str, str]]:
    """(domain, where it is set): ``deployment`` (ORACLE_IAP_ALLOWED_DOMAINS) first, then
    the owner's ``company_email_domains`` (``settings``). Never inferred."""
    from oracle.tenant_settings_api import get_setting

    out: dict[str, str] = {}
    for d in get_settings().iap_allowed_domains:
        d = d.strip().lower().lstrip("@")
        if d:
            out.setdefault(d, "deployment")
    for d in await get_setting(session, "company_email_domains"):
        d = str(d).strip().lower()
        if d:
            out.setdefault(d, "settings")
    return list(out.items())


async def sign_in_domains(session: AsyncSession) -> set[str]:
    """The company's email domains that may ask to join or join (decision S5's one list:
    the deployment's and the owner's setting; ORACLE_INFER_COMPANY_DOMAINS never applies)."""
    return {d for d, _ in await domain_sources(session)}


def _expired(invite: Invite, now: datetime) -> bool:
    return invite.expires_at <= now


async def _latest_request(session: AsyncSession, email: str) -> AccessRequest | None:
    return await session.scalar(
        select(AccessRequest)
        .where(AccessRequest.email == email)
        .order_by(AccessRequest.created_at.desc())
        .limit(1)
    )


async def close_pending(session: AsyncSession, email: str) -> None:
    """They became a member another way: their pending request is closed."""
    await session.execute(
        update(AccessRequest)
        .where(AccessRequest.email == email, AccessRequest.status == "pending")
        .values(status="closed", decided_at=datetime.now(UTC))
    )


async def touch_request(session: AsyncSession, email: str) -> None:
    """Record a refused sign-in under ``request``: the pending row, created on the first
    one (audited, a ``member`` change event), its ``last_seen_at`` touched at most every
    10 minutes. Commits."""
    now = datetime.now(UTC)
    row = await session.scalar(
        select(AccessRequest).where(AccessRequest.email == email, AccessRequest.status == "pending")
    )
    if row is not None:
        if now - row.last_seen_at >= SEEN_RESOLUTION:
            row.last_seen_at = now
            await session.commit()
        return
    row = AccessRequest(email=email, status="pending", last_seen_at=now)
    session.add(row)
    try:
        await session.flush()
    except IntegrityError:
        # A concurrent sign-in asked first; theirs is the row.
        await session.rollback()
        return
    await audit.record(session, None, "access_request.create", "access_request", row.id,
                       {"email": email})  # fmt: skip
    await changes.record_change(
        session,
        "member",
        cause="access_requested",
        actor=None,
        subject_id=row.id,
        subject_ref=f"access_request:{row.id}",
        data={"email": email},
    )
    await session.commit()


async def state_for(session: AsyncSession, email: str) -> tuple[AccessState, dict[str, Any]]:
    """What a sign-in with ``email`` gets now, without creating anything (the rules of
    ``oracle.auth.iap.sign_in``, in its order)."""
    settings = get_settings()
    user = await session.scalar(select(User).where(User.email == email))
    if user is not None:
        return ("removed" if user.disabled_at is not None else "member"), {}
    if not settings.iap_auto_provision:
        return "invite_only", {}
    if email.rpartition("@")[2] not in await sign_in_domains(session):
        return "outside_domains", {}
    now = datetime.now(UTC)
    invite = await session.scalar(
        select(Invite).where(
            Invite.email == email, Invite.accepted_at.is_(None), Invite.revoked_at.is_(None)
        )
    )
    if invite is not None and not _expired(invite, now):
        return "approved", {}
    if invite is not None:
        return "invite_expired", {"invite_expired_at": invite.expires_at}
    rule = await sign_in_rule(session)
    if rule == "join":
        return "approved", {}
    if rule == "refuse":
        return "invite_only", {}
    latest = await _latest_request(session, email)
    if latest is not None and latest.status == "declined":
        return "declined", {"requested_at": latest.created_at, "note": latest.note}
    if latest is not None and latest.status == "pending":
        return "pending", {"requested_at": latest.created_at, "note": latest.note}
    return "pending", {}


async def set_note(session: AsyncSession, email: str, note: str | None) -> AccessRequest:
    row = await session.scalar(
        select(AccessRequest)
        .where(AccessRequest.email == email, AccessRequest.status == "pending")
        .with_for_update()
    )
    if row is None:
        raise AccessError("conflict", "You have no pending access request")
    row.note = note
    await session.flush()
    return row


# --- Owners' and approvers' side ----------------------------------------------------------


async def list_requests(session: AsyncSession, status: str) -> list[AccessRequest]:
    stmt = select(AccessRequest).order_by(AccessRequest.created_at.desc())
    if status != "all":
        stmt = stmt.where(AccessRequest.status == status)
    return list((await session.scalars(stmt)).all())


async def _locked(session: AsyncSession, request_id: uuid.UUID) -> AccessRequest:
    row = await session.get(AccessRequest, request_id, with_for_update=True)
    if row is None:
        raise AccessError("not_found", f"Access request {request_id} not found")
    return row


def _check_role(principal: "Principal", role: Role) -> None:
    if role not in invite_roles(principal):
        raise AccessError(
            "forbidden",
            "Approvers invite viewers and commenters. Ask an owner to invite an approver.",
        )


async def _gate(session: AsyncSession, principal: "Principal", role: Role = "approver") -> None:
    from oracle.members.service import MemberError, _gate

    try:
        await _gate(session, principal, shared=True, role=role)
    except MemberError as e:
        raise AccessError(e.kind, e.message) from None


async def approve(
    session: AsyncSession,
    principal: "Principal",
    request_id: uuid.UUID,
    role: Role,
    name: str | None,
) -> AccessRequest:
    """Make an open invite for the request's email (the caller's ``invite_roles`` only)."""
    _check_role(principal, role)
    await _gate(session, principal, least_inviter(role))
    row = await _locked(session, request_id)
    if row.status != "pending":
        raise AccessError("conflict", f"This request was already {row.status}")
    now = datetime.now(UTC)
    if await session.scalar(select(User.id).where(User.email == row.email)) is not None:
        row.status, row.decided_at = "closed", now
        await session.flush()
        raise AccessError("conflict", f"{row.email} is already a member")
    open_invite = await session.scalar(
        select(Invite).where(
            Invite.email == row.email, Invite.accepted_at.is_(None), Invite.revoked_at.is_(None)
        )
    )
    if open_invite is not None:
        raise AccessError("conflict", f"{row.email} already has an open invite")
    invite = Invite(
        email=row.email,
        role=role,
        name=name,
        invited_by=principal.id,
        access_request_id=row.id,
        expires_at=now + INVITE_TTL,
    )
    session.add(invite)
    await session.flush()
    row.status, row.role, row.invite_id = "approved", role, invite.id
    row.decided_by, row.decided_at = principal.id, now
    await session.flush()
    await audit.record(session, principal, "access_request.approve", "access_request", row.id,
                       {"email": row.email, "role": role, "invite_id": str(invite.id)})  # fmt: skip
    data: dict[str, Any] = {"email": row.email, "role": role, "access_request_id": str(row.id)}
    if name:
        data["name"] = name
    await audit.record(session, principal, "invite.create", "invite", invite.id, data)
    return row


async def decline(
    session: AsyncSession, principal: "Principal", request_id: uuid.UUID
) -> AccessRequest:
    await _gate(session, principal)
    row = await _locked(session, request_id)
    if row.status != "pending":
        raise AccessError("conflict", f"This request was already {row.status}")
    row.status, row.decided_by, row.decided_at = "declined", principal.id, datetime.now(UTC)
    await session.flush()
    await audit.record(session, principal, "access_request.decline", "access_request", row.id,
                       {"email": row.email})  # fmt: skip
    return row


async def reopen(
    session: AsyncSession, principal: "Principal", request_id: uuid.UUID
) -> AccessRequest:
    """Undo: a declined request, or an approved one whose invite is unclaimed (revoked
    now), back to pending. Approvers revoke only the invites they sent."""
    from oracle.auth.service import caller_refusal

    await _gate(session, principal)
    row = await _locked(session, request_id)
    invite = (
        await session.get(Invite, row.invite_id, with_for_update=True) if row.invite_id else None
    )
    if row.status == "approved":
        if invite is not None and invite.accepted_at is not None:
            raise AccessError("conflict", f"{row.email} already signed in with that invite")
        if invite is not None and invite.revoked_at is None:
            # Approvers revoke only the invites they sent (as DELETE /v1/invites/{id}); another
            # person's takes an owner, re-read under the gate (one demoted while waiting is
            # refused).
            if invite.invited_by != principal.id:
                refusal = (
                    "Another person approved this request; ask an owner to undo it"
                    if principal.role != "owner"
                    else await caller_refusal(session, principal, "owner")
                )
                if refusal is not None:
                    raise AccessError("forbidden", refusal)
            invite.revoked_at = datetime.now(UTC)
            await audit.record(session, principal, "invite.revoke", "invite", invite.id,
                               {"email": invite.email})  # fmt: skip
    elif row.status != "declined":
        raise AccessError("conflict", f"This request is {row.status}")
    pending = await session.scalar(
        select(AccessRequest.id).where(
            AccessRequest.email == row.email,
            AccessRequest.status == "pending",
            AccessRequest.id != row.id,
        )
    )
    if pending is not None:
        raise AccessError("conflict", f"{row.email} has asked again; act on that request")
    row.status, row.role, row.invite_id = "pending", None, None
    row.decided_by = row.decided_at = None
    await session.flush()
    await audit.record(session, principal, "access_request.reopen", "access_request", row.id,
                       {"email": row.email})  # fmt: skip
    return row
