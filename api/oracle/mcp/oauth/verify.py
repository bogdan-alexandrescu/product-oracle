"""Access-token verification for ``/mcp`` (Lane D1 registers it as a verifier).

``verify_access_token`` turns a raw ``poa_...`` token into the principal of the user
who approved it, with the user's *current* role intersected with the granted scope,
or ``None`` for anything unknown, expired or revoked (the caller answers 401 with
:func:`www_authenticate`, so the client finds the authorization server).
"""

from datetime import UTC, datetime

from sqlalchemy import select

from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.auth.service import hash_token, issued_in_force, may_sign_in
from oracle.mcp.oauth.models import OAuthToken
from oracle.mcp.oauth.service import ACCESS_PREFIX, effective_role, issuer
from oracle.tenancy import unscoped_session

_SCHEME = "Bearer"


async def verify_access_token(raw: str) -> Principal | None:
    if not raw or not raw.startswith(ACCESS_PREFIX):
        return None
    # Runs before a tenant is known, like API-token lookups: the hash is globally unique.
    async with unscoped_session() as s:
        token = await s.scalar(select(OAuthToken).where(OAuthToken.access_hash == hash_token(raw)))
        if token is None or token.revoked_at is not None:
            return None
        if token.expires_at <= datetime.now(UTC):
            return None
        user = await s.get(User, token.user_id)
        if user is None or user.tenant_id != token.tenant_id or not may_sign_in(user):
            return None
        # Issued before a disable (a refresh its bulk revoke did not see): dead (C2).
        if not issued_in_force(user, token.created_at):
            return None
        return Principal(
            tenant_id=token.tenant_id,
            kind="user",
            role=effective_role(user.role, token.scope),
            user_id=user.id,
            # The grant: approvals made through it record it (C2).
            grant_id=token.family_id,
            issued_at=token.created_at,
        )


def www_authenticate(request_base_url: str, error: str | None = None) -> str:
    """The ``WWW-Authenticate`` value for a 401 from ``/mcp`` (RFC 9728 section 5.1)."""
    params = {
        "resource_metadata": f"{issuer(request_base_url)}/.well-known/oauth-protected-resource/mcp"
    }
    if error:
        params["error"] = error
    return _SCHEME + " " + ", ".join(f'{k}="{v}"' for k, v in params.items())
