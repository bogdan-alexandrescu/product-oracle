"""Passwords (argon2), API tokens (sha256 of a random secret) and session cookies."""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import ApiToken, Role, User
from oracle.config import get_settings
from oracle.tenancy import unscoped_session

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

TOKEN_PREFIX = "po_"
_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def hash_token(raw: str) -> str:
    # Tokens are 256-bit random secrets, so a fast hash is enough (no brute force).
    return hashlib.sha256(raw.encode()).hexdigest()


async def create_user(session: AsyncSession, email: str, password: str) -> User:
    user = User(email=email.strip().lower(), password_hash=hash_password(password), role="owner")
    session.add(user)
    await session.flush()
    return user


async def create_api_token(
    session: AsyncSession, name: str, *, user_id: uuid.UUID | None = None
) -> tuple[ApiToken, str]:
    """Create a token in the session's tenant. Returns (row, raw token); show raw once.

    With ``user_id`` the token acts as that user (their role and their own data).
    """
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    token = ApiToken(name=name, token_hash=hash_token(raw), user_id=user_id)
    session.add(token)
    await session.flush()
    return token, raw


def may_sign_in(user: User | None) -> bool:
    """Whether ``user`` may sign in on any path: it exists and is not disabled (C2)."""
    return user is not None and user.disabled_at is None


async def authenticate_user(email: str, password: str) -> User | None:
    # Runs before a tenant is known, hence unscoped.
    async with unscoped_session() as s:
        users = (await s.scalars(select(User).where(User.email == email.strip().lower()))).all()
    active = [u for u in users if may_sign_in(u)]
    for user in active:
        # A disabled member's password no longer signs in; the same email may be an
        # active member of another company, so a disabled row never ends the search.
        if verify_password(user.password_hash, password):
            return user
    # Equalise timing when the email is unknown or only disabled.
    if not active:
        verify_password(_DUMMY_HASH, password)
    return None


async def resolve_api_token(raw: str) -> ApiToken | None:
    """Look up an active token by its raw value and record its use."""
    async with unscoped_session() as s:
        token = await s.scalar(select(ApiToken).where(ApiToken.token_hash == hash_token(raw)))
        if token is None or token.revoked_at is not None:
            return None
        token.last_used_at = datetime.now(UTC)
        await s.commit()
        return token


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="oracle-session")


def make_session_cookie(user: User) -> str:
    # "i": when it was signed, in microseconds (the signature's own timestamp has whole
    # seconds only, too coarse to tell a cookie from the second of a restore).
    issued = int(datetime.now(UTC).timestamp() * 1_000_000)
    return _serializer().dumps({"u": str(user.id), "t": str(user.tenant_id), "i": issued})


def _run_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="oracle-run-binding")


def sign_run_binding(user_id: uuid.UUID, run_id: uuid.UUID) -> str:
    """The value of ``x-oracle-run-id``: a run id signed by the server and bound to the
    user whose credential carries it. Only the MCP layer mints one, for a run token's
    in-process REST call; a bare run id from a client is not a run."""
    return _run_serializer().dumps({"u": str(user_id), "r": str(run_id)})


def read_run_binding(value: str, user_id: uuid.UUID | None) -> uuid.UUID | None:
    """The run id of a valid, unexpired binding signed for ``user_id``, else None."""
    if user_id is None:
        return None
    try:
        data = _run_serializer().loads(value, max_age=get_settings().run_binding_max_age_seconds)
        if uuid.UUID(data["u"]) != user_id:
            return None
        return uuid.UUID(data["r"])
    except (BadSignature, KeyError, ValueError, TypeError, AttributeError):
        return None


@dataclass(frozen=True)
class SessionCookie:
    user_id: uuid.UUID
    tenant_id: uuid.UUID
    signed_at: datetime


def read_session_cookie(value: str) -> SessionCookie | None:
    """The user, tenant and signing time of a valid, unexpired cookie, else None."""
    try:
        data, stamp = _serializer().loads(
            value, max_age=get_settings().session_max_age_seconds, return_timestamp=True
        )
        signed_at = stamp
        if "i" in data:
            signed_at = datetime.fromtimestamp(int(data["i"]) / 1_000_000, UTC)
        return SessionCookie(uuid.UUID(data["u"]), uuid.UUID(data["t"]), signed_at)
    except (BadSignature, KeyError, ValueError, TypeError, OverflowError):
        return None


def session_is_current(user: User | None, signed_at: datetime) -> bool:
    """Whether a session cookie signed at ``signed_at`` signs ``user`` in: they may sign
    in now (active, in this company), and the cookie was signed at or after their
    ``sessions_valid_after`` (set by a disable and by a restore; C2: a disable ends every
    session, a restored member signs in fresh). ``signed_at`` is the cookie's own issue
    time in microseconds; a cookie made before it carried one (``read_session_cookie``)
    has only the signature's time, truncated to whole seconds, so such a cookie signed
    in the same second as a disable or restore is refused (it counts from the next whole
    second)."""
    if not may_sign_in(user):
        return False
    after = user.sessions_valid_after  # type: ignore[union-attr]
    return after is None or signed_at >= after


async def caller_refusal(session: AsyncSession, principal: "Principal", role: Role) -> str | None:
    """Why ``principal`` may no longer act with ``role``, read now, or ``None``.

    For a re-read under the review gate: a request authenticates before it waits on the
    gate, and a disable, a demotion or a revocation may commit while it waits. Its API
    token, MCP OAuth grant or run token must still be active, a user-less token still have the
    role, and the person behind it still be an active member with the role."""
    from oracle.authz import has_role
    from oracle.mcp.oauth.models import OAuthToken

    if principal.token_id is not None:
        row = (
            await session.execute(
                select(ApiToken.revoked_at, ApiToken.role).where(ApiToken.id == principal.token_id)
            )
        ).first()
        if row is None or row.revoked_at is not None:
            return "This API token was revoked"
        if principal.user_id is None and not has_role(row.role, role):
            return f"Requires the {role} role"
    if principal.run_token_id is not None:
        from oracle.runtokens import RunToken

        row = (
            await session.execute(
                select(RunToken.revoked_at, RunToken.expires_at).where(
                    RunToken.id == principal.run_token_id
                )
            )
        ).first()
        if row is None or row.revoked_at is not None or row.expires_at <= datetime.now(UTC):
            return "This run's token was revoked"
    if principal.grant_id is not None:
        live = await session.scalar(
            select(OAuthToken.id)
            .where(OAuthToken.family_id == principal.grant_id, OAuthToken.revoked_at.is_(None))
            .limit(1)
        )
        if live is None:
            return "This OAuth grant was revoked"
    if principal.user_id is not None:
        row = (
            await session.execute(
                select(User.role, User.disabled_at).where(User.id == principal.user_id)
            )
        ).first()
        if row is None or row.disabled_at is not None:
            return "Your access to this company was removed"
        if not has_role(row.role, role):
            return f"Requires the {role} role"
    return None


_DUMMY_HASH = hash_password(secrets.token_hex(16))
