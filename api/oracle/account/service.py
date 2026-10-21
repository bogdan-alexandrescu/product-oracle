"""My account: a member's own password, personal tokens, MCP clients and sessions.

Functions flush, never commit (except a failed password attempt, which must be kept to
count against the rate limit); the router commits once per request.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import ApiToken, User
from oracle.auth.service import create_api_token, hash_password_async, verify_password_async
from oracle.members import tokens
from oracle.members.service import MemberError, _gate, revoke_api_token
from oracle.models import AuditEvent

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

# At most this many wrong current passwords per window; then every attempt waits.
PASSWORD_ATTEMPTS = 5
PASSWORD_WINDOW = timedelta(minutes=15)


class RateLimited(Exception):
    def __init__(self, retry_after: int):
        self.retry_after = retry_after
        super().__init__(f"Too many attempts; try again in {retry_after} s")


async def _user(session: AsyncSession, principal: "Principal", *, lock: bool = False) -> User:
    user = await session.get(User, principal.user_id, with_for_update=lock)
    if user is None:  # the dependency resolved them a moment ago
        raise MemberError("not_found", "Your account was not found")
    return user


async def _attempt_lock(session: AsyncSession, user: User) -> None:
    """A per-member, transaction-scoped advisory lock over a password change: the
    failures are counted and a failure recorded under it, so attempts racing each other
    never all see the same empty window. Taken before the review gate (never after), and
    released when the attempt commits or rolls back."""
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
        {"k": f"oracle-password-change:{user.id}"},
    )


async def _failures(session: AsyncSession, user: User, now: datetime) -> list[datetime]:
    """Wrong current passwords in the window, since the last successful change."""
    since = now - PASSWORD_WINDOW
    last_ok = await session.scalar(
        select(func.max(AuditEvent.created_at)).where(
            AuditEvent.entity_id == user.id, AuditEvent.action == "password.change"
        )
    )
    if last_ok is not None and last_ok > since:
        since = last_ok
    return list(
        await session.scalars(
            select(AuditEvent.created_at)
            .where(
                AuditEvent.entity_id == user.id,
                AuditEvent.action == "password.change_failed",
                AuditEvent.created_at > since,
            )
            .order_by(AuditEvent.created_at)
        )
    )


def browser_only(principal: "Principal", what: str) -> None:
    """Creating a personal token, changing the password and signing out of every device
    work only from the signed-in browser (AC1, owner 2026-10-20): never through an API
    token or an MCP client, so a leaked credential can neither mint a longer-lived one
    nor lock its person out."""
    if principal.token_id is not None or principal.grant_id is not None:
        raise MemberError(
            "forbidden", f"{what} works only from the signed-in browser, not with a token"
        )


async def _writable(session: AsyncSession, principal: "Principal") -> None:
    """A read-only credential (an ``oracle:read`` token or MCP client) makes no account
    changes (AC1)."""
    if "oracle:write" not in await caller_scopes(session, principal):
        raise MemberError("forbidden", "This credential is read-only; it changes nothing")


async def _account_gate(session: AsyncSession, principal: "Principal") -> None:
    """The review gate for a change to the caller's own credentials, then the caller
    re-read under it (a disable that commits first wins). Revoking a credential lapses
    the approvals given through it, which publishes read: a member who may approve takes
    the gate exclusively; anyone else gives no approvals, so takes it shared and never
    stalls the company's publishes."""
    from oracle.authz import has_role

    role = await session.scalar(select(User.role).where(User.id == principal.user_id))
    await _gate(
        session, principal, shared=not has_role(role or "viewer", "approver"), role="viewer"
    )


