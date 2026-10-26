"""Members (users of one company's Oracle) and invites. Functions flush, never commit;
the router commits once per request. Every change writes an audit event."""

import contextlib
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import or_, select, true, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes
from oracle.auth.models import ROLES, ApiToken, Role, User
from oracle.config import get_settings
from oracle.members.models import INVITE_TTL, Invite, MemberFollowUp
from oracle.members.schemas import InviteOut, InviteStatus, MemberOut, plain_address
from oracle.tenant_settings import TenantSetting

if TYPE_CHECKING:
    import httpx

    from oracle.auth.deps import Principal

log = logging.getLogger(__name__)

IAP_DEFAULT_ROLE_KEY = "iap_default_role"
FALLBACK_IAP_ROLE: Role = "commenter"


class MemberError(Exception):
    """A request the members service refuses; the router maps ``kind`` to an HTTP status."""

    def __init__(self, kind: str, message: str, detail: object | None = None):
        self.kind = kind  # "not_found" | "conflict" | "forbidden" | "invalid"
        self.message = message
        # What the response's ``detail`` is when not the message (A5's hand-over refusals).
        self.detail = detail
        super().__init__(message)


def invite_status(invite: Invite, now: datetime | None = None) -> InviteStatus:
    if invite.revoked_at is not None:
        return "revoked"
    if invite.accepted_at is not None:
        return "accepted"
    # A5: an open invite past its expiry is not claimed until it is resent.
    if invite.expires_at <= (now or datetime.now(UTC)):
        return "expired"
    return "open"


def invite_out(invite: Invite, invited_by_name: str | None = None) -> InviteOut:
    from oracle.members.delivery import sign_in_url

    return InviteOut(
        id=invite.id,
        email=invite.email,
        name=invite.name,
        role=invite.role,
        engineering_lead=invite.engineering_lead,
        status=invite_status(invite),
        invited_by=invite.invited_by,
        invited_by_name=invited_by_name,
        created_at=invite.created_at,
        accepted_at=invite.accepted_at,
        revoked_at=invite.revoked_at,
        expires_at=invite.expires_at,
        resent_at=invite.resent_at,
        resend_count=invite.resend_count,
        access_request_id=invite.access_request_id,
        access=invite.access,
        access_error=invite.access_error,
        access_at=invite.access_at,
        email_status=invite.email_status,
        email_error=invite.email_error,
        email_at=invite.email_at,
        sign_in_url=sign_in_url(),
        message=invite.message,
    )


async def invites_out(session: AsyncSession, invites: list[Invite]) -> list[InviteOut]:
    """Invites as the API shows them, each with its inviter's name."""
    from oracle.members.names import display_name

    ids = {i.invited_by for i in invites if i.invited_by is not None}
    users = (
        (
            await session.execute(select(User.id, User.email, User.name).where(User.id.in_(ids)))
        ).all()
        if ids
        else []
    )
    names = {u.id: display_name(u.email, u.name) for u in users}
    return [invite_out(i, names.get(i.invited_by)) for i in invites]  # type: ignore[arg-type]


def _open() -> list:
    return [Invite.accepted_at.is_(None), Invite.revoked_at.is_(None)]


# --- Members -----------------------------------------------------------------------------


async def list_members(session: AsyncSession) -> list[User]:
    """Every member, disabled ones included (history keeps their name)."""
    return list((await session.scalars(select(User).order_by(User.created_at, User.email))).all())


async def members_out(session: AsyncSession, users: list[User]) -> list[MemberOut]:
    """Members as the API shows them: with their open tokens counted."""
    from oracle.members.tokens import open_token_counts

    counts = await open_token_counts(session)
    owed = await _access_owed(session, [u.id for u in users])
    out = []
    for u in users:
        # What is owed on their access now: a revoke while removed, a grant while active.
        pending = "revoke" if u.disabled_at is not None else "grant"
        update_ = {"open_tokens": counts.get(u.id, 0)}
        if (u.id, f"iap_{pending}") in owed:
            update_["access_pending"] = pending
        out.append(MemberOut.model_validate(u).model_copy(update=update_))
    return out


async def _access_owed(
    session: AsyncSession, user_ids: list[uuid.UUID]
) -> set[tuple[uuid.UUID, str]]:
    """(member, kind) of the IAP access changes still owed for ``user_ids``."""
    if not user_ids:
        return set()
    rows = await session.execute(
        select(MemberFollowUp.member_id, MemberFollowUp.kind).where(
            MemberFollowUp.member_id.in_(user_ids),
            MemberFollowUp.kind.in_(ACCESS_KINDS),
            MemberFollowUp.status.in_(FOLLOW_UP_OPEN),
        )
    )
    return {(member_id, kind) for member_id, kind in rows}


async def _other_active_owner(session: AsyncSession, user_id: uuid.UUID) -> bool:
    """Whether an active owner other than ``user_id`` exists. Locks every owner row so
    two concurrent demotions or disables cannot both see "another owner"."""
    owners = (
        await session.execute(
            select(User.id, User.disabled_at).where(User.role == "owner").with_for_update()
        )
    ).all()
    return any(i != user_id and disabled is None for i, disabled in owners)


