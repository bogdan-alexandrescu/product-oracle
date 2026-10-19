"""Members (users of one company's Oracle) and invites. Functions flush, never commit;
the router commits once per request. Every change writes an audit event."""

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes
from oracle.auth.models import ROLES, ApiToken, Role, User
from oracle.members.models import Invite
from oracle.members.schemas import InviteOut, InviteStatus
from oracle.tenant_settings import TenantSetting

if TYPE_CHECKING:
    import httpx

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
    """Every member, disabled ones included (history keeps their name)."""
    return list((await session.scalars(select(User).order_by(User.created_at, User.email))).all())


async def _other_active_owner(session: AsyncSession, user_id: uuid.UUID) -> bool:
    """Whether an active owner other than ``user_id`` exists. Locks every owner row so
    two concurrent demotions or disables cannot both see "another owner"."""
    owners = (
        await session.execute(
            select(User.id, User.disabled_at).where(User.role == "owner").with_for_update()
        )
    ).all()
    return any(i != user_id and disabled is None for i, disabled in owners)


async def _gate(session: AsyncSession) -> None:
    # The review gate reads approvers' roles and standing: a change to them never lands
    # while a publish renders (oracle.review.publish.gate_lock).
    from oracle.review import publish

    await publish.gate_lock(session, shared=False)


