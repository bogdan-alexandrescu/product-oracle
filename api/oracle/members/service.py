"""Members (users of one company's Oracle) and invites. Functions flush, never commit;
the router commits once per request. Every change writes an audit event."""

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes
from oracle.auth.models import ROLES, Role, User
from oracle.members.models import Invite
from oracle.members.schemas import InviteOut, InviteStatus
from oracle.tenant_settings import TenantSetting

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

IAP_DEFAULT_ROLE_KEY = "iap_default_role"
FALLBACK_IAP_ROLE: Role = "commenter"


class MemberError(Exception):
    """A request the members service refuses; the router maps ``kind`` to an HTTP status."""

    def __init__(self, kind: str, message: str):
        self.kind = kind  # "not_found" | "conflict"
        self.message = message
        super().__init__(message)


def invite_status(invite: Invite) -> InviteStatus:
    if invite.revoked_at is not None:
        return "revoked"
    if invite.accepted_at is not None:
        return "accepted"
    return "open"


def invite_out(invite: Invite) -> InviteOut:
    return InviteOut(
        id=invite.id,
        email=invite.email,
        role=invite.role,
        status=invite_status(invite),
        invited_by=invite.invited_by,
        created_at=invite.created_at,
        accepted_at=invite.accepted_at,
        revoked_at=invite.revoked_at,
    )


def _open() -> list:
    return [Invite.accepted_at.is_(None), Invite.revoked_at.is_(None)]


# --- Members -----------------------------------------------------------------------------


async def list_members(session: AsyncSession) -> list[User]:
    return list((await session.scalars(select(User).order_by(User.created_at, User.email))).all())


async def set_role(
    session: AsyncSession, principal: "Principal", user_id: uuid.UUID, role: Role
) -> User:
    """Change a member's role. The last owner cannot be demoted."""
    user = await session.get(User, user_id)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if user.role == role:
        return user
    if user.role == "owner":
        # Lock every owner row so two concurrent demotions cannot both see "another owner".
        owners = (
            await session.scalars(select(User.id).where(User.role == "owner").with_for_update())
        ).all()
        if len(owners) <= 1:
            raise MemberError("conflict", "Cannot demote the last owner; make someone else owner")
    before = user.role
    user.role = role
    await session.flush()
    await audit.record(
        session, principal, "member.role", "user", user.id, {"before": before, "after": role}
    )
    # Review gates read approvers' current roles; the change event tells every lane.
    await changes.record_change(
        session,
        "member",
        cause="role_changed",
        actor=principal,
        subject_id=user.id,
        subject_ref=f"member:{user.id}",
        data={"before": before, "after": role},
    )
    return user


async def remove_member(session: AsyncSession, principal: "Principal", user_id: uuid.UUID) -> None:
    """Remove a member: their user row goes, and with it their sessions, API tokens,
    connections and sources. Each source first gets a ``source_permission`` revocation
    (oracle.review.publish), so documents citing it cannot publish. Their verdicts and
    approvals stay in the history but no longer count (oracle.review.state.standing).
    The last owner cannot be removed."""
    from oracle.review.publish import record_source_revocation
    from oracle.sources.models import Source

    user = await session.get(User, user_id, with_for_update=True)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if user.role == "owner":
        owners = (
            await session.scalars(select(User.id).where(User.role == "owner").with_for_update())
        ).all()
        if len(owners) <= 1:
            raise MemberError("conflict", "Cannot remove the last owner; make someone else owner")
    sources = list(await session.scalars(select(Source).where(Source.owner_user_id == user.id)))
    await record_source_revocation(session, principal, sources, "source_deleted", drop_links=True)
    await audit.record(
        session,
        principal,
        "member.remove",
        "user",
        user.id,
        {"email": user.email, "role": user.role, "sources": [str(x.id) for x in sources]},
    )
    await changes.record_change(
        session,
        "member",
        cause="member_removed",
        actor=principal,
        subject_id=user.id,
        subject_ref=f"member:{user.id}",
        data={"before": user.role, "after": None},
    )
    await session.delete(user)
    await session.flush()


# --- Invites -----------------------------------------------------------------------------


async def list_invites(session: AsyncSession, status: str) -> list[Invite]:
    """Invites with ``status`` (open / accepted / revoked), or every invite for ``all``."""
    stmt = select(Invite).order_by(Invite.created_at.desc())
    if status == "open":
        stmt = stmt.where(*_open())
    elif status == "accepted":
        stmt = stmt.where(Invite.accepted_at.is_not(None))
    elif status == "revoked":
        stmt = stmt.where(Invite.revoked_at.is_not(None))
    return list((await session.scalars(stmt)).all())


async def create_invite(
    session: AsyncSession, principal: "Principal", email: str, role: Role
) -> Invite:
    if await session.scalar(select(User.id).where(User.email == email)) is not None:
        raise MemberError("conflict", f"{email} is already a member")
    if await session.scalar(select(Invite.id).where(Invite.email == email, *_open())) is not None:
        raise MemberError("conflict", f"{email} already has an open invite; revoke it first")
    invite = Invite(email=email, role=role, invited_by=principal.id)
    session.add(invite)
    try:
        await session.flush()
    except IntegrityError:
        # A concurrent request invited the same email first; nothing is committed.
        raise MemberError("conflict", f"{email} already has an open invite") from None
    await audit.record(
        session, principal, "invite.create", "invite", invite.id, {"email": email, "role": role}
    )
    return invite


async def revoke_invite(
    session: AsyncSession, principal: "Principal", invite_id: uuid.UUID
) -> Invite:
    invite = await session.get(Invite, invite_id, with_for_update=True)
    if invite is None:
        raise MemberError("not_found", f"Invite {invite_id} not found")
    if invite.accepted_at is not None:
        raise MemberError("conflict", "This invite was already accepted; change the role instead")
    if invite.revoked_at is None:
        invite.revoked_at = datetime.now(UTC)
        await session.flush()
        await audit.record(
            session, principal, "invite.revoke", "invite", invite.id, {"email": invite.email}
        )
    return invite


# --- Sign-in provisioning ----------------------------------------------------------------


async def iap_default_role(session: AsyncSession) -> Role:
    """The company's ``iap_default_role`` setting; commenter when unset or not a role."""
    value = await session.scalar(
        select(TenantSetting.value).where(TenantSetting.key == IAP_DEFAULT_ROLE_KEY)
    )
    return value if value in ROLES else FALLBACK_IAP_ROLE


async def claim_open_invite(session: AsyncSession, email: str) -> Invite | None:
    """Lock and mark accepted the open invite for ``email``, if any (caller commits)."""
    invite = await session.scalar(
        select(Invite).where(Invite.email == email, *_open()).with_for_update()
    )
    if invite is not None:
        invite.accepted_at = datetime.now(UTC)
    return invite