async def _gate(
    session: AsyncSession, principal: "Principal", *, shared: bool = False, role: Role = "owner"
) -> None:
    """Take the review gate, then re-read the caller under it.

    The gate reads approvers' roles and standing: a change to them never lands while
    a publish renders (oracle.review.publish.gate_lock); member changes take it
    exclusively, invites shared. The caller authenticated before waiting on it, and a
    disable, a demotion or a revocation may have committed meanwhile (an owner being
    disabled must not act with a request already in flight): they must still be an
    active owner, through an active token or grant, now. A member acting on their own
    account (My account) passes with any ``role``."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    await publish.gate_lock(session, shared=shared)
    refusal = await caller_refusal(session, principal, role)
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
    from oracle.runs.service import void_owed_decisions

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
    # A3: a viewer never carries the engineering lead flag: a demotion to viewer clears it
    # in this change.
    cleared = role == "viewer" and user.engineering_lead
    if cleared:
        user.engineering_lead = False
    user.role = role
    await session.flush()
    await audit.record(
        session, principal, "member.role", "user", user.id, {"before": before, "after": role}
    )
    # I1: below approver their webhooks pause; below owner, owners-and-approvers content
    # goes off them.
    from oracle.webhooks import service as webhooks_service

    await webhooks_service.creator_role_changed(session, principal, user.id, role)
    if cleared:
        await audit.record(
            session,
            principal,
            "member.engineering_lead",
            "user",
            user.id,
            {"before": True, "after": False, "reason": "role viewer"},
        )
    if has_role(before, "approver") and not has_role(role, "approver"):
        await lapse_approvals(
            session, principal, reviewer_id=user.id, reason=f"approver demoted to {role}"
        )
    # C2: a demotion, like a disable, voids the spend approvals and checkpoint decisions
    # they gave that the new role could not give (pending ones only: they return to the
    # Inbox). Their own runs go on (a disable cancels those). Theirs in person and through
    # their API tokens (which act with the person's role).
    if not has_role(role, before):
        via = {"via": "member.role", "member_id": str(user.id)}
        tokens = set(await session.scalars(select(ApiToken.id).where(ApiToken.user_id == user.id)))
        acted_as = {user.id, *tokens}
        if has_role(before, "owner"):
            await _void_spend_approvals(session, principal, acted_as, None, via)
        await _void_checkpoint_decisions(session, principal, acted_as, via, keep_role=role)
        await _unstage_checkpoint_actions(session, principal, acted_as, via, keep_role=role)
        # A decision they recorded that is not delivered to its run yet, on a checkpoint
        # the new role may not decide: never delivered now.
        await void_owed_decisions(
            session, principal, acted_as, f"its decider was demoted to {role}", via, role=role
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


async def set_engineering_lead(
    session: AsyncSession, principal: "Principal", user_id: uuid.UUID, value: bool
) -> User:
    """Name a member engineering lead, or clear the flag (A3). A viewer is never named.
    Clearing it voids the engineering-stop decisions they gave that are not delivered to
    their run yet and that they may no longer give (C2, as for a demotion): those stops go
    back to the Inbox. An owner keeps deciding every stop, so an owner's are kept."""
    from oracle.members.leads import ENGINEERING_KINDS, VIEWER_REFUSED, engineering_leads
    from oracle.runs.service import void_owed_decisions

    await _gate(session, principal)
    user = await session.get(User, user_id, with_for_update=True)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if value and user.role == "viewer":
        raise MemberError("invalid", VIEWER_REFUSED)
    if user.engineering_lead == value:
        return user
    user.engineering_lead = value
    await session.flush()
    await audit.record(
        session,
        principal,
        "member.engineering_lead",
        "user",
        user.id,
        {"before": not value, "after": value},
    )
    if not value and user.role != "owner":
        # With other leads named, the engineering stops are theirs (and owners'); with none
        # left, the member decides them by role again.
        keep: Role | None = None if await engineering_leads(session) else user.role  # type: ignore[assignment]
        via = {"via": "member.engineering_lead", "member_id": str(user.id)}
        tokens = set(await session.scalars(select(ApiToken.id).where(ApiToken.user_id == user.id)))
        acted_as = {user.id, *tokens}
        await _void_checkpoint_decisions(
            session, principal, acted_as, via, keep_role=keep, kinds=ENGINEERING_KINDS
        )
        await void_owed_decisions(
            session,
            principal,
            acted_as,
            "its decider is no longer an engineering lead",
            via,
            role=keep,
            kinds=ENGINEERING_KINDS,
        )
    return user


async def update_member(
    session: AsyncSession,
    principal: "Principal",
    user_id: uuid.UUID,
    role: Role | None,
    engineering_lead: bool | None,
    name: str | None | object = ...,
    hand_over: list[dict] | None = None,
) -> User:
    """``PATCH /v1/members/{user_id}``: the role, the engineering lead flag, the name
    (A5; None clears it), or several, in one change, role first (so a viewer made
    commenter can be named at once). ``name`` left out (``...``) is unchanged. With
    ``hand_over`` (A5), those responsibilities move first, in the same transaction."""
    from oracle.members.handover import hand_over as move

    if role is None and engineering_lead is None and name is ...:
        raise MemberError("invalid", "Send role, name or both")
    user: User | None = None
    if hand_over:
        await move(session, principal, user_id, hand_over)
    if name is not ...:
        user = await set_name(session, principal, user_id, name)  # type: ignore[arg-type]
    if role is not None:
        user = await set_role(session, principal, user_id, role)
    if engineering_lead is not None:
        user = await set_engineering_lead(session, principal, user_id, engineering_lead)
    assert user is not None
    return user


async def set_name(
    session: AsyncSession,
    principal: "Principal",
    user_id: uuid.UUID,
    name: str | None,
    *,
    own: bool = False,
) -> User:
    """Set or clear a member's name (A5): an owner's (or, ``own``, the member's own) change,
    audited ``member.name`` with before and after. Unchanged: no event."""
    await _gate(session, principal, shared=True, role="viewer" if own else "owner")
    user = await session.get(User, user_id, with_for_update=True)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if user.name != name:
        before, user.name = user.name, name
        await session.flush()
        await audit.record(session, principal, "member.name", "user", user.id,
                           {"before": before, "after": name})  # fmt: skip
    return user


async def disable_member(
    session: AsyncSession,
    principal: "Principal",
    user_id: uuid.UUID,
    hand_over: list[dict] | None = None,
) -> User:
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
    :func:`restore_member` re-enables sign-in only. With ``hand_over`` (A5), those
    responsibilities move first, under the same gate (audited ``member.hand_over``)."""
    from oracle.discussions.service import hand_over as hand_over_discussions
    from oracle.mcp.oauth.models import OAuthToken
    from oracle.review.publish import record_source_revocation
    from oracle.review.state import lapse_approvals
    from oracle.runs.service import stop_run, void_owed_decisions

    await _gate(session, principal)
    user = await session.get(User, user_id, with_for_update=True)
    if user is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    if user.disabled_at is not None:
        return user
    if principal.user_id == user.id:
        raise MemberError("conflict", "You cannot remove yourself; another owner can remove you")
    if user.role == "owner" and not await _other_active_owner(session, user.id):
        raise MemberError("conflict", "Cannot remove the last owner; make someone else owner")
    if hand_over:
        from oracle.members.handover import hand_over as move

        await move(session, principal, user.id, hand_over)
    at = datetime.now(UTC)
    via = {"via": "member.disable", "member_id": str(user.id)}

    connections, revoked_ids = await _disconnect_all(session, principal, user, via)
    sources = await select_sources(session, user.id)
    rest = [x for x in sources if x.id not in revoked_ids]
    await record_source_revocation(session, principal, rest, "source_revoked", drop_links=False)
    for source in sources:
        source.status = "paused"
        source.last_error = "Its owner was removed from this company"

    tokens = await select_tokens(session, user.id)
    for token in tokens:
        token.revoked_at = at
    # I1: their webhooks pause; a restore does not resume them.
    from oracle.webhooks import service as webhooks_service

    await webhooks_service.creator_disabled(session, principal, user.id)
    await session.execute(
        update(OAuthToken)
        .where(*_grants_where(user.id))
        .values(revoked_at=at)
        .execution_options(synchronize_session=False)
    )
    runs = list(await session.scalars(_runs_q(user.id).with_for_update()))
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
    acted_as = await _acted_as(session, user.id)
    # The open invite for their email, and every open invite they created.
    invites = await select_open_invites(session, user, acted_as)
    for invite in invites:
        invite.revoked_at = at
        await audit.record(
            session, principal, "invite.revoke", "invite", invite.id, {"email": invite.email, **via}
        )
    jobs = await _cancel_llm_jobs(session, acted_as, at)
    voided = await _void_spend_approvals(session, principal, acted_as, user.id, via)
    decisions = await _void_checkpoint_decisions(session, principal, acted_as, via)
    await _unstage_checkpoint_actions(session, principal, acted_as, via)
    # Decisions recorded and not delivered to their run yet (SwarmCloud did not take the
    # post): never delivered now.
    decisions += await void_owed_decisions(
        session, principal, acted_as, "its decider was removed (disabled)", via
    )
    lapsed = await lapse_approvals(
        session, principal, reviewer_id=user.id, reason="member was removed (disabled)"
    )

    # G1: their discussions pass to an approver in each (audited).
    await hand_over_discussions(session, principal, user.id)

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
            "checkpoint_decisions_voided": [str(c) for c in decisions],
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


# --- What a removal or a demotion does (A5) ----------------------------------------------
# One selection per effect: no locks, no writes. The apply functions above and below run
# the same query (with their locks), so the preview (oracle.members.impact) and the
# action cannot drift.


async def _acted_as(session: AsyncSession, user_id: uuid.UUID) -> set[uuid.UUID]:
    """The member and every API token that ever acted for them (revoked ones still name
    what they did for the member)."""
    tokens = set(await session.scalars(select(ApiToken.id).where(ApiToken.user_id == user_id)))
    return {user_id, *tokens}


async def select_tokens(session: AsyncSession, user_id: uuid.UUID) -> list[ApiToken]:
    """Their active API tokens: a disable revokes them."""
    return list(
        await session.scalars(
            select(ApiToken).where(ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None))
        )
    )


def _grants_where(user_id: uuid.UUID) -> list:
    from oracle.mcp.oauth.models import OAuthToken

    return [OAuthToken.user_id == user_id, OAuthToken.revoked_at.is_(None)]


async def select_grants(session: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Their active MCP OAuth grants (refresh-token families): a disable revokes them."""
    from oracle.mcp.oauth.models import OAuthToken

    return list(
        await session.scalars(
            select(OAuthToken.family_id).where(*_grants_where(user_id)).distinct()
        )
    )


