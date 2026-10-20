"""My account: a member's own password, personal tokens, MCP clients and sessions.

Functions flush, never commit (except a failed password attempt, which must be kept to
count against the rate limit); the router commits once per request.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import ApiToken, User
from oracle.auth.service import create_api_token, hash_password, verify_password
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


async def change_password(
    session: AsyncSession, principal: "Principal", current: str, new: str
) -> User:
    """Set a new password after checking the current one. Rate-limited per member (a
    wrong current password counts; after PASSWORD_ATTEMPTS in PASSWORD_WINDOW every
    attempt is refused until the oldest leaves the window). Every session signed so far
    ends (``sessions_valid_after``); the caller gives this browser a fresh one."""
    user = await _user(session, principal, lock=True)
    if not user.password_sign_in:
        raise MemberError(
            "conflict", "You sign in with Google; there is no Oracle password to change"
        )
    now = datetime.now(UTC)
    failures = await _failures(session, user, now)
    if len(failures) >= PASSWORD_ATTEMPTS:
        wait = failures[-PASSWORD_ATTEMPTS] + PASSWORD_WINDOW - now
        raise RateLimited(max(1, int(wait.total_seconds()) + 1))
    if not verify_password(user.password_hash, current):
        await audit.record(session, principal, "password.change_failed", "user", user.id)
        # Kept although the request fails: it counts against the limit.
        await session.commit()
        raise MemberError("invalid_password", "Your current password is not correct")
    user.password_hash = hash_password(new)
    user.sessions_valid_after = now
    await session.flush()
    await audit.record(session, principal, "password.change", "user", user.id)
    return user


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
    session: AsyncSession, principal: "Principal", name: str, scopes: list[str]
) -> tuple[ApiToken, str]:
    """A new personal API token acting as the caller, capped by ``scopes``. A token or
    an MCP client may only create one with scopes it holds itself."""
    wanted = set(scopes)
    if not wanted <= await caller_scopes(session, principal):
        raise MemberError(
            "forbidden", "This credential cannot create a token with more scopes than it has"
        )
    token, raw = await create_api_token(
        session, name, user_id=principal.user_id, scope=" ".join(sorted(wanted))
    )
    await audit.record(
        session,
        principal,
        "api_token.create",
        "api_token",
        token.id,
        {"name": name, "scopes": sorted(wanted), "user_id": str(principal.user_id)},
    )
    return token, raw


async def my_tokens(session: AsyncSession, principal: "Principal"):
    return await tokens.list_tokens(session, kind="personal", user_id=principal.user_id)


async def revoke_my_token(session: AsyncSession, principal: "Principal", token_id: uuid.UUID):
    return await revoke_api_token(session, principal, token_id, own=True)


async def my_grants(session: AsyncSession, principal: "Principal") -> list[tokens.Grant]:
    return await tokens.grants(session, user_id=principal.user_id)


async def revoke_my_grant(
    session: AsyncSession, principal: "Principal", grant_id: uuid.UUID
) -> None:
    await _gate(session, principal, role="viewer")
    found = await tokens.grants(session, grant_id=grant_id)
    if not found or found[0].user_id != principal.user_id:
        raise MemberError("not_found", f"MCP client grant {grant_id} not found")
    await tokens.revoke_grant(session, principal, found[0], "revoked by its member")


async def sign_out_everywhere(
    session: AsyncSession, principal: "Principal"
) -> tuple[datetime, int]:
    """End every session of the caller (the per-user session epoch,
    ``sessions_valid_after``, checked on every request) and every MCP client's grant,
    refresh tokens included. Personal API tokens stay: revoke them one by one."""
    await _gate(session, principal, role="viewer")
    user = await _user(session, principal, lock=True)
    at = datetime.now(UTC)
    user.sessions_valid_after = at
    live = [g for g in await tokens.grants(session, user_id=user.id) if g.live]
    for grant in live:
        await tokens.revoke_grant(session, principal, grant, "signed out everywhere")
    await session.flush()
    await audit.record(
        session,
        principal,
        "member.sign_out_everywhere",
        "user",
        user.id,
        {"mcp_grants": [str(g.id) for g in live]},
    )
    return at, len(live)
