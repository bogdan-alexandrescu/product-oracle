import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.models import AuditEvent

if TYPE_CHECKING:
    from oracle.auth.deps import Principal


# The actor of what Oracle does on its own account, never a person's (e.g. sending a
# refused draft back to the run's writer).
ORACLE = "oracle"


async def record(
    session: AsyncSession,
    principal: "Principal | str | None",
    action: str,
    entity: str,
    entity_id: uuid.UUID | None = None,
    data: dict[str, Any] | None = None,
) -> AuditEvent:
    """Add an audit event to the session (the caller commits). ``principal``: who acted,
    an actor string (:data:`ORACLE`), or None for ``"system"``."""
    if isinstance(principal, str):
        actor = principal
    else:
        actor = principal.actor if principal else "system"
    event = AuditEvent(
        actor=actor,
        action=action,
        entity=entity,
        entity_id=entity_id,
        data=data or {},
    )
    session.add(event)
    return event
