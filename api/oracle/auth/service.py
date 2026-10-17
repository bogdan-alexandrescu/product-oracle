"""Passwords (argon2), API tokens (sha256 of a random secret) and session cookies."""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime

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


async def create_api_token(session: AsyncSession, name: str) -> tuple[ApiToken, str]:
    """Create a token in the session's tenant. Returns (row, raw token); show raw once."""
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    token = ApiToken(name=name, token_hash=hash_token(raw))
    session.add(token)
    await session.flush()
    return token, raw


async def authenticate_user(email: str, password: str) -> User | None:
    # Runs before a tenant is known, hence unscoped.
    async with unscoped_session() as s:
        users = (await s.scalars(select(User).where(User.email == email.strip().lower()))).all()
    for user in users:
        if verify_password(user.password_hash, password):
            return user
    # Equalise timing when the email is unknown.
    if not users:
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
    return _serializer().dumps({"u": str(user.id), "t": str(user.tenant_id)})


def read_session_cookie(value: str) -> tuple[uuid.UUID, uuid.UUID] | None:
    """Return (user_id, tenant_id) from a valid, unexpired cookie, else None."""
    try:
        data = _serializer().loads(value, max_age=get_settings().session_max_age_seconds)
        return uuid.UUID(data["u"]), uuid.UUID(data["t"])
    except (BadSignature, KeyError, ValueError, TypeError):
        return None


_DUMMY_HASH = hash_password(secrets.token_hex(16))
