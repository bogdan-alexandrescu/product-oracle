"""Who is calling ``/mcp``: a small registry of bearer-token verifiers.

A verifier takes the raw bearer token and returns an :class:`McpCaller`, or ``None``
when the token is not one it knows (or is expired or revoked). Verifiers are tried in
registration order; the first caller wins. Built in: API tokens (``po_...``, act with
the token's role) and run tokens (``ort_...``, act for the run's creator, limited by
the token's scopes). Another credential plugs in with one line::

    from oracle.mcp.auth import register_verifier
    register_verifier(verify_oauth_access_token)

A caller carries the headers that authenticate the in-process REST call each tool
makes, so the REST endpoints run their own role checks; use :func:`user_caller` for a
credential that acts for a user.
"""

import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Literal

from oracle.auth import service
from oracle.auth.models import User
from oracle.config import get_settings
from oracle.runtokens import RUN_TOKEN_PREFIX, verify_run_token
from oracle.tenancy import tenant_session

# RFC 9728 metadata for this protected resource; served by the MCP OAuth lane.
RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource"


@dataclass(frozen=True)
class McpCaller:
    tenant_id: uuid.UUID
    # "token": an API token; "run": a run token; "user": a credential acting for a user.
    kind: Literal["token", "run", "user"]
    # Headers for the in-process REST call: the REST layer authenticates it again.
    credentials: Mapping[str, str] = field(repr=False)
    # Run-token scopes (oracle.runtokens.SCOPES) limiting which operations may run;
    # ``None`` = no limit beyond the REST role checks.
    scopes: frozenset[str] | None = None
    user_id: uuid.UUID | None = None
    token_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None


Verifier = Callable[[str], Awaitable[McpCaller | None]]

_verifiers: list[Verifier] = []


def register_verifier(fn: Verifier) -> Verifier:
    """Add a token verifier (idempotent). Usable as a decorator."""
    if fn not in _verifiers:
        _verifiers.append(fn)
    return fn


def unregister_verifier(fn: Verifier) -> None:
    if fn in _verifiers:
        _verifiers.remove(fn)


async def verify(raw: str) -> McpCaller | None:
    """The caller for a raw bearer token, ``None`` when no verifier accepts it."""
    if not raw:
        return None
    for fn in list(_verifiers):
        caller = await fn(raw)
        if caller is not None:
            return caller
    return None


def user_caller(
    user: User,
    *,
    kind: Literal["run", "user"] = "user",
    scopes: frozenset[str] | None = None,
    token_id: uuid.UUID | None = None,
    run_id: uuid.UUID | None = None,
) -> McpCaller:
    """A caller acting for ``user``: the REST call carries a session for that user."""
    cookie = f"{get_settings().session_cookie_name}={service.make_session_cookie(user)}"
    return McpCaller(
        tenant_id=user.tenant_id,
        kind=kind,
        credentials={"cookie": cookie},
        scopes=scopes,
        user_id=user.id,
        token_id=token_id,
        run_id=run_id,
    )


async def verify_api_token(raw: str) -> McpCaller | None:
    if not raw.startswith(service.TOKEN_PREFIX):
        return None
    token = await service.resolve_api_token(raw)
    if token is None:
        return None
    return McpCaller(
        tenant_id=token.tenant_id,
        kind="token",
        credentials={"authorization": f"Bearer {raw}"},
        # A token for a user acts as that user (the REST layer resolves it the same way).
        user_id=token.user_id,
        token_id=token.id,
    )


async def verify_oauth_access_token(raw: str) -> McpCaller | None:
    """An MCP client's OAuth access token (``poa_...``, Lane D2). The REST call carries
    the same token, so REST sees the approving user with their role capped by the
    granted scope (``oracle:read`` alone acts as a viewer)."""
    from oracle.mcp.oauth.service import ACCESS_PREFIX
    from oracle.mcp.oauth.verify import verify_access_token

    if not raw.startswith(ACCESS_PREFIX):
        return None
    principal = await verify_access_token(raw)
    if principal is None:
        return None
    return McpCaller(
        tenant_id=principal.tenant_id,
        kind="user",
        credentials={"authorization": f"Bearer {raw}"},
        user_id=principal.user_id,
    )


async def verify_run_token_caller(raw: str) -> McpCaller | None:
    if not raw.startswith(RUN_TOKEN_PREFIX):
        return None
    claims = await verify_run_token(raw)
    if claims is None:
        return None
    from oracle.runs.models import Run

    async with tenant_session(claims.tenant_id) as s:
        run = await s.get(Run, claims.run_id)
        user = await s.get(User, run.created_by) if run and run.created_by else None
    # A run nobody started (or whose creator is gone) has no one to act for.
    if user is None:
        return None
    return user_caller(
        user, kind="run", scopes=claims.scopes, token_id=claims.token_id, run_id=claims.run_id
    )


register_verifier(verify_api_token)
register_verifier(verify_run_token_caller)
register_verifier(verify_oauth_access_token)