async def select_connections(session: AsyncSession, user_id: uuid.UUID) -> list:
    """Their connections: a disable disconnects each (:func:`_disconnect_all`)."""
    from oracle.connections.models import Connection

    return list(await session.scalars(select(Connection).where(Connection.user_id == user_id)))


async def select_sources(session: AsyncSession, user_id: uuid.UUID) -> list:
    """Their sources: a disable records each revoked and pauses it."""
    from oracle.sources.models import Source

    return list(await session.scalars(select(Source).where(Source.owner_user_id == user_id)))


def _runs_q(user_id: uuid.UUID):
    from oracle.runs.models import Run
    from oracle.runs.service import FINAL

    return select(Run).where(Run.created_by == user_id, Run.status.not_in(FINAL))


async def select_runs(session: AsyncSession, user_id: uuid.UUID) -> list:
    """Their unfinished runs: a disable cancels them."""
    return list(await session.scalars(_runs_q(user_id)))


async def select_open_invites(
    session: AsyncSession, user: User, acted_as: set[uuid.UUID]
) -> list[Invite]:
    """The open invite for their email, and every open invite they created."""
    return list(
        await session.scalars(
            select(Invite).where(
                or_(Invite.email == user.email, Invite.invited_by.in_(acted_as)), *_open()
            )
        )
    )


def _llm_jobs_q(requesters: set[uuid.UUID]):
    from oracle.jobs.models import LlmJob

    return select(LlmJob).where(LlmJob.status == "queued", LlmJob.requested_by.in_(requesters))


async def select_llm_jobs(session: AsyncSession, requesters: set[uuid.UUID]) -> list[uuid.UUID]:
    """The queued built-in model jobs they requested: a disable cancels them."""
    return [j.id for j in await session.scalars(_llm_jobs_q(requesters))]


def _spend_q(approvers: set[uuid.UUID], member_id: uuid.UUID | None):
    from oracle.runs.models import Run, RunSegment
    from oracle.runs.service import FINAL

    started = select(RunSegment.id).where(
        RunSegment.run_id == Run.id,
        or_(RunSegment.started_at.is_not(None), RunSegment.swarm_workflow_id.is_not(None)),
    )
    return select(Run).where(
        Run.approved_by.in_(approvers),
        Run.status.not_in(FINAL),
        Run.created_by.is_distinct_from(member_id) if member_id else true(),
        ~started.exists(),
    )


def _resumes_q(approvers: set[uuid.UUID], member_id: uuid.UUID | None):
    from oracle.runs.models import Run, RunSegment

    since = select(RunSegment.id).where(
        RunSegment.run_id == Run.id, RunSegment.started_at >= Run.resumed_at
    )
    return select(Run).where(
        Run.resumed_by.in_(approvers),
        Run.status.in_(("running", "awaiting_checkpoint")),
        Run.created_by.is_distinct_from(member_id) if member_id else true(),
        ~since.exists(),
    )


async def select_spend_approvals(
    session: AsyncSession, approvers: set[uuid.UUID], member_id: uuid.UUID | None
) -> tuple[list, list]:
    """The spend approvals and the overrun Resumes (C2) :func:`_void_spend_approvals`
    voids: (runs whose approval is void, runs whose Resume is void)."""
    approvals = list(await session.scalars(_spend_q(approvers, member_id)))
    resumes = list(await session.scalars(_resumes_q(approvers, member_id)))
    return approvals, resumes


def _decisions_q(deciders: set[uuid.UUID]):
    from oracle.runs.models import Run, RunSegment

    return (
        select(RunSegment.id, RunSegment.run_id)
        .join(Run, Run.id == RunSegment.run_id)
        .where(
            Run.status == "running",
            RunSegment.status == "pending",
            RunSegment.artifacts["decision"]["decided_by"].astext.in_([str(d) for d in deciders]),
        )
    )


def _decision_voids(
    run, segment, cp, deciders: set[uuid.UUID], keep_role: Role | None, kinds
) -> bool:
    """Whether :func:`_void_checkpoint_decisions` voids this decision (read under its
    locks there, without them in :func:`select_checkpoint_decisions`)."""
    from oracle.authz import has_role
    from oracle.members.leads import SPEC_FLOW

    decision = (segment.artifacts or {}).get("decision") or {}
    if run.status != "running" or segment.status != "pending":
        return False
    if decision.get("decided_by") not in [str(d) for d in deciders]:
        return False
    if cp is None or cp.run_id != run.id:
        return False
    if kinds is not None and (cp.kind not in kinds or run.flow == SPEC_FLOW):
        return False
    return not (keep_role is not None and has_role(keep_role, cp.approver_role))  # type: ignore[arg-type]


async def select_checkpoint_decisions(
    session: AsyncSession,
    deciders: set[uuid.UUID],
    *,
    keep_role: Role | None = None,
    kinds: tuple[str, ...] | None = None,
) -> list[tuple]:
    """The (run, checkpoint) of each undelivered checkpoint decision
    :func:`_void_checkpoint_decisions` voids."""
    from oracle.runs.models import Checkpoint, Run, RunSegment

    out = []
    for segment_id, run_id in (await session.execute(_decisions_q(deciders))).all():
        run = await session.get(Run, run_id)
        segment = await session.get(RunSegment, segment_id)
        decision = (segment.artifacts or {}).get("decision") or {}
        cp_id = decision.get("checkpoint_id")
        cp = await session.get(Checkpoint, uuid.UUID(cp_id)) if cp_id else None
        if _decision_voids(run, segment, cp, deciders, keep_role, kinds):
            out.append((run, cp))
    return out


