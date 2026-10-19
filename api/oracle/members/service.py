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
from oracle.members.models import Invite, MemberFollowUp
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
        self.kind = kind  # "not_found" | "conflict" | "forbidden"
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


async def _gate(session: AsyncSession, principal: "Principal", *, shared: bool = False) -> None:
    """Take the review gate, then re-read the caller under it.

    The gate reads approvers' roles and standing: a change to them never lands while
    a publish renders (oracle.review.publish.gate_lock); member changes take it
    exclusively, invites shared. The caller authenticated before waiting on it, and a
    disable, a demotion or a revocation may have committed meanwhile (an owner being
    disabled must not act with a request already in flight): they must still be an
    active owner, through an active token or grant, now."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    await publish.gate_lock(session, shared=shared)
    refusal = await caller_refusal(session, principal, "owner")
    if refusal is not None:
        raise MemberError("forbidden", refusal)


async def set_role(
    session: AsyncSession, principal: "Principal", user_id: uuid.UUID, role: Role
) -> User:
    """Change a member's role. The last active owner cannot be demoted. A demotion below
    approver lapses the member's approvals for good, in this transaction (C2): a later
    promotion never revives them."""
    from oracle.authz import has_role
    from oracle.review.state import lapse_approvals

    await _gate(session, principal)
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


async def disable_member(session: AsyncSession, principal: "Principal", user_id: uuid.UUID) -> User:
    """Remove a member by disabling them (C2). The user row stays, so every ``*_by``
    reference and the verdict history keep the name; no sign-in path accepts them
    (``oracle.auth.service.may_sign_in``) and every session signed so far is dead
    (``sessions_valid_after``). In this transaction:

    - each connection is disconnected: a ``connection.disconnect`` audit, a
      ``source_permission`` revocation for each source it synced, Oracle's copy of the
      credential deleted; the revoke at the provider is a follow-up (below);
    - every other source of theirs gets a ``source_permission`` revocation, so documents
      citing them cannot publish; all their sources are paused;
    - their API tokens and OAuth grants are revoked, their unfinished runs cancelled
      (with the runs' tokens; the cancel at the runtime is a follow-up), the open
      invite for their email revoked;
    - their approvals lapse for good (``oracle.review.state.lapse_approvals``).

    No network call is made here: the review gate is company-wide, and publishes and
    verdicts wait on it. The calls a disable owes are recorded as
    :class:`MemberFollowUp` rows; the caller commits, then runs them
    (:func:`after_disable`), and the tick retries the ones that failed.

    Disabling a disabled member is a no-op. The last active owner cannot be disabled.
    :func:`restore_member` re-enables sign-in only."""
    from oracle.mcp.oauth.models import OAuthToken
    from oracle.review.publish import record_source_revocation
    from oracle.review.state import lapse_approvals
    from oracle.runs.models import Run
    from oracle.runs.service import FINAL, stop_run
    from oracle.sources.models import Source

    await _gate(session, principal)
    user = await session.get(User, user_id, with_for_update=True)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if user.disabled_at is not None:
        return user
    if user.role == "owner" and not await _other_active_owner(session, user.id):
        raise MemberError("conflict", "Cannot remove the last owner; make someone else owner")
    at = datetime.now(UTC)
    via = {"via": "member.disable", "member_id": str(user.id)}

    connections, revoked_ids = await _disconnect_all(session, principal, user, via)
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
    # Revoked earlier: they still name what they did for the member.
    tokens_ever = set(await session.scalars(select(ApiToken.id).where(ApiToken.user_id == user.id)))
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
    segments: list = []
    for run in runs:
        await stop_run(session, principal, run, via, deferred=segments)
    for segment in segments:
        session.add(
            MemberFollowUp(
                member_id=user.id,
                kind="run_cancel",
                target_id=segment.id,
                workflow_id=segment.swarm_workflow_id,
            )
        )
    # Their identities: the user, and the API tokens that acted for them.
    acted_as = {user.id, *tokens_ever}
    # The open invite for their email, and every open invite they created.
    invites = list(
        await session.scalars(
            select(Invite).where(
                or_(Invite.email == user.email, Invite.invited_by.in_(acted_as)), *_open()
            )
        )
    )
    for invite in invites:
        invite.revoked_at = at
        await audit.record(
            session, principal, "invite.revoke", "invite", invite.id, {"email": invite.email, **via}
        )
    jobs = await _cancel_llm_jobs(session, acted_as, at)
    voided = await _void_spend_approvals(session, principal, acted_as, user.id, via)
    lapsed = await lapse_approvals(
        session, principal, reviewer_id=user.id, reason="member was removed (disabled)"
    )

    user.disabled_at = at
    user.disabled_by = principal.id
    # Every session signed so far ends here (a restore never revives one).
    user.sessions_valid_after = at
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
            "invites": [str(i.id) for i in invites],
            "llm_jobs": [str(j) for j in jobs],
            "run_approvals_voided": [str(r) for r in voided],
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


async def _cancel_llm_jobs(
    session: AsyncSession, requesters: set[uuid.UUID], at: datetime
) -> list[uuid.UUID]:
    """Cancel the queued built-in model jobs the removed member requested: nothing more
    is spent for them. A job already running finishes (its call is under way)."""
    from oracle.jobs.models import LlmJob

    jobs = list(
        await session.scalars(
            select(LlmJob)
            .where(LlmJob.status == "queued", LlmJob.requested_by.in_(requesters))
            .with_for_update(skip_locked=True)
        )
    )
    for job in jobs:
        job.status = "cancelled"
        job.error = "Its requester was removed from this company"
        job.finished_at = at
    return [j.id for j in jobs]


async def _void_spend_approvals(
    session: AsyncSession,
    principal: "Principal",
    approvers: set[uuid.UUID],
    member_id: uuid.UUID,
    via: dict[str, str],
) -> list[uuid.UUID]:
    """A spend approval the removed member gave on someone else's run that has not
    started (no segment ever ran) is void: the run waits for an approval again. A run
    that started keeps its approval and its ceiling. Their own runs are cancelled."""
    from oracle.runs.models import Run, RunSegment
    from oracle.runs.service import FINAL
    from oracle.runtokens import revoke_run_tokens

    started = select(RunSegment.id).where(
        RunSegment.run_id == Run.id,
        or_(RunSegment.started_at.is_not(None), RunSegment.swarm_workflow_id.is_not(None)),
    )
    runs = list(
        await session.scalars(
            select(Run)
            .where(
                Run.approved_by.in_(approvers),
                Run.status.not_in(FINAL),
                Run.created_by.is_distinct_from(member_id),
                ~started.exists(),
            )
            .with_for_update()
        )
    )
    for run in runs:
        approved_by = run.approved_by
        run.status = "awaiting_approval"
        run.approved_by = None
        run.approved_at = None
        await revoke_run_tokens(session, run.id)
        await audit.record(
            session, principal, "run.approval_voided", "run", run.id,
            {"approved_by": str(approved_by), **via},
        )  # fmt: skip
    return [r.id for r in runs]


async def _disconnect_all(
    session: AsyncSession, principal: "Principal | None", user: User, via: dict[str, str]
) -> tuple[list, set[uuid.UUID]]:
    """Disconnect every connection of ``user`` (under the gate, held exclusively): audit,
    a ``source_permission`` revocation for each source it synced, the credential
    deleted, and a ``provider_revoke`` follow-up holding a copy of it until the
    provider has revoked the grant. Returns the connections and the synced sources."""
    from oracle.connections.models import Connection
    from oracle.review.publish import record_source_revocation
    from oracle.sources.models import Source

    connections = list(
        await session.scalars(
            select(Connection).where(Connection.user_id == user.id).with_for_update()
        )
    )
    revoked_ids: set[uuid.UUID] = set()
    for conn in connections:
        session.add(
            MemberFollowUp(
                member_id=user.id,
                kind="provider_revoke",
                target_id=conn.id,
                provider=conn.provider,
                auth_mode=conn.auth_mode,
                ciphertext=conn.ciphertext,
                key_version=conn.key_version,
            )
        )
        await audit.record(
            session, principal, "connection.disconnect", "connection", conn.id,
            {"provider": conn.provider, "account": conn.account_label,
             "provider_revoke": "pending", **via},
        )  # fmt: skip
        synced = list(await session.scalars(select(Source).where(Source.connection_id == conn.id)))
        revoked_ids |= {x.id for x in synced}
        await record_source_revocation(
            session, principal, synced, "connection_revoked", drop_links=False
        )
        await session.delete(conn)
    await session.flush()
    return connections, revoked_ids


async def after_disable(
    session: AsyncSession,
    principal: "Principal",
    user_id: uuid.UUID,
    http: "httpx.AsyncClient",
) -> None:
    """After a disable commits: revoke anything of theirs that slipped in while it ran
    (a credential created by a request that authenticated before it), then make the
    calls the disable owes (:func:`run_follow_ups`). Commits."""
    await sweep_disabled(session, principal, user_id)
    await run_follow_ups(session, principal, http, member_id=user_id)


async def sweep_disabled(
    session: AsyncSession, principal: "Principal | None", user_id: uuid.UUID
) -> bool:
    """Re-check a disabled member after the disable committed: an API token, an OAuth
    grant or a connection of theirs still active is revoked now, as the disable would
    have. Commits; ``True`` when something was revoked."""
    from oracle.connections.models import Connection
    from oracle.mcp.oauth.models import OAuthToken

    user = await session.get(User, user_id)
    if user is None or user.disabled_at is None:
        return False
    tokens = list(
        await session.scalars(
            select(ApiToken.id).where(ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None))
        )
    )
    grants = list(
        await session.scalars(
            select(OAuthToken.id).where(
                OAuthToken.user_id == user_id, OAuthToken.revoked_at.is_(None)
            )
        )
    )
    conns = list(await session.scalars(select(Connection.id).where(Connection.user_id == user_id)))
    if not (tokens or grants or conns):
        return False
    from oracle.review import publish

    await publish.gate_lock(session, shared=False)
    at = datetime.now(UTC)
    via = {"via": "member.disable.sweep", "member_id": str(user_id)}
    await session.execute(
        update(ApiToken)
        .where(ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None))
        .values(revoked_at=at)
        .execution_options(synchronize_session=False)
    )
    await session.execute(
        update(OAuthToken)
        .where(OAuthToken.user_id == user_id, OAuthToken.revoked_at.is_(None))
        .values(revoked_at=at)
        .execution_options(synchronize_session=False)
    )
    await _disconnect_all(session, principal, user, via)
    await audit.record(
        session,
        principal,
        "member.disable_sweep",
        "user",
        user_id,
        {
            "api_tokens": [str(i) for i in tokens],
            "oauth_tokens": [str(i) for i in grants],
            "connections": [str(i) for i in conns],
        },
    )
    await session.commit()
    return True


# How often a follow-up is tried (once after the disable, then from the tick) and how
# long one call may take in all, whatever the HTTP client's own timeouts.
FOLLOW_UP_ATTEMPTS = 5
FOLLOW_UP_DEADLINE_SECONDS = 30.0


async def run_follow_ups(
    session: AsyncSession,
    principal: "Principal | None",
    http: "httpx.AsyncClient",
    *,
    member_id: uuid.UUID | None = None,
) -> int:
    """Make the pending follow-ups (of ``member_id``, or all of the session's tenant),
    one transaction each, outside the review gate; record each outcome (on the row
    and in the audit log). A failed call stays pending for the tick to retry, up to
    :data:`FOLLOW_UP_ATTEMPTS` attempts, then is marked failed. A finished
    ``provider_revoke`` drops its copy of the credential. Returns how many ran."""
    stmt = select(MemberFollowUp.id).where(MemberFollowUp.status == "pending")
    if member_id is not None:
        stmt = stmt.where(MemberFollowUp.member_id == member_id)
    ids = list(await session.scalars(stmt.order_by(MemberFollowUp.created_at)))
    await session.commit()
    ran = 0
    for follow_up_id in ids:
        row = await session.scalar(
            select(MemberFollowUp)
            .where(MemberFollowUp.id == follow_up_id, MemberFollowUp.status == "pending")
            .with_for_update(skip_locked=True)
        )
        if row is None:
            await session.rollback()
            continue
        ran += 1
        ok, outcome, error = await _follow_up(session, row, http)
        row.attempts += 1
        row.outcome = outcome
        row.last_error = error
        if ok or row.attempts >= FOLLOW_UP_ATTEMPTS:
            row.status = "done" if ok else "failed"
            row.done_at = datetime.now(UTC)
            row.ciphertext = None
        await audit.record(
            session,
            principal,
            "connection.provider_revoke" if row.kind == "provider_revoke" else "run.runtime_cancel",
            "connection" if row.kind == "provider_revoke" else "run_segment",
            row.target_id,
            {
                "member_id": str(row.member_id),
                "outcome": outcome,
                "attempt": row.attempts,
                "status": row.status,
                **({"error": error} if error else {}),
            },
        )
        await session.commit()
    return ran


async def _follow_up(
    session: AsyncSession, row: MemberFollowUp, http: "httpx.AsyncClient"
) -> tuple[bool, str, str | None]:
    """Make one follow-up call: (succeeded, outcome, error)."""
    import asyncio

    if row.kind == "provider_revoke":
        from oracle.connections import service as connections
        from oracle.connections.models import Connection

        if row.ciphertext is None:
            return True, "unreadable", None
        # A detached copy of the deleted connection: what the revoke reads.
        conn = Connection(
            id=row.target_id,
            user_id=row.member_id,
            provider=row.provider,
            auth_mode=row.auth_mode,
            account_id="",
            ciphertext=row.ciphertext,
            key_version=row.key_version,
        )
        try:
            async with asyncio.timeout(FOLLOW_UP_DEADLINE_SECONDS):
                outcome = await connections.revoke_at_provider(http, conn)
        except TimeoutError:
            return False, "failed", "the provider did not answer in time"
        return outcome != "failed", outcome, None

    from oracle.runs.models import RunSegment
    from oracle.swarm import RuntimeUnavailable, get_runtime

    segment = await session.get(RunSegment, row.target_id)
    try:
        async with asyncio.timeout(FOLLOW_UP_DEADLINE_SECONDS):
            await get_runtime().cancel(row.workflow_id or "")
    except (RuntimeUnavailable, TimeoutError) as exc:
        error = str(exc) or "the runtime did not answer in time"
        if segment is not None:
            segment.error = f"cancel not confirmed by the runtime: {error}"
        return False, "failed", error
    if segment is not None:
        segment.error = None
    return True, "cancelled", None


async def restore_member(session: AsyncSession, principal: "Principal", user_id: uuid.UUID) -> User:
    """Re-enable a disabled member's sign-in, with the role they had. Nothing else comes
    back: their approvals stay lapsed, their tokens revoked, their connections gone and
    their sources revoked (they reconnect and approve again). A no-op for an active
    member."""
    await _gate(session, principal)
    user = await session.get(User, user_id, with_for_update=True)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if user.disabled_at is None:
        return user
    disabled_at = user.disabled_at
    user.disabled_at = None
    user.disabled_by = None
    # They sign in fresh: nothing signed before the restore (a sign-in that raced the
    # disable, an authorization code issued before it) counts.
    user.sessions_valid_after = datetime.now(UTC)
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

    await _gate(session, principal)
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
    # A lapsed version approval is kept in approval_lapses (a new approval clears
    # approval_lapsed_*), naming its token, or a user-less token as the approver.
    tid = str(token_id)
    in_history = or_(
        DocumentVersion.approval_lapses.contains([{"approved_token_id": tid}]),
        DocumentVersion.approval_lapses.contains([{"approved_by": tid}]),
    )
    lapsed_who = DocumentVersion.approval_lapsed_by == token_id
    for version, slug in (
        await session.execute(
            select(DocumentVersion, Document.slug)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(or_(who, lapsed_who, in_history))
            .order_by(DocumentVersion.created_at)
        )
    ).all():
        base = {
            "kind": "version",
            "document": slug,
            "version": version.number,
            "section_key": None,
            "review_id": None,
        }
        lapses = [
            e
            for e in version.approval_lapses or []
            if tid in (e.get("approved_token_id"), e.get("approved_by"))
        ]
        for e in lapses:
            out.append(
                {
                    **base,
                    "approver_id": e.get("approved_by"),
                    "approved_at": e.get("approved_at"),
                    "lapsed_at": e.get("lapsed_at"),
                    "lapse_reason": e.get("reason"),
                }
            )
        current = version.approved_at is not None and (
            version.approved_token_id == token_id or version.approved_by == token_id
        )
        if current:
            out.append(
                {
                    **base,
                    "approver_id": version.approved_by,
                    "approved_at": version.approved_at,
                    "lapsed_at": None,
                    "lapse_reason": None,
                }
            )
        elif not lapses and version.approved_at is None and version.approval_lapsed_at:
            # Lapsed before the history was kept.
            out.append(
                {
                    **base,
                    "approver_id": version.approval_lapsed_by,
                    "approved_at": None,
                    "lapsed_at": version.approval_lapsed_at,
                    "lapse_reason": version.approval_lapse_reason,
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
    await _gate(session, principal, shared=True)
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
    await _gate(session, principal, shared=True)
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
