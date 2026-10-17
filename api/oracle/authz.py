"""Role checks: viewer < commenter < approver < owner.

    @router.post("/things")
    async def create_thing(principal: Annotated[Principal, Depends(require_role("approver"))]):
        ...

A principal passes when its role is at or above ``min_role``; otherwise 403.
"""

from collections.abc import Awaitable, Callable

from fastapi import HTTPException, status

from oracle.auth.deps import CurrentPrincipal, Principal
from oracle.auth.models import ROLES, Role

_RANK = {role: rank for rank, role in enumerate(ROLES)}


def has_role(role: str, min_role: Role) -> bool:
    """True when ``role`` is ``min_role`` or above. Unknown roles never pass."""
    rank = _RANK.get(role)
    return rank is not None and rank >= _RANK[min_role]


def require_role(min_role: Role) -> Callable[[Principal], Awaitable[Principal]]:
    """A FastAPI dependency that returns the principal, or raises 403 below ``min_role``."""
    if min_role not in _RANK:
        raise ValueError(f"unknown role {min_role!r}; expected one of {', '.join(ROLES)}")

    async def check_role(principal: CurrentPrincipal) -> Principal:
        if not has_role(principal.role, min_role):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires the {min_role} role")
        return principal

    return check_role
