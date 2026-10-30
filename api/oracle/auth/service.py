"""Passwords (argon2), API tokens (sha256 of a random secret) and session cookies."""

import asyncio
import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from itsdangerous import BadData, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import ApiToken, Role, User
from oracle.config import get_settings
from oracle.tenancy import unscoped_session

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

TOKEN_PREFIX = "po_"
# A new password (My account) is at least this long; sign-in accepts any old one.
PASSWORD_MIN_LENGTH = 12
_hasher = PasswordHasher()

# Domains no real person signs in from (RFC 2606, RFC 6761): example.com/.org/.net and
# anything under them, and the .example, .test, .invalid and .localhost names.
RESERVED_EMAIL_DOMAINS = ("example.com", "example.org", "example.net")
RESERVED_EMAIL_TLDS = ("example", "test", "invalid", "localhost")
# Invisible characters a domain may hide (zero-width spaces and joiners, the BOM, soft
# hyphen): IDNA drops or refuses them, a naive comparison would not.
_INVISIBLE = dict.fromkeys(map(ord, "\u00ad\u200b\u200c\u200d\u2060\ufeff"))


def _email_domain(email: str) -> str:
    """The domain of ``email`` as DNS sees it: NFKC (full-width letters and dots become
    ASCII), invisible characters dropped, lower case, each label IDNA-encoded (so a
    Unicode look-alike is compared by its punycode, never by its letters)."""
    import unicodedata

    domain = unicodedata.normalize("NFKC", email.strip()).rsplit("@", 1)[-1]
    domain = domain.translate(_INVISIBLE).lower()
    # NFKC folds the ideographic and full-width full stops into ".", not this one.
    domain = domain.replace("\uff61", ".").replace("\u3002", ".").strip(".")
    labels = []
    for label in domain.split("."):
        try:
            labels.append(label.encode("idna").decode("ascii") if label else label)
        except UnicodeError:
            labels.append(label)
    return ".".join(labels)


class ReservedEmailError(ValueError):
    """An email at a reserved example domain, outside the mock/test build."""


def reserved_email(email: str) -> bool:
    """Whether ``email`` is at a reserved example domain."""
    domain = _email_domain(email)
    if any(domain == d or domain.endswith("." + d) for d in RESERVED_EMAIL_DOMAINS):
        return True
    return domain.rsplit(".", 1)[-1] in RESERVED_EMAIL_TLDS


def check_email_allowed(email: str) -> None:
    """Refuse a new user or invite at a reserved example domain unless the build allows
    them (``allow_reserved_email_domains``: tests and the mock). Existing members are
    never checked: this guards creation only."""
    if reserved_email(email) and not get_settings().allow_reserved_email_domains:
        domain = _email_domain(email)
        raise ReservedEmailError(
            f"{domain} is a reserved example domain; use the person's real email address"
        )


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


# argon2 is slow and CPU-bound by design: off the event loop, every other request waits
# on none of it.
async def hash_password_async(password: str) -> str:
    return await asyncio.to_thread(hash_password, password)


async def verify_password_async(password_hash: str, password: str) -> bool:
    return await asyncio.to_thread(verify_password, password_hash, password)


def hash_token(raw: str) -> str:
    # Tokens are 256-bit random secrets, so a fast hash is enough (no brute force).
    return hashlib.sha256(raw.encode()).hexdigest()


async def create_user(session: AsyncSession, email: str, password: str) -> User:
    check_email_allowed(email)
    password_hash = await hash_password_async(password)
    user = User(email=email.strip().lower(), password_hash=password_hash, role="owner")
    session.add(user)
    await session.flush()
    return user


async def create_api_token(
    session: AsyncSession,
    name: str,
    *,
    user_id: uuid.UUID | None = None,
    scope: str | None = None,
    expires_at: datetime | None = None,
) -> tuple[ApiToken, str]:
    """Create a token in the session's tenant. Returns (row, raw token); show raw once.

    With ``user_id`` the token acts as that user (their role and their own data), capped
    by ``scope`` when given (``oracle:read`` alone acts as a viewer); it stops working at
    ``expires_at`` when given.
    """
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    token = ApiToken(
        name=name, token_hash=hash_token(raw), user_id=user_id, scope=scope, expires_at=expires_at
    )
    session.add(token)
    await session.flush()
    return token, raw


def token_read_only(scope: str | None) -> bool:
    """Whether a token with this scope may only read: anything but ``oracle:write``
    present, an empty or unknown scope included (fail closed). ``None`` (a service token,
    or a personal token made before scopes existed) is not capped."""
    return scope is not None and "oracle:write" not in scope.split()


def token_role(user_role: str, scope: str | None) -> Role:
    """The role a token for a user acts with: the user's role, capped by the token's
    scope as for MCP clients (no ``oracle:write``: viewer). No scope: the user's role."""
    return "viewer" if token_read_only(scope) else user_role  # type: ignore[return-value]


