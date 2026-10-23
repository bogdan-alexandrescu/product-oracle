"""Google Identity-Aware Proxy (IAP) single sign-on.

Behind IAP every request carries ``x-goog-iap-jwt-assertion``, an ES256 JWT signed by
Google. It is verified here (signature against Google's published keys, issuer,
audience, expiry); the unsigned ``x-goog-authenticated-user-email`` header is never
read. A verified email maps to a user of the default tenant, created on first visit
when its domain is allowed: with the role of its open invite, else the company's
``iap_default_role`` setting (commenter when unset). Existing users keep their role; a
disabled member is refused (and never provisioned again: their row keeps the email).
"""

import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.audit import record
from oracle.auth.jwks import KeyCache
from oracle.auth.models import User
from oracle.auth.service import hash_password_async, reserved_email
from oracle.config import get_settings
from oracle.members import access
from oracle.members import service as members
from oracle.models import Tenant
from oracle.tenancy import tenant_session, unscoped_session

log = logging.getLogger(__name__)

ASSERTION_HEADER = "x-goog-iap-jwt-assertion"
ISSUER = "https://cloud.google.com/iap"
JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk"
LEEWAY_SECONDS = 30


class InvalidAssertion(Exception):
    """The assertion is malformed, unsigned by Google, expired or for another audience."""


async def _fetch_jwks() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=5) as client:
        resp = await client.get(JWKS_URL)
        resp.raise_for_status()
        return resp.json()


# A lambda, so a test that replaces _fetch_jwks is seen.
# A short back-off: while it lasts every IAP sign-in is a 503, so one failed fetch on a
# cold instance must not refuse people for long.
_keys = KeyCache(lambda: _fetch_jwks(), "ES256", "IAP", backoff_seconds=5)


async def verify_assertion(assertion: str, audiences: list[str]) -> dict[str, Any]:
    """Return the claims of a valid IAP assertion, else raise ``InvalidAssertion``."""
    try:
        header = jwt.get_unverified_header(assertion)
    except jwt.InvalidTokenError as e:
        raise InvalidAssertion(str(e)) from e
    if header.get("alg") != "ES256" or not isinstance(header.get("kid"), str):
        raise InvalidAssertion("unexpected alg or kid")
    key = await _keys.get(header["kid"])
    if key is None:
        raise InvalidAssertion("unknown signing key")
    try:
        claims = jwt.decode(
            assertion,
            key,
            algorithms=["ES256"],
            audience=audiences,
            issuer=ISSUER,
            leeway=LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "iss", "aud", "sub", "email"]},
        )
    except jwt.InvalidTokenError as e:
        raise InvalidAssertion(str(e)) from e
    if not isinstance(claims.get("email"), str) or "@" not in claims["email"]:
        raise InvalidAssertion("no email claim")
    return claims


async def _default_tenant_id() -> uuid.UUID | None:
    async with unscoped_session() as s:
        return await s.scalar(select(Tenant.id).order_by(Tenant.created_at).limit(1))


# Every request through IAP carries the assertion: a sign-in is recorded at most this often.
SIGN_IN_RESOLUTION = timedelta(minutes=10)


async def _signed_in(session: AsyncSession, user: User) -> None:
    """Record a Google sign-in as the member's last sign-in (members list, My account)."""
    now = datetime.now(UTC)
    if user.last_sign_in_at is None or now - user.last_sign_in_at >= SIGN_IN_RESOLUTION:
        user.last_sign_in_at = now
        await session.commit()


async def user_for_claims(claims: dict[str, Any]) -> User | None:
    """The default-tenant user for verified IAP claims, provisioned if allowed."""
    result = await sign_in(claims)
    return result if isinstance(result, User) else None


