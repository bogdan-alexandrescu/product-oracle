"""Google Identity-Aware Proxy (IAP) single sign-on.

Behind IAP every request carries ``x-goog-iap-jwt-assertion``, an ES256 JWT signed by
Google. It is verified here (signature against Google's published keys, issuer,
audience, expiry); the unsigned ``x-goog-authenticated-user-email`` header is never
read. A verified email maps to a user of the default tenant, created on first visit
when its domain is allowed: with the role of its open invite, else the company's
``iap_default_role`` setting (commenter when unset). Existing users keep their role.
"""

import asyncio
import logging
import secrets
import time
import uuid
from typing import Any

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from oracle.audit import record
from oracle.auth.models import User
from oracle.auth.service import hash_password
from oracle.config import get_settings
from oracle.members import service as members
from oracle.models import Tenant
from oracle.tenancy import tenant_session, unscoped_session

log = logging.getLogger(__name__)

ASSERTION_HEADER = "x-goog-iap-jwt-assertion"
ISSUER = "https://cloud.google.com/iap"
JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk"
LEEWAY_SECONDS = 30
_JWKS_TTL_SECONDS = 60 * 60
# An unknown kid triggers a refetch (Google rotated keys), at most this often.
_JWKS_MIN_REFRESH_SECONDS = 60


class InvalidAssertion(Exception):
    """The assertion is malformed, unsigned by Google, expired or for another audience."""


class KeysUnavailable(Exception):
    """Google's public keys could not be fetched and none are cached."""


async def _fetch_jwks() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=5) as client:
        resp = await client.get(JWKS_URL)
        resp.raise_for_status()
        return resp.json()


class _KeyCache:
    def __init__(self) -> None:
        self.keys: dict[str, jwt.PyJWK] = {}
        self.fetched_at = 0.0
        self._lock = asyncio.Lock()

    def clear(self) -> None:
        self.keys = {}
        self.fetched_at = 0.0

    async def get(self, kid: str) -> jwt.PyJWK | None:
        age = time.monotonic() - self.fetched_at
        stale = not self.keys or age > _JWKS_TTL_SECONDS
        if stale or (kid not in self.keys and age > _JWKS_MIN_REFRESH_SECONDS):
            await self._refresh(self.fetched_at)
        return self.keys.get(kid)

    async def _refresh(self, seen_fetched_at: float) -> None:
        async with self._lock:
            if self.fetched_at != seen_fetched_at:
                return  # another request refreshed while this one waited
            try:
                data = await _fetch_jwks()
                keys = {
                    k["kid"]: jwt.PyJWK(k, algorithm="ES256")
                    for k in data["keys"]
                    if k.get("alg", "ES256") == "ES256"
                }
            except Exception as e:
                log.warning("fetching IAP keys failed: %s", e)
                if not self.keys:
                    raise KeysUnavailable from e
                # Keep serving the cached keys; retry after the minimum interval.
                self.fetched_at = time.monotonic() - _JWKS_TTL_SECONDS + _JWKS_MIN_REFRESH_SECONDS
                return
            self.keys, self.fetched_at = keys, time.monotonic()


_keys = _KeyCache()


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


async def user_for_claims(claims: dict[str, Any]) -> User | None:
    """The default-tenant user for verified IAP claims, provisioned if allowed."""
    email = claims["email"].strip().lower()
    tenant_id = await _default_tenant_id()
    if tenant_id is None:
        log.warning("IAP sign-in for %s refused: no tenant yet (run the seed)", email)
        return None
    async with tenant_session(tenant_id) as s:
        user = await s.scalar(select(User).where(User.email == email))
        if user is not None:
            return user
        settings = get_settings()
        domain = email.rsplit("@", 1)[1]
        allowed = {d.strip().lower().lstrip("@") for d in settings.iap_allowed_domains}
        if not settings.iap_auto_provision or domain not in allowed:
            log.info("IAP sign-in for %s refused: unknown user, not provisioned", email)
            return None
        # An open invite for this email sets the role (and is accepted); otherwise the
        # company's iap_default_role setting does.
        invite = await members.claim_open_invite(s, email)
        role = invite.role if invite is not None else await members.iap_default_role(s)
        # No password sign-in for these users: the hash is of a secret nobody keeps.
        user = User(email=email, password_hash=hash_password(secrets.token_urlsafe(32)), role=role)
        s.add(user)
        try:
            await s.flush()
            from oracle.auth.deps import Principal

            principal = Principal(tenant_id=tenant_id, kind="user", role=user.role, user_id=user.id)
            data = {"via": "iap", "role": role}
            if invite is not None:
                data["invite_id"] = str(invite.id)
                await record(
                    s, principal, "invite.accept", "invite", invite.id, {"user_id": str(user.id)}
                )
            await record(s, principal, "provision", "user", user.id, data)
            await s.commit()
        except IntegrityError:
            # A concurrent request provisioned the same user first.
            await s.rollback()
            return await s.scalar(select(User).where(User.email == email))
        return user
