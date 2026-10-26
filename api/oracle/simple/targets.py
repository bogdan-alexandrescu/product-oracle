"""Simple S3b (#723): non-versioned targets of the change engine (placeholder; see the
helper's brief)."""

from typing import Any

OPS: frozenset[str] = frozenset()


async def create(db, principal, body):  # pragma: no cover - placeholder
    raise NotImplementedError


async def decide(db, principal, c, action, reason):  # pragma: no cover - placeholder
    raise NotImplementedError


async def undo(db, principal, c):  # pragma: no cover - placeholder
    raise NotImplementedError


def may_decide(principal: Any, c, view) -> bool:  # pragma: no cover - placeholder
    return False