def token_expired(expires_at: datetime | None, now: datetime | None = None) -> bool:
    """Whether a personal token with this expiry has expired (None: never expires)."""
    return expires_at is not None and expires_at <= (now or datetime.now(UTC))


def may_sign_in(user: User | None) -> bool:
    """Whether ``user`` may sign in on any path: it exists and is not disabled (C2)."""
    return user is not None and user.disabled_at is None


class RemovedMemberError(Exception):
    """A removed (disabled) member signed in with their right password (qa-settings-42):
    the refusal says so, in words, naming who to ask."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


async def _authenticate(email: str, password: str) -> tuple[User | None, User | None]:
    """(the active member the password signs in, the removed member it is right for). The
    second only when the email has no active member: a removed member's password is checked
    in place of the dummy one, so a wrong password takes as long as for an unknown email."""
    # Runs before a tenant is known, hence unscoped.
    async with unscoped_session() as s:
        users = (await s.scalars(select(User).where(User.email == email.strip().lower()))).all()
    active = [u for u in users if may_sign_in(u)]
    for user in active:
        # A disabled member's password no longer signs in; the same email may be an
        # active member of another company, so a disabled row never ends the search.
        if await verify_password_async(user.password_hash, password):
            return user, None
    if active:
        return None, None
    removed = [u for u in users if not may_sign_in(u)]
    for user in removed:
        if await verify_password_async(user.password_hash, password):
            return None, user
    # Equalise timing when the email is unknown.
    if not removed:
        await verify_password_async(_DUMMY_HASH, password)
    return None, None


async def authenticate_user(email: str, password: str) -> User | None:
    return (await _authenticate(email, password))[0]


async def _removed_message(removed: User) -> str:
    """Who a removed member asks: the owner who removed them while still an active member,
    else any owner (the same words as /access's "removed")."""
    from oracle.members.names import display_name
    from oracle.tenancy import tenant_session

    who = "an owner"
    if removed.disabled_by is not None:
        async with tenant_session(removed.tenant_id) as s:
            by = await s.get(User, removed.disabled_by)
            if by is not None and may_sign_in(by):
                who = display_name(by.email, by.name)
    return f"An owner removed you from this Oracle. Ask {who} to restore you."


async def sign_in(email: str, password: str) -> tuple[User, str] | None:
    """Check a password sign-in and stamp its session cookie, or ``None``.

    The cookie is stamped with the member's row locked (``FOR NO KEY UPDATE``) and the
    password re-checked against the hash read under that lock: a password change (or a
    sign-out everywhere) locks the row too and reads its time after the lock, so a
    session signed in with the old password while a change commits is always older than
    the change's ``sessions_valid_after`` and never survives it. Records the sign-in. A
    removed member who gives the right password raises ``RemovedMemberError`` (qa-settings-42)."""
    from oracle.audit import record
    from oracle.auth.deps import Principal
    from oracle.tenancy import tenant_session

    found, removed = await _authenticate(email, password)
    if removed is not None:
        raise RemovedMemberError(await _removed_message(removed))
    if found is None:
        return None
    async with tenant_session(found.tenant_id) as s:
        user = await s.scalar(
            select(User).where(User.id == found.id).with_for_update(key_share=True)
        )
        if not may_sign_in(user) or (
            user.password_hash != found.password_hash
            and not await verify_password_async(user.password_hash, password)
        ):
            return None
        cookie = make_session_cookie(user)
        user.last_sign_in_at = datetime.now(UTC)
        principal = Principal(
            tenant_id=user.tenant_id, kind="user", role=user.role, user_id=user.id
        )
        await record(s, principal, "login", "user", user.id)
        await s.commit()
        return user, cookie


async def resolve_api_token(raw: str) -> ApiToken | None:
    """Look up an active token by its raw value and record its use."""
    async with unscoped_session() as s:
        token = await s.scalar(select(ApiToken).where(ApiToken.token_hash == hash_token(raw)))
        if token is None or token.revoked_at is not None or token_expired(token.expires_at):
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
    except (BadData, KeyError, ValueError, TypeError, AttributeError):
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
    except (BadData, KeyError, ValueError, TypeError, OverflowError):
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
                select(
                    ApiToken.revoked_at, ApiToken.role, ApiToken.scope, ApiToken.expires_at
                ).where(ApiToken.id == principal.token_id)
            )
        ).first()
        if row is None or row.revoked_at is not None:
            return "This API token was revoked"
        if token_expired(row.expires_at):
            return "This API token has expired"
        if principal.user_id is None and not has_role(row.role, role):
            return f"Requires the {role} role"
        if principal.user_id is not None and not has_role(token_role("owner", row.scope), role):
            return f"Requires the {role} role (this token is read-only)"
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
