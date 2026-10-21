"""The code capability map boundary (S2, E1(3), CR-12).

A spec's engineering approach should be checked against what the code can already do.
:func:`capability_map` answers the latest ready code map of each repo that its source's
owner shared with the company (F5-2, :mod:`oracle.engineering.codemaps`), as one summary.
A private map is never used (S6). Without one it answers ``None``: specs say the map was
not available, label the approach as resting on assumptions, and require an Assumptions
section (§11.1: "when the indexer is not enabled, label assumptions clearly").
"""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class CapabilityMap:
    """What the code can do, as the prompt shows it."""

    summary: str
    as_of: str | None = None


async def capability_map(db: AsyncSession, *, product: str | None = None) -> CapabilityMap | None:
    """The shared code capability maps (every repo's latest ready one), or None while
    none is shared. ``product``: maps are per repo and Oracle does not tie repos to
    products yet, so every shared map counts."""
    from oracle.engineering import codemap, codemaps

    maps = [m for m in await codemaps.latest_shared(db) if m.content]
    if not maps:
        return None
    summary = "\n".join(codemap.summary(m.content or {}) for m in maps)
    dates = [m.as_of for m in maps if m.as_of is not None]
    return CapabilityMap(summary=summary, as_of=min(dates).isoformat() if dates else None)
