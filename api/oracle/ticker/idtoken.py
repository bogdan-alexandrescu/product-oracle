"""Google ID tokens from the run ticker's service account (Cloud Scheduler's OIDC token).

An RS256 JWT signed by Google. Verified here against Google's published certs:
signature, issuer, audience (exactly ORACLE_TICKER_AUDIENCE, a single string), expiry,
a lifetime of at most an hour (what Google issues), and that it was minted for
ORACLE_TICKER_SERVICE_ACCOUNT (compared exactly) with a verified email. A valid token only lets
Cloud Scheduler call the tick; it never becomes a user or a token principal.
"""

from typing import Any

import httpx
import jwt

from oracle.auth.jwks import KeyCache

CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("accounts.google.com", "https://accounts.google.com")
LEEWAY_SECONDS = 30
# Google's ID tokens live an hour; a longer-lived one was not minted by Google.
MAX_LIFETIME_SECONDS = 3600


class InvalidIdToken(Exception):
    """Not a Google ID token from the ticker's service account for this audience."""


async def _fetch_certs() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=5) as client:
        resp = await client.get(CERTS_URL)
        resp.raise_for_status()
        return resp.json()


# A lambda, so a test that replaces _fetch_certs is seen.
_keys = KeyCache(lambda: _fetch_certs(), "RS256", "Google OAuth2")


async def verify_id_token(token: str, *, audience: str, email: str) -> dict[str, Any]:
    """The claims of a valid ID token, else ``InvalidIdToken``.

    ``oracle.auth.jwks.KeysUnavailable`` when Google's certs cannot be fetched.
    """
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError as e:
        raise InvalidIdToken(str(e)) from e
    if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
        raise InvalidIdToken("unexpected alg or kid")
    key = await _keys.get(header["kid"])
    if key is None:
        raise InvalidIdToken("unknown signing key")
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=audience,
            issuer=ISSUERS,
            leeway=LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "iss", "aud", "sub", "email"], "strict_aud": True},
        )
    except jwt.InvalidTokenError as e:
        raise InvalidIdToken(str(e)) from e
    # PyJWT has checked both are integers (or integral numbers).
    if int(claims["exp"]) - int(claims["iat"]) > MAX_LIFETIME_SECONDS + LEEWAY_SECONDS:
        raise InvalidIdToken("lifetime over an hour")
    # Exactly: service account emails are lower-case ASCII, and case folding would let a
    # look-alike (U+212A KELVIN SIGN lower-cases to "k") through.
    if not isinstance(claims["email"], str) or claims["email"] != email.strip():
        raise InvalidIdToken("another account")
    if claims.get("email_verified") is not True:
        raise InvalidIdToken("email not verified")
    return claims
