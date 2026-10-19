"""The code capability map boundary (S2, E1(3), CR-12).

A spec's engineering approach should be checked against what the code can already do.
The code capability map is the `v2-sources` lane's (wave 2) and does not exist on main
yet. Until it does, :func:`capability_map` answers ``None``: specs say the map was not
available, label the approach as resting on assumptions, and require an Assumptions
section (§11.1: "when the indexer is not enabled, label assumptions clearly").

When the map lands, this function returns its summary for the request's product and
features; nothing else in the specs lane changes.
"""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class CapabilityMap:
    """What the code can do, as the prompt shows it (the v2-sources lane fills this)."""

    summary: str
    as_of: str | None = None


async def capability_map(db: AsyncSession, *, product: str | None = None) -> CapabilityMap | None:
    """The code capability map for ``product``, or None while no indexer is enabled."""
    return None