async def _end_credentials(
    session: AsyncSession, principal: "Principal", user: User, why: str
) -> dict[str, list[str]]:
    """Revoke every credential that acts for ``user`` besides a browser session (AC1):
    their personal API tokens (approvals given through them lapse), every MCP client they
    authorized (the whole family, refresh tokens included, and codes not yet exchanged)
    and the current run tokens of the runs they started that are still going (the runs
    keep running; their next segment is given a new run token). The caller holds the
    gate."""
    from oracle.mcp.oauth.models import OAuthCode
    from oracle.runs.models import Run
    from oracle.runs.service import FINAL
    from oracle.runtokens import RunToken, revoke_run_tokens

    api_tokens = list(
        await session.scalars(
            select(ApiToken.id).where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
        )
    )
    for token_id in api_tokens:
        await revoke_api_token(session, principal, token_id, own=True, gated=True)
    grants = [g for g in await tokens.grants(session, user_id=user.id) if g.revoked_at is None]
    for grant in grants:
        await tokens.revoke_grant(session, principal, grant, why)
    runs = list(
        await session.scalars(
            select(Run.id)
            .join(RunToken, RunToken.run_id == Run.id)
            .where(
                Run.created_by == user.id,
                Run.status.not_in(FINAL),
                RunToken.revoked_at.is_(None),
            )
            .distinct()
        )
    )
    for run_id in runs:
        await revoke_run_tokens(session, run_id)
    # Authorization codes not yet exchanged would start a new grant: void them (the
    # exchange also refuses a code older than ``sessions_valid_after``).
    now = datetime.now(UTC)
    await session.execute(
        update(OAuthCode)
        .where(
            OAuthCode.user_id == user.id,
            OAuthCode.used_at.is_(None),
            OAuthCode.expires_at > now,
        )
        .values(expires_at=now)
    )
    await session.flush()
    return {
        "api_tokens": [str(i) for i in api_tokens],
        "mcp_grants": [str(g.id) for g in grants],
        "run_token_runs": [str(i) for i in runs],
    }


