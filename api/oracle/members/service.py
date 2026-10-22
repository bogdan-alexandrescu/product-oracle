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
from oracle.members.models import Invite, MemberFollowUp
from oracle.members.schemas import InviteOut, InviteStatus, MemberOut
from oracle.tenant_settings import TenantSetting

if TYPE_CHECKING:
    import httpx

    from oracle.auth.deps import Principal

log = logging.getLogger(__name__)

IAP_DEFAULT_ROLE_KEY = "iap_default_role"
FALLBACK_IAP_ROLE: Role = "commenter"


class MemberError(Exception):
    """A request the members service refuses; the router maps ``kind`` to an HTTP status."""

    def __init__(self, kind: str, message: str):
        self.kind = kind  # "not_found" | "conflict" | "forbidden" | "invalid"
        self.message = message
        super().__init__(message)


def invite_status(invite: Invite) -> InviteStatus:
    if invite.revoked_at is not None:
        return "revoked"
    if invite.accepted_at is not None:
        return "accepted"
    return "open"


def invite_out(invite: Invite) -> InviteOut:
    from oracle.members.delivery import sign_in_url

    return InviteOut(
        id=invite.id,
        email=invite.email,
        role=invite.role,
        status=invite_status(invite),
        invited_by=invite.invited_by,
        created_at=invite.created_at,
        accepted_at=invite.accepted_at,
        revoked_at=invite.revoked_at,
        access=invite.access,
        access_error=invite.access_error,
        access_at=invite.access_at,
        email_status=invite.email_status,
        email_error=invite.email_error,
        email_at=invite.email_at,
        sign_in_url=sign_in_url(),
    )


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
    return [
        MemberOut.model_validate(u).model_copy(update={"open_tokens": counts.get(u.id, 0)})
        for u in users
    ]


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
    user.role = role
    await session.flush()
    await audit.record(
        session, principal, "member.role", "user", user.id, {"before": before, "after": role}
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
    from oracle.runs.service import FINAL, stop_run, void_owed_decisions
    from oracle.sources.models import Source

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
    decisions = await _void_checkpoint_decisions(session, principal, acted_as, via)
    # Decisions recorded and not delivered to their run yet (SwarmCloud did not take the
    # post): never delivered now.
    decisions += await void_owed_decisions(
        session, principal, acted_as, "its decider was removed (disabled)", via
    )
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


async def _cancel_llm_jobs(
    session: AsyncSession, requesters: set[uuid.UUID], at: datetime
) -> list[uuid.UUID]:
    """Cancel the queued built-in model jobs the removed member requested: nothing more
    is spent for them. A job already running finishes (its call is under way). A job a
    worker is claiming right now is waited for (a claim holds its row for a moment), not
    skipped: it is cancelled if still queued, or finishes if the claim started it."""
    from oracle.jobs.models import LlmJob

    jobs = list(
        await session.scalars(
            select(LlmJob)
            .where(LlmJob.status == "queued", LlmJob.requested_by.in_(requesters))
            .with_for_update()
            .execution_options(populate_existing=True)
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
    from oracle.runs.models import Run, RunSegment
    from oracle.runs.service import FINAL, unqueue
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
                Run.created_by.is_distinct_from(member_id) if member_id else true(),
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
    from oracle.runs.models import Run, RunSegment
    from oracle.runs.service import RESUME_VOIDED, _art, _set_art, _set_knob, unqueue
    from oracle.runtokens import revoke_run_tokens

    since = select(RunSegment.id).where(
        RunSegment.run_id == Run.id, RunSegment.started_at >= Run.resumed_at
    )
    runs = list(
        await session.scalars(
            select(Run)
            .where(
                Run.resumed_by.in_(approvers),
                Run.status.in_(("running", "awaiting_checkpoint")),
                Run.created_by.is_distinct_from(member_id) if member_id else true(),
                ~since.exists(),
            )
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
) -> list[uuid.UUID]:
    """A checkpoint decision the removed member gave whose segment has not been
    submitted yet (the submission is under way, or waits for the tick's retry) is void,
    as a spend approval is: the checkpoint waits for a decision again, nothing runs for
    it. A decision whose workflow was submitted stands (it is running). With
    ``keep_role`` (a demotion), a decision on a checkpoint that role may still decide
    stands."""
    from oracle.authz import has_role
    from oracle.runs.models import Checkpoint, Run, RunSegment
    from oracle.runs.service import void_decision

    decided = [str(d) for d in deciders]
    candidates = (
        await session.execute(
            select(RunSegment.id, RunSegment.run_id)
            .join(Run, Run.id == RunSegment.run_id)
            .where(
                Run.status == "running",
                RunSegment.status == "pending",
                RunSegment.artifacts["decision"]["decided_by"].astext.in_(decided),
            )
        )
    ).all()
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
        if cp is None or cp.run_id != run.id:
            continue
        if keep_role is not None and has_role(keep_role, cp.approver_role):  # type: ignore[arg-type]
            continue
        await void_decision(session, principal, run, segment, cp, via)
        voided.append(cp.id)
    return voided


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
# keeps its copy of the credential and stays in the owners' Inbox (Retry, Dismiss).
FOLLOW_UP_RETRY_WINDOW = timedelta(hours=24)
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
        MemberFollowUp.status == "pending",
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
            row = await _attempt(session, principal, http, follow_up_id, ("pending",), deadline)
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
        # No more automatic retries; the copy stays for an owner's Retry or Dismiss.
        row.status = "failed"
        row.next_attempt_at = None
    else:
        row.status = "pending"
        row.next_attempt_at = now + follow_up_backoff(row.attempts)
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
    await audit.record(
        session,
        principal,
        "connection.provider_revoke_dismissed"
        if row.kind == "provider_revoke"
        else "run.runtime_cancel_dismissed",
        "connection" if row.kind == "provider_revoke" else "run_segment",
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
    from oracle.auth.service import ReservedEmailError, check_email_allowed

    try:
        check_email_allowed(email)
    except ReservedEmailError as e:
        raise MemberError("invalid", str(e)) from None
    check_invite_domain(email)
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


def check_invite_domain(email: str) -> None:
    """Refuse an address Google sign-in would refuse: one outside ORACLE_IAP_ALLOWED_DOMAINS
    (when set; with none set every domain is let through, as sign-in has no IAP then)."""
    domains = [d.strip().lower().lstrip("@") for d in get_settings().iap_allowed_domains]
    domains = [d for d in domains if d]
    if domains and email.rsplit("@", 1)[-1] not in domains:
        named = domains[0] if len(domains) == 1 else ", ".join(domains[:-1]) + " or " + domains[-1]
        raise MemberError("invalid", f"Only addresses at {named} can sign in to Oracle")


async def get_open_invite(session: AsyncSession, invite_id: uuid.UUID) -> Invite:
    """The open invite ``invite_id``, locked: Retry access and Resend act on it."""
    invite = await session.get(Invite, invite_id, with_for_update=True)
    if invite is None:
        raise MemberError("not_found", f"Invite {invite_id} not found")
    if invite_status(invite) != "open":
        raise MemberError("conflict", f"This invite was {invite_status(invite)}; invite them again")
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
