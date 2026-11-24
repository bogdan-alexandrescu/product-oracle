"""The stale rule (the owner, Nov 23): whether a change only raises the standing of the same
content. One that does makes no approved roadmap item stale (oracle.roadmap.staleness).

Judged where the change is written, from what the row held before and after, and recorded on
the change event as ``data["standing_only"]``: no later reader has to guess it from words."""

from typing import Any

# What joining the Ground Truth writes besides nothing of the content (proposed -> confirmed;
# a feature's code is its key, given when it joins).
JOIN_FIELDS = frozenset({"status", "key"})


def _raised(before: dict[str, Any], after: dict[str, Any], fields: frozenset[str]) -> bool:
    changed = {k for k in {*before, *after} if before.get(k) != after.get(k)}
    if not changed or not changed <= fields:
        return False
    return "status" not in changed or (before.get("status"), after.get("status")) == (
        "proposed",
        "confirmed",
    )


def entity_raised(before: dict[str, Any] | None, after: dict[str, Any]) -> bool:
    """A proposed entity confirmed, or a feature given its code, its content as it was. A
    rejected one confirmed again is restored: what its rejection changed changes back."""
    return _raised(before or {}, after, JOIN_FIELDS)


def edge_raised(before: dict[str, Any] | None, after: dict[str, Any]) -> bool:
    """A proposed link confirmed: the same two things, linked as they were proposed to be. One
    added, removed, rejected or given another weight is a change. Its evidence is kept apart
    from it and records no change of the link."""
    return _raised(before or {}, after, frozenset({"status"}))
