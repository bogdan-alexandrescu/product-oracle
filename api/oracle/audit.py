import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.models import AuditEvent

if TYPE_CHECKING:
    from oracle.auth.deps import Principal


async def record(
    session: AsyncSession,
    principal: "Principal | None",
    action: str,
    entity: str,
    entity_id: uuid.UUID | None = None,
    data: dict[str, Any] | None = None,
) -> AuditEvent:
    """Add an audit event to the session (the caller commits)."""
    event = AuditEvent(
        actor=principal.actor if principal else "system",
        action=action,
        entity=entity,
        entity_id=entity_id,
        data=data or {},
    )
    session.add(event)
    return event
