"""Optimistic concurrency for v2 rows people edit in place (no silent last-write-wins).

Every model with a ``lock_version`` column maps it as SQLAlchemy's ``version_id_col``:
each ORM UPDATE is ``... WHERE lock_version = <the value loaded>`` and bumps it, so a
concurrent writer's flush fails with ``StaleDataError`` instead of overwriting.

A write route takes the version the client last saw and checks it first::

    gap = await db.get(KnowledgeGap, gap_id)
    expect_version(gap, body.lock_version)  # 409 when the client is behind
    gap.status = body.status
    await flush_or_conflict(db)             # 409 when another writer won the race
"""

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError


class VersionConflict(HTTPException):
    def __init__(self, current: int | None = None) -> None:
        detail = "Someone else changed this since you loaded it; reload and try again"
        super().__init__(status.HTTP_409_CONFLICT, detail)
        self.current = current


def expect_version(row: Any, expected: int) -> None:
    """Raise :class:`VersionConflict` unless ``row.lock_version == expected``."""
    if row.lock_version != expected:
        raise VersionConflict(row.lock_version)


async def flush_or_conflict(db: AsyncSession) -> None:
    """Flush; a lost race (``StaleDataError``) becomes :class:`VersionConflict`."""
    try:
        await db.flush()
    except StaleDataError as e:
        raise VersionConflict() from e


__all__ = ["StaleDataError", "VersionConflict", "expect_version", "flush_or_conflict"]
