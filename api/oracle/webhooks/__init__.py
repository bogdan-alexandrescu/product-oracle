"""Outbound webhooks (I1): Oracle tells a company's other tools when a run, a draft or an
approval changes. Events are captured in the transaction of the change
(:func:`oracle.webhooks.service.capture`), from the registry in :mod:`oracle.webhooks.events`.
"""

from typing import Any


async def capture(db: Any, event_type: str, actor: Any, **subject: Any) -> Any:
    """:func:`oracle.webhooks.service.capture`, importable from anywhere without a cycle."""
    from oracle.webhooks import service

    return await service.capture(db, event_type, actor, **subject)