async def set_role(
    session: AsyncSession, principal: "Principal", user_id: uuid.UUID, role: Role
) -> User:
    """Change a member's role. The last active owner cannot be demoted. A demotion below
    approver lapses the member's approvals for good, in this transaction (C2): a later
    promotion never revives them."""
    from oracle.authz import has_role
    from oracle.review.state import lapse_approvals

    await _gate(session)
    user = await session.get(User, user_id, with_for_update=True)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if user.role == role:
        return user
    if user.role == "owner" and user.disabled_at is None:
        if not await _other_active_owner(session, user.id):
            raise MemberError("conflict", "Cannot demote the last owner; make someone else owner")
    before = user.role
    user.role = role
    await session.flush()
    await audit.record(
        session, principal, "member.role", "user", user.id, {"before": before, "after": role}
    )
    if has_role(before, "approver") and not has_role(role, "approver"):
        await lapse_approvals(
            session, principal, reviewer_id=user.id, reason=f"approver demoted to {role}"
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


async def disable_member(
    session: AsyncSession, principal: "Principal", user_id: uuid.UUID, http: "httpx.AsyncClient"
) -> User:
    """Remove a member by disabling them (C2). The user row stays, so every ``*_by``
    reference and the verdict history keep the name; no sign-in path accepts them
    (``oracle.auth.service.may_sign_in``). In this transaction:

    - each connection is disconnected the normal way: revoked at the provider (best
      effort), a ``connection.disconnect`` audit, a ``source_permission`` revocation for
      each source it synced, Oracle's copy of the credential deleted;
    - every other source of theirs gets a ``source_permission`` revocation, so documents
      citing it cannot publish; all their sources are paused;
    - their API tokens and OAuth grants are revoked, their unfinished runs cancelled
      (with the runs' tokens), the open invite for their email revoked;
    - their approvals lapse for good (``oracle.review.state.lapse_approvals``).

    Disabling a disabled member is a no-op. The last active owner cannot be disabled.
    :func:`restore_member` re-enables sign-in only."""
    from oracle.connections.models import Connection
    from oracle.connections.service import revoke_at_provider
    from oracle.mcp.oauth.models import OAuthToken
    from oracle.review.publish import record_source_revocation
    from oracle.review.state import lapse_approvals
    from oracle.runs.models import Run
    from oracle.runs.service import FINAL, stop_run
    from oracle.sources.models import Source

    await _gate(session)
    user = await session.get(User, user_id, with_for_update=True)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if user.disabled_at is not None:
        return user
    if user.role == "owner" and not await _other_active_owner(session, user.id):
        raise MemberError("conflict", "Cannot remove the last owner; make someone else owner")
    at = datetime.now(UTC)
    via = {"via": "member.disable", "member_id": str(user.id)}

    connections = list(
        await session.scalars(
            select(Connection).where(Connection.user_id == user.id).with_for_update()
        )
    )
    revoked_ids: set[uuid.UUID] = set()
    for conn in connections:
        revoked = await revoke_at_provider(http, conn)
        await audit.record(
            session, principal, "connection.disconnect", "connection", conn.id,
            {"provider": conn.provider, "account": conn.account_label,
             "provider_revoke": revoked, **via},
        )  # fmt: skip
        synced = list(await session.scalars(select(Source).where(Source.connection_id == conn.id)))
        revoked_ids |= {x.id for x in synced}
        await record_source_revocation(
            session, principal, synced, "connection_revoked", drop_links=False
        )
        await session.delete(conn)
    await session.flush()
    sources = list(await session.scalars(select(Source).where(Source.owner_user_id == user.id)))
    rest = [x for x in sources if x.id not in revoked_ids]
    await record_source_revocation(session, principal, rest, "source_revoked", drop_links=False)
    for source in sources:
        source.status = "paused"
        source.last_error = "Its owner was removed from this company"

    tokens = list(
        await session.scalars(
            select(ApiToken).where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
        )
    )
    for token in tokens:
        token.revoked_at = at
    await session.execute(
        update(OAuthToken)
        .where(OAuthToken.user_id == user.id, OAuthToken.revoked_at.is_(None))
        .values(revoked_at=at)
        .execution_options(synchronize_session=False)
    )
    runs = list(
        await session.scalars(
            select(Run).where(Run.created_by == user.id, Run.status.not_in(FINAL)).with_for_update()
        )
    )
    for run in runs:
        await stop_run(session, principal, run, via)
    invites = list(
        await session.scalars(select(Invite).where(Invite.email == user.email, *_open()))
    )
    for invite in invites:
        invite.revoked_at = at
        await audit.record(
            session, principal, "invite.revoke", "invite", invite.id, {"email": invite.email, **via}
        )
    lapsed = await lapse_approvals(
        session, principal, reviewer_id=user.id, reason="member was removed (disabled)"
    )

    user.disabled_at = at
    user.disabled_by = principal.id
    await session.flush()
    await audit.record(
        session,
        principal,
        "member.disable",
        "user",
        user.id,
        {
            "email": user.email,
            "role": user.role,
            "sources": [str(x.id) for x in sources],
            "connections": [str(c.id) for c in connections],
            "api_tokens": [str(t.id) for t in tokens],
            "runs": [str(r.id) for r in runs],
            **lapsed,
        },
    )
    await changes.record_change(
        session,
        "member",
        cause="member_disabled",
        actor=principal,
        subject_id=user.id,
        subject_ref=f"member:{user.id}",
        data={"role": user.role},
    )
    return user


async def restore_member(session: AsyncSession, principal: "Principal", user_id: uuid.UUID) -> User:
    """Re-enable a disabled member's sign-in, with the role they had. Nothing else comes
    back: their approvals stay lapsed, their tokens revoked, their connections gone and
    their sources revoked (they reconnect and approve again). A no-op for an active
    member."""
    await _gate(session)
    user = await session.get(User, user_id, with_for_update=True)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if user.disabled_at is None:
        return user
    disabled_at = user.disabled_at
    user.disabled_at = None
    user.disabled_by = None
    await session.flush()
    await audit.record(
        session,
        principal,
        "member.restore",
        "user",
        user.id,
        {"email": user.email, "role": user.role, "disabled_at": disabled_at.isoformat()},
    )
    await changes.record_change(
        session,
        "member",
        cause="member_restored",
        actor=principal,
        subject_id=user.id,
        subject_ref=f"member:{user.id}",
        data={"role": user.role},
    )
    return user


# --- API tokens --------------------------------------------------------------------------


async def list_api_tokens(session: AsyncSession) -> list[ApiToken]:
    return list(await session.scalars(select(ApiToken).order_by(ApiToken.created_at)))


async def revoke_api_token(
    session: AsyncSession, principal: "Principal", token_id: uuid.UUID
) -> ApiToken:
    """Revoke an API token; the approvals given through it lapse for good (C2), the
    approvals its user gave in person stand. Revoking twice is a no-op."""
    from oracle.review.state import lapse_approvals

    await _gate(session)
    token = await session.get(ApiToken, token_id, with_for_update=True)
    if token is None:
        raise MemberError("not_found", f"API token {token_id} not found")
    if token.revoked_at is not None:
        return token
    token.revoked_at = datetime.now(UTC)
    await session.flush()
    lapsed = await lapse_approvals(
        session, principal, token_id=token.id, reason=f"API token {token.name!r} was revoked"
    )
    await audit.record(
        session,
        principal,
        "api_token.revoke",
        "api_token",
        token.id,
        {"name": token.name, "user_id": str(token.user_id) if token.user_id else None, **lapsed},
    )
    return token


async def token_approvals(
    session: AsyncSession, token_id: uuid.UUID
) -> list[dict[str, object]] | None:
    """Every approval given through an API token (section verdicts and version
    approvals), lapsed ones included; ``None`` for an unknown token."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.review.models import SectionReview

    if await session.get(ApiToken, token_id) is None:
        return None
    out: list[dict[str, object]] = []
    rows = (
        await session.execute(
            select(SectionReview, DocumentVersion.number, Document.slug)
            .join(DocumentVersion, DocumentVersion.id == SectionReview.version_id)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(
                SectionReview.verdict == "approved",
                or_(SectionReview.token_id == token_id, SectionReview.reviewer_id == token_id),
            )
            .order_by(SectionReview.created_at, SectionReview.id)
        )
    ).all()
    for review, number, slug in rows:
        out.append(
            {
                "kind": "section",
                "document": slug,
                "version": number,
                "section_key": review.section_key,
                "review_id": review.id,
                "approver_id": review.reviewer_id,
                "approved_at": review.created_at,
                "lapsed_at": review.lapsed_at,
                "lapse_reason": review.lapse_reason,
            }
        )
    who = or_(
        DocumentVersion.approved_token_id == token_id, DocumentVersion.approved_by == token_id
    )
    # A lapsed version approval keeps its token (approved_token_id), and a user-less
    # token's lapsed approval names it as the approver it was.
    lapsed_who = DocumentVersion.approval_lapsed_by == token_id
    for version, slug in (
        await session.execute(
            select(DocumentVersion, Document.slug)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(or_(who, lapsed_who))
            .order_by(DocumentVersion.created_at)
        )
    ).all():
        out.append(
            {
                "kind": "version",
                "document": slug,
                "version": version.number,
                "section_key": None,
                "review_id": None,
                "approver_id": version.approved_by or version.approval_lapsed_by,
                "approved_at": version.approved_at,
                "lapsed_at": version.approval_lapsed_at if version.approved_at is None else None,
                "lapse_reason": version.approval_lapse_reason
                if version.approved_at is None
                else None,
            }
        )
    return out


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
    member = await session.scalar(select(User).where(User.email == email))
    if member is not None and member.disabled_at is not None:
        raise MemberError("conflict", f"{email} is a removed member; restore them instead")
    if member is not None:
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