async def _cancel_llm_jobs(
    session: AsyncSession, requesters: set[uuid.UUID], at: datetime
) -> list[uuid.UUID]:
    """Cancel the queued built-in model jobs the removed member requested: nothing more
    is spent for them. A job already running finishes (its call is under way). A job a
    worker is claiming right now is waited for (a claim holds its row for a moment), not
    skipped: it is cancelled if still queued, or finishes if the claim started it."""
    jobs = list(
        await session.scalars(
            _llm_jobs_q(requesters).with_for_update().execution_options(populate_existing=True)
        )
    )
    jobs = [j for j in jobs if j.status == "queued"]
    for job in jobs:
        job.status = "cancelled"
        job.error = "Its requester was removed from this company"
        job.finished_at = at
    return [j.id for j in jobs]


async def _void_spend_approvals(
    session: AsyncSession,
    principal: "Principal",
    approvers: set[uuid.UUID],
    member_id: uuid.UUID | None,
    via: dict[str, str],
) -> list[uuid.UUID]:
    """A spend approval the removed member gave on someone else's run that has not
    started (no segment ever ran) is void: the run waits for an approval again. A run
    that started keeps its approval and its ceiling. With ``member_id`` (a disable),
    their own runs are left out: the disable cancels them; without (a demotion), an
    approval they gave their own run is void too."""
    from oracle.runs.models import RunSegment
    from oracle.runs.service import unqueue
    from oracle.runtokens import revoke_run_tokens

    runs = list(await session.scalars(_spend_q(approvers, member_id).with_for_update()))
    for run in runs:
        approved_by = run.approved_by
        run.status = "awaiting_approval"
        run.approved_by = None
        run.approved_at = None
        await revoke_run_tokens(session, run.id)
        # Its first segment may be queued, or its submission under way: it is not ours
        # now (oracle.runs.service.submit_queued cancels a workflow it started).
        for segment in await session.scalars(
            select(RunSegment).where(RunSegment.run_id == run.id, RunSegment.status == "pending")
        ):
            unqueue(segment)
        await audit.record(
            session, principal, "run.approval_voided", "run", run.id,
            {"approved_by": str(approved_by), **via},
        )  # fmt: skip
    return [r.id for r in runs] + await _void_resumes(session, principal, approvers, member_id, via)


