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
    """Add an audit event to the session (the caller commits). The actor's API token
    is recorded too (``actor_token_id``, C2), also when it acts for a user, and so is
    the MCP OAuth grant it came through (``actor_grant_id``)."""
    event = AuditEvent(
        actor=principal.actor if principal else "system",
        actor_token_id=principal.token_id if principal else None,
        actor_grant_id=principal.grant_id if principal else None,
        action=action,
        entity=entity,
        entity_id=entity_id,
        data=data or {},
    )
    session.add(event)
    return event