async def change_password(
    session: AsyncSession, principal: "Principal", current: str, new: str
) -> tuple[User, dict[str, list[str]]]:
    """Set a new password after checking the current one, from the signed-in browser
    only. Rate-limited per member (a wrong current password counts; after
    PASSWORD_ATTEMPTS in PASSWORD_WINDOW every attempt is refused until the oldest
    leaves the window). Every session signed so far ends (``sessions_valid_after``), and
    every other credential of theirs is revoked (:func:`_end_credentials`, AC1); the
    caller gives this browser a fresh session.

    The (slow) password check runs in a worker thread, under the member's attempt lock
    (:func:`_attempt_lock`) and before the gate; under the gate the row is locked and
    must still hold the hash that was checked, so two changes cannot both win."""
    browser_only(principal, "Changing your password")
    user = await _user(session, principal)
    if not user.password_sign_in:
        raise MemberError(
            "conflict", "You sign in with Google; there is no Oracle password to change"
        )
    await _attempt_lock(session, user)
    now = datetime.now(UTC)
    failures = await _failures(session, user, now)
    if len(failures) >= PASSWORD_ATTEMPTS:
        wait = failures[-PASSWORD_ATTEMPTS] + PASSWORD_WINDOW - now
        raise RateLimited(max(1, int(wait.total_seconds()) + 1))
    checked = user.password_hash
    if not await verify_password_async(checked, current):
        await audit.record(session, principal, "password.change_failed", "user", user.id)
        # Kept although the request fails: it counts against the limit.
        await session.commit()
        raise MemberError("invalid_password", "Your current password is not correct")
    if new == current:
        raise MemberError("invalid_password", "Choose a new password, not your current one")
    await _account_gate(session, principal)
    user = await session.scalar(
        select(User)
        .where(User.id == principal.user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None or user.password_hash != checked:
        raise MemberError("conflict", "Your password was changed meanwhile; sign in again")
    user.password_hash = await hash_password_async(new)
    # Read after the row lock: a sign-in holding it stamped its cookie before this.
    user.sessions_valid_after = datetime.now(UTC)
    await session.flush()
    revoked = await _end_credentials(session, principal, user, "password changed")
    await audit.record(session, principal, "password.change", "user", user.id, revoked)
    return user, revoked


async def caller_scopes(session: AsyncSession, principal: "Principal") -> set[str]:
    """What the credential of this request may do: a personal token's or MCP grant's
    scopes; a browser session may do everything."""
    if principal.token_id is not None:
        scope = await session.scalar(
            select(ApiToken.scope).where(ApiToken.id == principal.token_id)
        )
        return set(tokens.scopes_of(scope))
    if principal.grant_id is not None:
        found = await tokens.grants(session, grant_id=principal.grant_id)
        return set(tokens.scopes_of(found[0].scope if found else "oracle:read"))
    return set(tokens.FULL_SCOPES)


async def create_personal_token(
    session: AsyncSession,
    principal: "Principal",
    name: str,
    scopes: list[str],
    expires_in_days: int | None,
) -> tuple[ApiToken, str]:
    """A new personal API token acting as the caller, capped by ``scopes``, expiring
    after ``expires_in_days`` (None: never). From the signed-in browser only (AC1), so a
    token never mints another; the caller is re-read under the gate, so a token minted
    while a disable commits cannot outlive it."""
    browser_only(principal, "Creating a personal API token")
    await _gate(session, principal, shared=True, role="viewer")
    wanted = sorted(set(scopes))
    expires_at = datetime.now(UTC) + timedelta(days=expires_in_days) if expires_in_days else None
    token, raw = await create_api_token(
        session, name, user_id=principal.user_id, scope=" ".join(wanted), expires_at=expires_at
    )
    await audit.record(
        session,
        principal,
        "api_token.create",
        "api_token",
        token.id,
        {
            "name": name,
            "scopes": wanted,
            "user_id": str(principal.user_id),
            "expires_at": expires_at.isoformat() if expires_at else None,
        },
    )
    return token, raw


async def my_tokens(session: AsyncSession, principal: "Principal"):
    return await tokens.list_tokens(session, kind="personal", user_id=principal.user_id)


async def revoke_my_token(session: AsyncSession, principal: "Principal", token_id: uuid.UUID):
    """Revoke one of the caller's personal tokens. Looked up before the gate: another
    member's token, or an unknown id, is a 404 that never waits on (or holds) it."""
    await _writable(session, principal)
    token = await session.get(ApiToken, token_id)
    if token is None or token.user_id is None or token.user_id != principal.user_id:
        raise MemberError("not_found", f"API token {token_id} not found")
    if token.revoked_at is not None:
        return token
    await _account_gate(session, principal)
    return await revoke_api_token(session, principal, token_id, own=True, gated=True)


async def my_grants(session: AsyncSession, principal: "Principal") -> list[tokens.Grant]:
    return await tokens.grants(session, user_id=principal.user_id)


async def revoke_my_grant(
    session: AsyncSession, principal: "Principal", grant_id: uuid.UUID
) -> None:
    await _writable(session, principal)
    found = await tokens.grants(session, grant_id=grant_id)
    if not found or found[0].user_id != principal.user_id:
        raise MemberError("not_found", f"MCP client grant {grant_id} not found")
    if found[0].revoked_at is not None:
        return
    await _account_gate(session, principal)
    found = await tokens.grants(session, grant_id=grant_id)
    await tokens.revoke_grant(session, principal, found[0], "revoked by its member")


async def sign_out_everywhere(
    session: AsyncSession, principal: "Principal"
) -> tuple[datetime, dict[str, list[str]]]:
    """End every session of the caller (the per-user session epoch,
    ``sessions_valid_after``, checked on every request) and revoke every other
    credential of theirs (:func:`_end_credentials`, AC1): personal API tokens, MCP
    clients (refresh tokens included) and the run tokens of their runs still going.
    From the signed-in browser only."""
    browser_only(principal, "Signing out of every device")
    await _account_gate(session, principal)
    user = await _user(session, principal, lock=True)
    at = datetime.now(UTC)
    user.sessions_valid_after = at
    revoked = await _end_credentials(session, principal, user, "signed out everywhere")
    await session.flush()
    await audit.record(session, principal, "member.sign_out_everywhere", "user", user.id, revoked)
    return at, revoked
