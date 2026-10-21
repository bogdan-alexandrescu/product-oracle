"""Role checks: viewer < commenter < approver < owner.

    @router.post("/things")
    async def create_thing(principal: Annotated[Principal, Depends(require_role("approver"))]):
        ...

A principal passes when its role is at or above ``min_role``; otherwise 403.

A write that needs the role when it lands, not just when the request authenticated,
uses :func:`require_role_now` (or calls :func:`recheck_caller` itself): the role is
re-read under the review gate (C2: owner- and approver-level writes re-check the
caller like member routes).
"""

from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.auth.models import ROLES, Role

_RANK = {role: rank for rank, role in enumerate(ROLES)}


def has_role(role: str, min_role: Role) -> bool:
    """True when ``role`` is ``min_role`` or above. Unknown roles never pass."""
    rank = _RANK.get(role)
    return rank is not None and rank >= _RANK[min_role]


async def not_for_runs(principal: CurrentPrincipal) -> Principal:
    """A FastAPI dependency refusing a call made for a run (403): a run's agents never
    manage members, tokens or accounts. Run tokens also never see these operations as
    MCP tools (oracle.mcp.scopes); this is the REST layer's own check."""
    if principal.run_id is not None or principal.run_token_id is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "A run's agents cannot manage accounts")
    return principal


def require_role(min_role: Role) -> Callable[[Principal], Awaitable[Principal]]:
    """A FastAPI dependency that returns the principal, or raises 403 below ``min_role``."""
    if min_role not in _RANK:
        raise ValueError(f"unknown role {min_role!r}; expected one of {', '.join(ROLES)}")

    async def check_role(principal: CurrentPrincipal) -> Principal:
        if not has_role(principal.role, min_role):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires the {min_role} role")
        return principal

    return check_role


async def recheck_caller(
    session: AsyncSession, principal: Principal, min_role: Role, *, shared: bool = True
) -> None:
    """Take the review gate (shared unless the write needs it exclusively), then re-read
    the caller under it, or raise 403.

    A disable, a demotion and a token or grant revocation take the gate exclusively and
    commit before it is free. A request authenticates before it waits on the gate; this
    re-read keeps one that raced with such a change (an owner being disabled with a
    request in flight) from landing after it. The gate is held until the transaction
    ends, so the write commits before any later disable does."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    await publish.gate_lock(session, shared=shared)
    refusal = await caller_refusal(session, principal, min_role)
    if refusal is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, refusal)


def require_role_now(min_role: Role) -> Callable[..., Awaitable[Principal]]:
    """:func:`require_role`, then :func:`recheck_caller` (gate shared) on the request's
    session: for a write whose handler does not take the gate exclusively itself."""
    checked = Annotated[Principal, Depends(require_role(min_role))]

    async def check_role_now(principal: checked, db: TenantDB) -> Principal:
        await recheck_caller(db, principal, min_role)
        return principal

    return check_role_now
