"""Passwords (argon2), API tokens (sha256 of a random secret) and session cookies."""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import ApiToken, User
from oracle.config import get_settings
from oracle.tenancy import unscoped_session

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


def issued_in_force(user: User, issued_at: datetime | None) -> bool:
    """Whether a session or credential of ``user`` issued at ``issued_at`` still holds:
    a disable ends every session, and a restored member signs in fresh, so anything
    issued before ``sessions_valid_after`` is dead (C2). Unknown issue time: dead once
    there is a cut-off."""
    return in_force(user.sessions_valid_after, issued_at)


def in_force(cutoff: datetime | None, issued_at: datetime | None) -> bool:
    """:func:`issued_in_force` for a cut-off read on its own."""
    if cutoff is None:
        return True
    return issued_at is not None and issued_at >= cutoff


async def authenticate_user(email: str, password: str) -> User | None:
    # Runs before a tenant is known, hence unscoped.
    async with unscoped_session() as s:
        users = (await s.scalars(select(User).where(User.email == email.strip().lower()))).all()
    for user in users:
        # A disabled member's password no longer signs in; the same email in another
        # company still does.
        if may_sign_in(user) and verify_password(user.password_hash, password):
            return user
    # Equalise timing when the email is unknown, or only on disabled rows.
    if not any(may_sign_in(u) for u in users):
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
    # "i": when it was signed, to the microsecond (the signer's own timestamp has whole
    # seconds), so a sign-in just after a restore is not taken for one before it.
    return _serializer().dumps(
        {"u": str(user.id), "t": str(user.tenant_id), "i": datetime.now(UTC).timestamp()}
    )


@dataclass(frozen=True)
class SessionCookie:
    user_id: uuid.UUID
    tenant_id: uuid.UUID
    # When it was signed: checked against the user's sessions_valid_after.
    signed_at: datetime


def read_session_cookie(value: str) -> SessionCookie | None:
    """The user, tenant and signing time of a valid, unexpired cookie, else None.

    A cookie from before the precise ``i`` claim falls back to the signer's timestamp,
    truncated to the second: it reads as signed earlier, never later."""
    try:
        data, stamped = _serializer().loads(
            value, max_age=get_settings().session_max_age_seconds, return_timestamp=True
        )
        signed_at = stamped
        if isinstance(data.get("i"), int | float):
            precise = datetime.fromtimestamp(data["i"], UTC)
            # Signed with the cookie, so trusted; never later than the signature itself.
            if precise < stamped + timedelta(seconds=1):
                signed_at = precise
        return SessionCookie(uuid.UUID(data["u"]), uuid.UUID(data["t"]), signed_at)
    except (BadSignature, KeyError, ValueError, TypeError, AttributeError, OverflowError):
        return None


_DUMMY_HASH = hash_password(secrets.token_hex(16))