async def _void_resumes(
    session: AsyncSession,
    principal: "Principal",
    approvers: set[uuid.UUID],
    member_id: uuid.UUID | None,
    via: dict[str, str],
) -> list[uuid.UUID]:
    """An overrun Resume is a spend approval (C2, owner decision): one the removed or
    demoted owner gave whose next segment has not been submitted (nothing started since
    the Resume) is void. The run is paused on overrun again with the ceiling the Resume
    replaced; the segment it queued is taken off the queue (marked, so the next Resume
    queues it again; a submission under way cancels what it started) and the run's
    tokens are revoked. A segment still running from before the pause goes on, as the
    pause lets it, with its token. A run the Resume took to a checkpoint keeps waiting
    for it, under the old ceiling. ``member_id``: as for :func:`_void_spend_approvals`."""
    from oracle.runs.models import RunSegment
    from oracle.runs.service import RESUME_VOIDED, _art, _set_art, _set_knob, unqueue
    from oracle.runtokens import revoke_run_tokens

    runs = list(
        await session.scalars(
            _resumes_q(approvers, member_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    for run in runs:
        resumed_by, ceiling = run.resumed_by, run.resumed_from_ceiling_usd
        _set_knob(run, "spend_ceiling_usd", str(ceiling) if ceiling is not None else None)
        run.resumed_by = run.resumed_at = run.resumed_from_ceiling_usd = None
        segments = list(
            await session.scalars(select(RunSegment).where(RunSegment.run_id == run.id))
        )
        if run.status == "running":
            run.status = "paused_overrun"
            for segment in segments:
                if segment.status == "pending" and (
                    segment.error is not None or "claim" in (segment.artifacts or {})
                ):
                    unqueue(segment)
                    art = _art(segment)
                    art[RESUME_VOIDED] = True
                    _set_art(segment, art)
            if not any(s.status == "running" for s in segments):
                await revoke_run_tokens(session, run.id)
        await audit.record(
            session, principal, "run.resume_voided", "run", run.id,
            {"resumed_by": str(resumed_by), "ceiling_usd": str(ceiling), **via},
        )  # fmt: skip
    return [r.id for r in runs]


async def _void_checkpoint_decisions(
    session: AsyncSession,
    principal: "Principal",
    deciders: set[uuid.UUID],
    via: dict[str, str],
    *,
    keep_role: Role | None = None,
    kinds: tuple[str, ...] | None = None,
) -> list[uuid.UUID]:
    """A checkpoint decision the removed member gave whose segment has not been
    submitted yet (the submission is under way, or waits for the tick's retry) is void,
    as a spend approval is: the checkpoint waits for a decision again, nothing runs for
    it. A decision whose workflow was submitted stands (it is running). With
    ``keep_role`` (a demotion), a decision on a checkpoint that role may still decide
    stands. With ``kinds`` (an engineering lead unflagged, A3), only checkpoints of those
    kinds that the lead rule governs (oracle.members.leads.lead_stop) are voided."""
    from oracle.runs.models import Checkpoint, Run, RunSegment
    from oracle.runs.service import void_decision

    decided = [str(d) for d in deciders]
    candidates = (await session.execute(_decisions_q(deciders))).all()
    voided: list[uuid.UUID] = []
    for segment_id, run_id in candidates:
        fresh = {"populate_existing": True}
        run = await session.scalar(
            select(Run).where(Run.id == run_id).with_for_update().execution_options(**fresh)
        )
        segment = await session.scalar(
            select(RunSegment).where(RunSegment.id == segment_id).execution_options(**fresh)
        )
        decision = (segment.artifacts or {}).get("decision") or {}
        if run.status != "running" or segment.status != "pending":
            continue
        if decision.get("decided_by") not in decided:
            continue
        cp = await session.get(Checkpoint, uuid.UUID(decision["checkpoint_id"]))
        if not _decision_voids(run, segment, cp, deciders, keep_role, kinds):
            continue
        await void_decision(session, principal, run, segment, cp, via)
        voided.append(cp.id)
    return voided


async def _unstage_checkpoint_actions(
    session: AsyncSession,
    principal: "Principal",
    stagers: set[uuid.UUID],
    via: dict[str, str],
    *,
    keep_role: Role | None = None,
) -> None:
    """D8: what the member staged on a pending checkpoint's shared draft becomes a
    suggestion again (it needs an approver); each checkpoint's draft revision is bumped
    once. With ``keep_role`` (a demotion), actions on a checkpoint that role may still
    stage stand."""
    from oracle.authz import has_role
    from oracle.runs.models import Checkpoint, CheckpointAction

    rows = (
        await session.execute(
            select(CheckpointAction, Checkpoint)
            .join(Checkpoint, Checkpoint.id == CheckpointAction.checkpoint_id)
            .where(
                Checkpoint.status == "pending",
                CheckpointAction.state == "staged",
                CheckpointAction.updated_by.in_(stagers),
            )
            .with_for_update(of=Checkpoint)
        )
    ).all()
    touched: dict[uuid.UUID, Checkpoint] = {}
    for action, cp in rows:
        if keep_role is not None and has_role(keep_role, cp.approver_role):  # type: ignore[arg-type]
            continue
        action.state = "suggested"
        touched[cp.id] = cp
        await audit.record(
            session, principal, "checkpoint.action_suggested", "checkpoint", cp.id,
            {"run_id": str(cp.run_id), "kind": cp.kind, "item_key": action.item_key,
             "action": {"id": str(action.id), "kind": action.kind, "field": action.field,
                        "value": action.value, "state": "suggested"},
             "revision": (cp.draft_revision or 0) + 1, "unstaged": via},
        )  # fmt: skip
    for cp in touched.values():
        cp.draft_revision = (cp.draft_revision or 0) + 1
    await session.flush()


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


async def _left_over(
    session: AsyncSession, user_id: uuid.UUID
) -> tuple[list[uuid.UUID], list[uuid.UUID], list[uuid.UUID], list[uuid.UUID], set[uuid.UUID]]:
    """What a disabled member still holds: active API tokens, OAuth grants, connections,
    queued model jobs (requested by them or a token of theirs), and those identities."""
    from oracle.connections.models import Connection
    from oracle.jobs.models import LlmJob
    from oracle.mcp.oauth.models import OAuthToken

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
    acted_as = {
        user_id,
        *await session.scalars(select(ApiToken.id).where(ApiToken.user_id == user_id)),
    }
    jobs = list(
        await session.scalars(
            select(LlmJob.id).where(LlmJob.status == "queued", LlmJob.requested_by.in_(acted_as))
        )
    )
    return tokens, grants, conns, jobs, acted_as


async def sweep_disabled(
    session: AsyncSession, principal: "Principal | None", user_id: uuid.UUID
) -> bool:
    """Re-check a disabled member after the disable committed: an API token, an OAuth
    grant or a connection of theirs still active is revoked now, and a model job queued
    for them cancelled (the reporting job an import queues, say), as the disable would
    have. Commits; ``True`` when something was revoked or cancelled."""
    from oracle.mcp.oauth.models import OAuthToken

    user = await session.get(User, user_id)
    if user is None or user.disabled_at is None:
        return False
    if not any((await _left_over(session, user_id))[:4]):
        return False
    from oracle.review import publish

    await publish.gate_lock(session, shared=False)
    # Re-read under the gate: a restore may have committed while the sweep waited on it,
    # and a restored member's new tokens and connections are theirs to keep; and what
    # is left over may have changed (the audit names what this sweep revoked).
    user = await session.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None or user.disabled_at is None:
        await session.rollback()
        return False
    tokens, grants, conns, jobs, acted_as = await _left_over(session, user_id)
    if not (tokens or grants or conns or jobs):
        await session.rollback()
        return False
    at = datetime.now(UTC)
    via = {"via": "member.disable.sweep", "member_id": str(user_id)}
    await session.execute(
        update(ApiToken)
        .where(ApiToken.id.in_(tokens))
        .values(revoked_at=at)
        .execution_options(synchronize_session=False)
    )
    await session.execute(
        update(OAuthToken)
        .where(OAuthToken.id.in_(grants))
        .values(revoked_at=at)
        .execution_options(synchronize_session=False)
    )
    connections, _ = await _disconnect_all(session, principal, user, via)
    cancelled = await _cancel_llm_jobs(session, acted_as, at)
    await audit.record(
        session,
        principal,
        "member.disable_sweep",
        "user",
        user_id,
        {
            "api_tokens": [str(i) for i in tokens],
            "oauth_tokens": [str(i) for i in grants],
            "connections": [str(c.id) for c in connections],
            "llm_jobs": [str(j) for j in cancelled],
        },
    )
    await session.commit()
    return True


# A failed follow-up is retried by time, not by tick: after each failure it waits a
# backoff (a minute, doubling, at most an hour), for FOLLOW_UP_RETRY_WINDOW from the
# disable. Then it is marked failed: no more automatic retries, and a provider revoke
# keeps its copy of the credential and stays in the owners' Inbox (Retry, Dismiss). An
# access change (ACCESS_KINDS, #245) is retried on, once a day, until it is done or no
# longer needed, and shows in the owners' Inbox meanwhile (Retry).
FOLLOW_UP_RETRY_WINDOW = timedelta(hours=24)
FOLLOW_UP_DAILY = timedelta(days=1)
FOLLOW_UP_FIRST_BACKOFF = timedelta(minutes=1)
FOLLOW_UP_MAX_BACKOFF = timedelta(hours=1)
# How long one call may take in all, whatever the HTTP client's own timeouts; and how
# long one run of follow-ups (a tick's, a disable's) may take in all: the rest wait
# for the next tick (``oracle tick`` gives the whole tick 120 seconds).
FOLLOW_UP_DEADLINE_SECONDS = 30.0
FOLLOW_UP_TICK_BUDGET_SECONDS = 40.0
# The outcomes that finish a provider revoke: revoked, or nothing of Oracle's to revoke
# (a pasted personal token). "not_configured" and "unreadable" are not a success.
REVOKE_DONE = ("revoked", "not_applicable")
# Still owed: retried by the tick (pending) or waiting for an owner (failed).
FOLLOW_UP_OPEN = ("pending", "failed")


class _BudgetSpent(Exception):
    """The run's time budget ran out during a call; that call is not counted."""


def follow_up_backoff(attempts: int) -> timedelta:
    """How long a follow-up waits after its ``attempts``-th failed attempt."""
    return min(FOLLOW_UP_FIRST_BACKOFF * 2 ** max(attempts - 1, 0), FOLLOW_UP_MAX_BACKOFF)


async def run_follow_ups(
    session: AsyncSession,
    principal: "Principal | None",
    http: "httpx.AsyncClient",
    *,
    member_id: uuid.UUID | None = None,
    budget_seconds: float | None = None,
) -> int:
    """Make the pending follow-ups that are due (of ``member_id``, or all of the
    session's tenant), one transaction each, outside the review gate, within
    :data:`FOLLOW_UP_TICK_BUDGET_SECONDS` in all (or ``budget_seconds``, when less: the
    time a scheduled tick has left): a call the budget cuts short is not counted and
    waits for the next tick. A DB error in one rolls that one back; the others still
    run. Returns how many ran (:func:`_attempt` records each outcome)."""
    import asyncio

    loop = asyncio.get_running_loop()
    budget = FOLLOW_UP_TICK_BUDGET_SECONDS
    if budget_seconds is not None:
        budget = min(budget, budget_seconds)
    deadline = loop.time() + budget
    stmt = select(MemberFollowUp.id).where(
        or_(
            MemberFollowUp.status == "pending",
            # Past its 24 hours, an access change is still retried, once a day.
            (MemberFollowUp.status == "failed") & MemberFollowUp.kind.in_(ACCESS_KINDS),
        ),
        or_(
            MemberFollowUp.next_attempt_at.is_(None),
            MemberFollowUp.next_attempt_at <= datetime.now(UTC),
        ),
    )
    if member_id is not None:
        stmt = stmt.where(MemberFollowUp.member_id == member_id)
    ids = list(await session.scalars(stmt.order_by(MemberFollowUp.created_at)))
    await session.commit()
    ran = 0
    for follow_up_id in ids:
        if loop.time() >= deadline:
            break
        try:
            row = await _attempt(session, principal, http, follow_up_id, FOLLOW_UP_OPEN, deadline)
        except _BudgetSpent:
            break
        except Exception:  # noqa: BLE001 - a DB error in one must not stop the others
            log.exception("follow-up %s could not be recorded", follow_up_id)
            await session.rollback()
            continue
        ran += row is not None
    return ran


async def _attempt(
    session: AsyncSession,
    principal: "Principal | None",
    http: "httpx.AsyncClient",
    follow_up_id: uuid.UUID,
    statuses: tuple[str, ...],
    deadline: float | None = None,
    *,
    manual: bool = False,
) -> MemberFollowUp | None:
    """Make one follow-up's call now and record the outcome (on the row and in the audit
    log), in one transaction; ``None`` when it is not in ``statuses`` or another worker
    holds it. A success finishes it (a provider revoke drops its copy of the
    credential); a failure waits a backoff, or past the retry window is marked failed,
    the copy kept. ``deadline`` (loop time): the run's budget; a call it cuts short is
    rolled back, uncounted (:class:`_BudgetSpent`)."""
    row = await session.scalar(
        select(MemberFollowUp)
        .where(MemberFollowUp.id == follow_up_id, MemberFollowUp.status.in_(statuses))
        .with_for_update(skip_locked=True)
    )
    if row is None:
        await session.rollback()
        return None
    try:
        ok, outcome, error = await _follow_up(session, row, http, deadline)
    except _BudgetSpent:
        await session.rollback()
        raise
    except Exception as exc:  # noqa: BLE001 - one broken call must not stop the others
        log.exception("follow-up %s (%s) failed", row.id, row.kind)
        ok, outcome, error = False, "failed", type(exc).__name__
    try:
        return await _record_attempt(session, principal, row, ok, outcome, error, manual)
    except Exception:
        await session.rollback()
        if ok:
            # The call succeeded: whatever failed to save, the next attempt must not
            # make it again (a second revoke of a dead grant fails, and would show as
            # "Couldn't revoke"); it records the success (:func:`_follow_up`).
            await session.execute(
                update(MemberFollowUp)
                .where(MemberFollowUp.id == follow_up_id)
                .values(outcome=outcome)
                .execution_options(synchronize_session=False)
            )
            await session.commit()
        raise


async def attempt_follow_up(
    session: AsyncSession, follow_up_id: uuid.UUID
) -> MemberFollowUp | None:
    """Make a pending run_cancel follow-up now (the cancel that recorded it just
    committed); a failure waits for the tick's retry. Commits."""
    return await _attempt(session, None, None, follow_up_id, ("pending",))  # type: ignore[arg-type]


async def _record_attempt(
    session: AsyncSession,
    principal: "Principal | None",
    row: MemberFollowUp,
    ok: bool,
    outcome: str,
    error: str | None,
    manual: bool,
) -> MemberFollowUp:
    now = datetime.now(UTC)
    row.attempts += 1
    row.outcome = outcome
    row.last_error = error
    if ok:
        row.status = "done"
        row.done_at = now
        row.next_attempt_at = None
        row.ciphertext = None
    elif now >= row.created_at + FOLLOW_UP_RETRY_WINDOW:
        # No more automatic retries; the copy stays for an owner's Retry or Dismiss. An
        # access change waits for an owner's Retry, and is retried once a day meanwhile.
        row.status = "failed"
        row.next_attempt_at = now + FOLLOW_UP_DAILY if row.kind in ACCESS_KINDS else None
    else:
        row.status = "pending"
        row.next_attempt_at = now + follow_up_backoff(row.attempts)
    action, entity = await _follow_up_audit(session, row)
    await audit.record(
        session,
        principal,
        action,
        entity,
        row.target_id,
        {
            "member_id": str(row.member_id),
            **({"email": row.email} if row.email else {}),
            "outcome": outcome,
            "attempt": row.attempts,
            "status": row.status,
            **({"error": error} if error else {}),
            **({"retried_by_owner": True} if manual else {}),
        },
    )
    await session.commit()
    return row


async def retry_follow_up(
    session: AsyncSession,
    principal: "Principal",
    follow_up_id: uuid.UUID,
    http: "httpx.AsyncClient",
) -> MemberFollowUp:
    """An owner's Retry (Inbox): make the call now, whatever its backoff or retry
    window. The caller is re-read under the gate first; the call does not hold it."""
    await _gate(session, principal, shared=True)
    row = await session.get(MemberFollowUp, follow_up_id)
    if row is None:
        raise MemberError("not_found", f"Follow-up {follow_up_id} not found")
    if row.status not in FOLLOW_UP_OPEN:
        raise MemberError("conflict", f"This follow-up is {row.status}; nothing to retry")
    await session.commit()
    done = await _attempt(session, principal, http, follow_up_id, FOLLOW_UP_OPEN, manual=True)
    if done is None:
        raise MemberError("conflict", "It is being tried right now, or it just finished")
    return done


async def dismiss_follow_up(
    session: AsyncSession, principal: "Principal", follow_up_id: uuid.UUID
) -> MemberFollowUp:
    """An owner's Dismiss (Inbox): stop trying. A provider revoke's copy of the
    credential is dropped; audited. The caller flushes; the router commits."""
    await _gate(session, principal, shared=True)
    row = await session.scalar(
        select(MemberFollowUp)
        .where(MemberFollowUp.id == follow_up_id)
        .with_for_update(skip_locked=True)
    )
    if row is None:
        if await session.get(MemberFollowUp, follow_up_id) is None:
            raise MemberError("not_found", f"Follow-up {follow_up_id} not found")
        raise MemberError("conflict", "It is being tried right now; look again in a minute")
    if row.status not in FOLLOW_UP_OPEN:
        raise MemberError("conflict", f"This follow-up is {row.status}; nothing to dismiss")
    now = datetime.now(UTC)
    row.status = "dismissed"
    row.dismissed_at = now
    row.dismissed_by = principal.id
    row.done_at = now
    row.next_attempt_at = None
    row.ciphertext = None
    await session.flush()
    action, entity = await _follow_up_audit(session, row)
    await audit.record(
        session,
        principal,
        f"{action}_dismissed",
        entity,
        row.target_id,
        {
            "member_id": str(row.member_id),
            "provider": row.provider,
            "attempts": row.attempts,
            "outcome": row.outcome,
            **({"error": row.last_error} if row.last_error else {}),
        },
    )
    return row


# A change to a person's Google IAP access that failed (oracle.members.delivery).
ACCESS_KINDS = ("iap_revoke", "iap_grant")


async def _follow_up_audit(session: AsyncSession, row: MemberFollowUp) -> tuple[str, str]:
    """The audit action and entity of a follow-up's attempt."""
    if row.kind in ACCESS_KINDS:
        from oracle.members import delivery

        return await delivery.follow_up_audit(session, row)
    if row.kind == "provider_revoke":
        return "connection.provider_revoke", "connection"
    return "run.runtime_cancel", "run_segment"


# A pending follow-up whose call succeeded but whose success failed to save (_attempt).
CALL_DONE = (*REVOKE_DONE, "cancelled")


@contextlib.asynccontextmanager
async def _call_deadline(deadline: float | None) -> "AsyncIterator[None]":
    """One network call's time: FOLLOW_UP_DEADLINE_SECONDS, cut to the run's budget
    (``deadline``, loop time), which raises :class:`_BudgetSpent`. Only the call is
    timed: a database query is never cancelled halfway (that can break the session)."""
    import asyncio

    loop = asyncio.get_running_loop()
    own = loop.time() + FOLLOW_UP_DEADLINE_SECONDS
    try:
        async with asyncio.timeout_at(own if deadline is None else min(own, deadline)):
            yield
    except TimeoutError:
        if deadline is not None and loop.time() >= deadline:
            raise _BudgetSpent from None
        raise


async def _follow_up(
    session: AsyncSession,
    row: MemberFollowUp,
    http: "httpx.AsyncClient",
    deadline: float | None = None,
) -> tuple[bool, str, str | None]:
    """Make one follow-up call: (succeeded, outcome, error)."""
    if row.outcome in CALL_DONE:
        return True, row.outcome, None  # made before; only its saving failed
    if row.kind in ACCESS_KINDS:
        from oracle.members import delivery

        return await delivery.follow_up_access(session, row, lambda: _call_deadline(deadline))
    if row.kind == "provider_revoke":
        from oracle.connections import service as connections
        from oracle.connections.models import Connection

        if row.ciphertext is None:
            return False, "unreadable", "Oracle no longer holds a copy of the credential"
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
            async with _call_deadline(deadline):
                outcome = await connections.revoke_at_provider(http, conn)
        except TimeoutError:
            return False, "failed", "the provider did not answer in time"
        return outcome in REVOKE_DONE, outcome, None

    from oracle.runs.models import RunSegment
    from oracle.swarm import RuntimeUnavailable, get_runtime

    segment = await session.get(RunSegment, row.target_id)
    if segment is not None and segment.status in ("pending", "running"):
        # Re-queued (or running again) since its workflow was cancelled: its error is
        # its own now (a queued submission's marker), not this cancel's.
        segment = None
    try:
        async with _call_deadline(deadline):
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
    session: AsyncSession,
    principal: "Principal",
    token_id: uuid.UUID,
    *,
    own: bool = False,
    gated: bool = False,
) -> ApiToken:
    """Revoke an API token; the approvals given through it lapse for good (C2), the
    approvals its user gave in person stand. Revoking twice is a no-op. With ``own``,
    a member revokes one of their personal tokens (My account): any role, and another
    member's token is not found. ``gated``: the caller already took the gate."""
    from oracle.review.state import lapse_approvals

    if not gated:
        await _gate(session, principal, role="viewer" if own else "owner")
    token = await session.get(ApiToken, token_id, with_for_update=True)
    if token is None or (own and (token.user_id is None or token.user_id != principal.user_id)):
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
    if token.user_id is None:
        # I1: a user-less token's webhooks pause, as a disabled member's do. A personal
        # token's webhooks are its member's, and pause only with the member.
        from oracle.webhooks import service as webhooks_service

        await webhooks_service.token_revoked(session, principal, token.id)
    return token


async def revoke_any_token(
    session: AsyncSession, principal: "Principal", token_id: uuid.UUID
) -> None:
    """Revoke a credential of any kind by its id (Settings > API tokens): an API token, a
    run token or an MCP client's grant. Owners only; twice is a no-op."""
    from oracle.members import tokens

    await _gate(session, principal)
    if await session.get(ApiToken, token_id) is not None:
        await revoke_api_token(session, principal, token_id, gated=True)
        return
    if await tokens.revoke_run_token(session, principal, token_id):
        return
    found = await tokens.grants(session, grant_id=token_id)
    if not found:
        raise MemberError("not_found", f"Token {token_id} not found")
    await tokens.revoke_grant(session, principal, found[0], "revoked by an owner")


async def token_approvals(
    session: AsyncSession, token_id: uuid.UUID
) -> list[dict[str, object]] | None:
    """Every approval given through an API token (section verdicts and version
    approvals), lapsed ones included; ``None`` for an unknown token."""
    if await session.get(ApiToken, token_id) is None:
        return None
    return await _approvals(session, {token_id})


async def member_approvals(
    session: AsyncSession, user_id: uuid.UUID, *, lapsed: bool = False
) -> list[dict[str, object]]:
    """``GET /v1/members/{id}/approvals`` (A5): the section verdicts and version
    approvals the member gave, in person or through their API tokens and grants;
    lapsed ones too with ``lapsed``."""
    if await session.get(User, user_id) is None:
        raise MemberError("not_found", f"Member {user_id} not found")
    rows = await _approvals(session, await _acted_as(session, user_id))
    return rows if lapsed else [r for r in rows if r["lapsed_at"] is None]


async def _approvals(session: AsyncSession, ids: set[uuid.UUID]) -> list[dict[str, object]]:
    """The approvals given by or through ``ids`` (users, API tokens), lapsed included."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.review.models import SectionReview

    out: list[dict[str, object]] = []
    rows = (
        await session.execute(
            select(SectionReview, DocumentVersion.number, Document.slug)
            .join(DocumentVersion, DocumentVersion.id == SectionReview.version_id)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(
                SectionReview.verdict == "approved",
                or_(SectionReview.token_id.in_(ids), SectionReview.reviewer_id.in_(ids)),
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
    who = or_(DocumentVersion.approved_token_id.in_(ids), DocumentVersion.approved_by.in_(ids))
    # A lapsed version approval is kept in approval_lapses (a new approval clears
    # approval_lapsed_*), naming its token, or a user-less token as the approver.
    tids = {str(i) for i in ids}
    in_history = or_(
        *(DocumentVersion.approval_lapses.contains([{"approved_token_id": t}]) for t in tids),
        *(DocumentVersion.approval_lapses.contains([{"approved_by": t}]) for t in tids),
    )
    lapsed_who = DocumentVersion.approval_lapsed_by.in_(ids)
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
            if tids & {e.get("approved_token_id"), e.get("approved_by")}
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
            version.approved_token_id in ids or version.approved_by in ids
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


def _own(principal: "Principal | None") -> list:
    """Approvers act on the invites they sent only (A5); owners on every invite."""
    if principal is None or principal.role == "owner":
        return []
    return [Invite.invited_by == principal.id]


async def _may_act_on(
    session: AsyncSession, principal: "Principal", invite: Invite | None, invite_id: uuid.UUID
) -> Invite:
    """The invite, when the caller may act on it: an approver only on the invites they sent
    (404 otherwise), and on another's only an owner, re-read under the gate the caller
    holds (an owner demoted while waiting is refused)."""
    from oracle.auth.service import caller_refusal

    if invite is None or (_own(principal) and invite.invited_by != principal.id):
        raise MemberError("not_found", f"Invite {invite_id} not found")
    if invite.invited_by != principal.id:
        refusal = await caller_refusal(session, principal, "owner")
        if refusal is not None:
            raise MemberError("forbidden", refusal)
    return invite


async def list_invites(
    session: AsyncSession, status: str, principal: "Principal | None" = None
) -> list[Invite]:
    """Invites with ``status``, or every invite for ``all``: ``open`` lists open and
    expired ones (both still need an action), ``expired`` only those past their expiry.
    An approver sees only the invites they sent."""
    now = datetime.now(UTC)
    stmt = select(Invite).where(*_own(principal)).order_by(Invite.created_at.desc())
    if status == "open":
        stmt = stmt.where(*_open())
    elif status == "expired":
        stmt = stmt.where(*_open(), Invite.expires_at <= now)
    elif status == "accepted":
        stmt = stmt.where(Invite.accepted_at.is_not(None))
    elif status == "revoked":
        stmt = stmt.where(Invite.revoked_at.is_not(None))
    return list((await session.scalars(stmt)).all())


async def create_invite(
    session: AsyncSession,
    principal: "Principal",
    email: str,
    role: Role,
    engineering_lead: bool = False,
    name: str | None = None,
    message: str | None = None,
) -> Invite:
    from oracle.auth.service import ReservedEmailError, check_email_allowed
    from oracle.members.access import invite_roles, least_inviter
    from oracle.members.leads import VIEWER_REFUSED

    if role not in invite_roles(principal):
        raise MemberError(
            "forbidden",
            "Approvers invite viewers and commenters. Ask an owner to invite an approver.",
        )
    if engineering_lead and principal.role != "owner":
        raise MemberError("forbidden", "Only an owner names an engineering lead")
    if engineering_lead and role == "viewer":
        raise MemberError("invalid", VIEWER_REFUSED)
    try:
        # One plain address only: the To header and the IAM member are built from it.
        email = plain_address(email)
    except ValueError:
        raise MemberError("invalid", "Not an email address") from None
    try:
        check_email_allowed(email)
    except ReservedEmailError as e:
        raise MemberError("invalid", str(e)) from None
    await check_invite_domain(session, email)
    await _gate(session, principal, shared=True, role=least_inviter(role, engineering_lead))
    member = await session.scalar(select(User).where(User.email == email))
    if member is not None and member.disabled_at is not None:
        raise MemberError("conflict", f"{email} is a removed member; restore them instead")
    if member is not None:
        raise MemberError("conflict", f"{email} is already a member")
    existing = await session.scalar(select(Invite).where(Invite.email == email, *_open()))
    if existing is not None and invite_status(existing) == "expired":
        raise MemberError("conflict", f"{email} has an expired invite; resend it")
    if existing is not None:
        raise MemberError("conflict", f"{email} already has an open invite; revoke it first")
    invite = Invite(
        email=email,
        name=name,
        role=role,
        engineering_lead=engineering_lead,
        invited_by=principal.id,
        expires_at=datetime.now(UTC) + INVITE_TTL,
        message=message,
    )
    session.add(invite)
    try:
        await session.flush()
    except IntegrityError:
        # A concurrent request invited the same email first; nothing is committed.
        raise MemberError("conflict", f"{email} already has an open invite") from None
    data: dict[str, object] = {"email": email, "role": role}
    if engineering_lead:
        data["engineering_lead"] = True
    if name:
        data["name"] = name
    await audit.record(session, principal, "invite.create", "invite", invite.id, data)
    return invite


async def check_invite_domain(session: AsyncSession, email: str) -> None:
    """With Google sign-in on, refuse an address sign-in would refuse: one outside the
    company's email domains (A5: ORACLE_IAP_ALLOWED_DOMAINS and the owner's
    company_email_domains), as such an invite can never be claimed. With Google sign-in
    off, invites are made as before."""
    from oracle.members.access import sign_in_domains

    settings = get_settings()
    if not settings.iap_audiences:
        # No Google sign-in: only the deployment's list, when set, as before A5.
        domains = [d.strip().lower().lstrip("@") for d in settings.iap_allowed_domains]
        domains = [d for d in domains if d]
        if domains and email.partition("@")[2] not in domains:
            named = (
                domains[0] if len(domains) == 1 else ", ".join(domains[:-1]) + " or " + domains[-1]
            )
            raise MemberError("invalid", f"Only addresses at {named} can sign in to Oracle")
        return
    domains = sorted(await sign_in_domains(session))
    if email.partition("@")[2] not in domains:
        named = ", ".join(domains) or "none set yet"
        raise MemberError(
            "invalid",
            f"{email} is outside the company's email domains ({named}), so Google sign-in "
            "can't let them join. Add the domain under Sign-in first.",
        )


async def resend_invite(
    session: AsyncSession, principal: "Principal", invite_id: uuid.UUID
) -> Invite:
    """Give an open or expired invite 14 more days (A5). An approver resends only the
    invites they sent (404 otherwise)."""
    await _gate(session, principal, shared=True, role="approver")
    invite = await _may_act_on(
        session, principal, await session.get(Invite, invite_id, with_for_update=True), invite_id
    )
    if invite.accepted_at is not None or invite.revoked_at is not None:
        raise MemberError("conflict", f"This invite was {invite_status(invite)}; invite them again")
    now = datetime.now(UTC)
    invite.expires_at = now + INVITE_TTL
    invite.resent_at = now
    invite.resend_count += 1
    await session.flush()
    data = {"email": invite.email, "expires_at": invite.expires_at.isoformat()}
    await audit.record(session, principal, "invite.resend", "invite", invite.id, data)
    return invite


async def get_open_invite(
    session: AsyncSession, principal: "Principal", invite_id: uuid.UUID
) -> Invite:
    """The open invite ``invite_id``, locked: Retry access and Resend email act on it.
    Owners only, re-read under the gate (an owner demoted while waiting is refused)."""
    await _gate(session, principal, shared=True)
    invite = await session.get(Invite, invite_id, with_for_update=True)
    if invite is None:
        raise MemberError("not_found", f"Invite {invite_id} not found")
    if invite_status(invite) != "open":
        raise MemberError("conflict", f"This invite was {invite_status(invite)}; invite them again")
    return invite


async def revoke_invite(
    session: AsyncSession, principal: "Principal", invite_id: uuid.UUID
) -> Invite:
    await _gate(session, principal, shared=True, role="approver")
    invite = await _may_act_on(
        session, principal, await session.get(Invite, invite_id, with_for_update=True), invite_id
    )
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
    """Lock and mark accepted the open, unexpired invite for ``email``, if any (caller
    commits)."""
    now = datetime.now(UTC)
    invite = await session.scalar(
        select(Invite)
        .where(Invite.email == email, *_open(), Invite.expires_at > now)
        .with_for_update()
    )
    if invite is not None:
        invite.accepted_at = now
    return invite


async def expired_invite(session: AsyncSession, email: str) -> Invite | None:
    """The open invite for ``email`` past its expiry, if any (A5: never claimed)."""
    return await session.scalar(
        select(Invite).where(
            Invite.email == email, *_open(), Invite.expires_at <= datetime.now(UTC)
        )
    )