async def sign_in(claims: dict[str, Any]) -> "User | access.Refused":
    """Who verified IAP claims sign in as, or why nobody (A5), in this order: a member
    (removed: refused); new sign-ins off (``invite_only``); a domain outside the company's
    (``outside_domains``); an open unexpired invite (claimed: its role and name); an
    expired one (``invite_expired``); then the ``sign_in_without_invite`` rule: ``join``
    (the default role), ``refuse`` (``invite_only``) or ``request`` (a pending access
    request, ``pending``; a declined one stays ``declined``)."""
    email = claims["email"].strip().lower()
    tenant_id = await _default_tenant_id()
    if tenant_id is None:
        log.warning("IAP sign-in for %s refused: no tenant yet (run the seed)", email)
        return access.Refused("invite_only")
    async with tenant_session(tenant_id) as s:
        user = await s.scalar(select(User).where(User.email == email))
        if user is not None:
            # A disabled member keeps their row, so their email is never provisioned
            # again: refused until an owner restores them.
            if user.disabled_at is not None:
                log.info("IAP sign-in for %s refused: the member is disabled", email)
                return access.Refused("removed")
            await _signed_in(s, user)
            return user
        settings = get_settings()
        domain = email.rsplit("@", 1)[1]
        if not settings.iap_auto_provision:
            log.info("IAP sign-in for %s refused: new sign-ins are off", email)
            return access.Refused("invite_only")
        if domain not in await access.sign_in_domains(s):
            log.info("IAP sign-in for %s refused: outside the company's domains", email)
            return access.Refused("outside_domains")
        if reserved_email(email) and not settings.allow_reserved_email_domains:
            log.info("IAP sign-in for %s refused: a reserved example domain", email)
            return access.Refused("outside_domains")
        # An open, unexpired invite for this email sets the role and the name (and is
        # accepted); otherwise the company's rule decides.
        invite = await members.claim_open_invite(s, email)
        if invite is None:
            rule = await access.sign_in_rule(s)
            if rule != "join" and await members.expired_invite(s, email) is not None:
                return access.Refused("invite_expired")
            if rule == "refuse":
                return access.Refused("invite_only")
            if rule == "request":
                latest = await access._latest_request(s, email)
                if latest is not None and latest.status == "declined":
                    return access.Refused("declined")
                await access.touch_request(s, email)
                return access.Refused("pending")
        role = invite.role if invite is not None else await members.iap_default_role(s)
        # No password sign-in for these users: the hash is of a secret nobody keeps.
        user = User(
            email=email,
            name=invite.name if invite is not None else None,
            password_hash=await hash_password_async(secrets.token_urlsafe(32)),
            role=role,
            # A3: an invite naming them engineering lead (never with role viewer).
            engineering_lead=invite is not None and invite.engineering_lead,
            password_sign_in=False,
            last_sign_in_at=datetime.now(UTC),
        )
        s.add(user)
        try:
            await s.flush()
            from oracle.auth.deps import Principal

            principal = Principal(tenant_id=tenant_id, kind="user", role=user.role, user_id=user.id)
            via = "access_request" if invite is not None and invite.access_request_id else "iap"
            data: dict[str, Any] = {"via": via, "role": role}
            if user.engineering_lead:
                data["engineering_lead"] = True
            if invite is not None:
                data["invite_id"] = str(invite.id)
                await record(
                    s, principal, "invite.accept", "invite", invite.id, {"user_id": str(user.id)}
                )
            await record(s, principal, "provision", "user", user.id, data)
            # They are a member now: a request they had waiting is closed.
            await access.close_pending(s, email)
            await s.commit()
        except IntegrityError:
            # A concurrent request provisioned the same user first.
            await s.rollback()
            existing = await s.scalar(select(User).where(User.email == email))
            return existing if existing is not None else access.Refused("pending")
        return user


async def access_state(claims: dict[str, Any]) -> tuple[str, str | None, dict[str, Any]]:
    """(state, company name, details) for verified claims, creating nothing."""
    email = claims["email"].strip().lower()
    tenant_id = await _default_tenant_id()
    if tenant_id is None:
        return "invite_only", None, {}
    async with tenant_session(tenant_id) as s:
        company = await s.scalar(select(Tenant.name).where(Tenant.id == tenant_id))
        state, details = await access.state_for(s, email)
        return state, company, details
